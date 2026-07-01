// ─────────────────────────────────────────────────────────────────────────────
// Resolve — the per-CARD analysis scout. Where Huginn (discovery.ts) surveys the
// whole repo into a brief and Muninn (meeting.ts) reads a transcript into ajustes,
// Resolve takes ONE card (title + body) and a read-only checkout and produces the
// "visão do Brokk pra resolução": HOW to solve it and WHERE in the code it lands.
//
// It greps/reads the real repo (read-only bash) to pin concrete files, then submits
// a structured resolution plan: approach + steps (each with `touches` = files/areas)
// + acceptance + clarify QUESTIONS (the human-handoff seam) + mode (atomic|feature).
// `mode` drives approval: atomic → enrich+queue the card; feature → expand into the
// plan's sub-cards. Reuses @brokk/afl + the shared read-only bash hand, like Huginn.
// ─────────────────────────────────────────────────────────────────────────────

import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { AflConfig } from "@brokk/afl";
import { resolveModel, shellEnv, streamAssistant } from "@brokk/afl";
import type { ChatTurnMessage, ContentBlock, ToolDef, ToolResultBlock, ToolUseBlock } from "@brokk/afl";

const execAsync = promisify(exec);
const MAX_OUT = 40_000;

export interface ResolveStep {
  title: string;
  /** Files/areas this step touches — e.g. "lib/mockup-3d/handoff-server.ts". */
  touches: string[];
  /** What to do, concretely. */
  detail: string;
  /** How to know the step is done. */
  acceptance: string;
}

/** The resolution plan Resolve emits for one card. */
export interface ResolveAnalysis {
  approach: string;
  rationale: string;
  /** atomic = one card/one PR; feature = break into the steps as sub-cards (DAG). */
  mode: "atomic" | "feature";
  steps: ResolveStep[];
  /** Open questions for the human — the handoff. Empty when the plan is confident. */
  questions: string[];
}

export interface RunResolveInput {
  cfg: AflConfig;
  /** Read-only checkout of the project repo. */
  cwd: string;
  repoFullName: string;
  card: { title: string; body: string };
  /** Prior human answers to earlier questions, to refine the plan on a re-run. */
  answers?: string;
  /** Default sonnet — this is a reasoning task (where + how), not a cheap scan. */
  model?: string;
  maxRounds?: number;
  signal?: AbortSignal;
  onProgress?: (note: string) => void;
}

const SUBMIT_TOOL: ToolDef = {
  name: "submit_analysis",
  description:
    "Entrega o plano de resolução final do card. Chame EXATAMENTE UMA VEZ, depois de explorar o repo o suficiente pra apontar arquivos concretos.",
  input_schema: {
    type: "object",
    properties: {
      approach: { type: "string", description: "1-3 frases: como resolver o card, a estratégia." },
      rationale: { type: "string", description: "Por que essa abordagem — o que no código justifica." },
      mode: { type: "string", enum: ["atomic", "feature"], description: "atomic=1 card/1 PR (mudança pequena/localizada); feature=quebrar em vários passos/sub-cards." },
      steps: {
        type: "array",
        description: "Passos concretos de implementação, em ordem.",
        items: {
          type: "object",
          properties: {
            title: { type: "string", description: "Título curto do passo." },
            touches: { type: "array", items: { type: "string" }, description: "Arquivos/áreas REAIS que este passo toca (caminhos vistos no checkout)." },
            detail: { type: "string", description: "O que fazer, concreto." },
            acceptance: { type: "string", description: "Como saber que ficou pronto." },
          },
          required: ["title", "touches", "detail", "acceptance"],
        },
      },
      questions: { type: "array", items: { type: "string" }, description: "Dúvidas pro humano (handoff). Vazio se o plano está seguro." },
    },
    required: ["approach", "rationale", "mode", "steps", "questions"],
  },
};

const BASH_TOOL: ToolDef = {
  name: "bash",
  description:
    "Roda um comando shell READ-ONLY na raiz do repo pra explorar: cat, ls, find, grep/rg, head, git log. Retorna stdout+stderr. NÃO modifique, escreva ou faça push.",
  input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
};

const SYSTEM = `Você é Resolve, o analista de resolução do Brokk. Recebe UM card (uma tarefa) e um checkout read-only do repositório. Sua missão: descobrir COMO resolver o card e ONDE no código isso acontece, e devolver um plano de resolução concreto.

Como explorar (seja EFICIENTE — ~10-15 comandos bastam):
- Leia o título e o corpo do card com atenção.
- Use grep/rg e find pra localizar os arquivos/símbolos relevantes ao que o card pede (features, componentes, rotas, libs).
- Abra os arquivos-chave (head/cat) o suficiente pra confirmar ONDE a mudança entra. Cite caminhos REAIS que você viu.
- Não leia o repo inteiro — assim que entender onde mexer, conclua.

Depois chame submit_analysis com:
- approach + rationale: a estratégia e o porquê, ancorados no código real.
- mode: atomic se é mudança pequena/localizada (1 PR); feature se precisa quebrar em vários passos.
- steps: passos concretos, cada um com \`touches\` = arquivos REAIS (que você viu no checkout), detail e acceptance.
- questions: dúvidas pro humano SÓ quando algo é genuinamente ambíguo e muda a solução (decisão de produto, comportamento esperado, dado que falta). Se está claro, deixe vazio — não invente dúvidas.

Regras: read-only, nunca escreva/commite. Seja específico e ancorado no que você REALMENTE viu. Chame submit_analysis exatamente uma vez.`;

function clip(s: string): string {
  return s.length > MAX_OUT ? `${s.slice(0, MAX_OUT)}\n…[truncado ${s.length - MAX_OUT} chars]` : s;
}

async function runBash(cwd: string, command: string, signal?: AbortSignal): Promise<string> {
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd,
      timeout: 60_000,
      maxBuffer: 1024 * 1024 * 16,
      env: shellEnv({ gh: false }),
      signal,
    });
    return clip(`${stdout}${stderr ? `\n${stderr}` : ""}`.trim() || "(sem saída)");
  } catch (e: any) {
    const out = `${e?.stdout ?? ""}\n${e?.stderr ?? ""}`.trim();
    return clip(`exit ${e?.code ?? "?"}\n${out || e?.message || String(e)}`);
  }
}

function coerce(input: Record<string, unknown>): ResolveAnalysis {
  const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
  const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(str).filter(Boolean).slice(0, 30) : []);
  const steps: ResolveStep[] = Array.isArray(input.steps)
    ? (input.steps as Record<string, unknown>[])
        .map((s) => ({ title: str(s.title), touches: list(s.touches), detail: str(s.detail), acceptance: str(s.acceptance) }))
        .filter((s) => s.title || s.detail)
        .slice(0, 20)
    : [];
  return {
    approach: str(input.approach),
    rationale: str(input.rationale),
    mode: input.mode === "feature" ? "feature" : "atomic",
    steps,
    questions: list(input.questions),
  };
}

/** Analyze one card against a read-only checkout → a concrete resolution plan.
 *  Throws if the model never submits one within maxRounds. */
export async function runResolve(input: RunResolveInput): Promise<ResolveAnalysis> {
  const { cfg, cwd, repoFullName, card, answers, signal, onProgress } = input;
  const model = resolveModel(cfg, input.model ?? "sonnet");
  const maxRounds = input.maxRounds ?? 20;
  const tools = [BASH_TOOL, SUBMIT_TOOL];

  const prompt =
    `Repositório: ${repoFullName}.\n\nCARD\nTítulo: ${card.title}\nDescrição: ${card.body || "(sem descrição)"}` +
    (answers ? `\n\nRESPOSTAS DO HUMANO a dúvidas anteriores (incorpore ao plano):\n${answers}` : "") +
    `\n\nExplore o checkout e submeta o plano de resolução.`;

  const messages: ChatTurnMessage[] = [{ role: "user", content: [{ type: "text", text: prompt }] }];

  for (let round = 0; round < maxRounds; round++) {
    if (signal?.aborted) throw new Error("resolve aborted");
    onProgress?.(`round ${round}`);
    const result = await streamAssistant(cfg, { model, system: SYSTEM, messages, tools, maxTokens: 6000 }, () => {}, signal);
    messages.push({ role: "assistant", content: result.blocks });

    const toolUses = result.blocks.filter((b): b is ToolUseBlock => b.type === "tool_use");
    const submit = toolUses.find((t) => t.name === "submit_analysis");
    if (submit) {
      onProgress?.("analysis submitted");
      return coerce(submit.input as Record<string, unknown>);
    }
    if (result.stopReason !== "tool_use" || toolUses.length === 0) {
      messages.push({ role: "user", content: [{ type: "text", text: "Continue explorando com bash, depois chame submit_analysis." }] });
      continue;
    }
    const blocks: ToolResultBlock[] = [];
    for (const tu of toolUses) {
      onProgress?.(`bash: ${String((tu.input as { command?: string }).command ?? "").slice(0, 80)}`);
      const out = tu.name === "bash" ? await runBash(cwd, String((tu.input as { command?: string }).command ?? ""), signal) : `unknown tool: ${tu.name}`;
      blocks.push({ type: "tool_result", tool_use_id: tu.id, content: out, is_error: false });
    }
    messages.push({ role: "user", content: blocks as ContentBlock[] });
  }

  // Budget spent — force a conclusion from what was seen.
  if (signal?.aborted) throw new Error("resolve aborted");
  onProgress?.("forcing conclusion");
  messages.push({ role: "user", content: [{ type: "text", text: "Você explorou o suficiente. Submeta o plano AGORA com submit_analysis, com base no que já viu. Não rode mais comandos." }] });
  const final = await streamAssistant(
    cfg,
    { model, system: SYSTEM, messages, tools, maxTokens: 6000, toolChoice: { type: "tool", name: "submit_analysis" } },
    () => {},
    signal,
  );
  const forced = final.blocks.find((b): b is ToolUseBlock => b.type === "tool_use" && b.name === "submit_analysis");
  if (forced) return coerce(forced.input as Record<string, unknown>);
  throw new Error(`resolve did not converge within ${maxRounds} rounds`);
}
