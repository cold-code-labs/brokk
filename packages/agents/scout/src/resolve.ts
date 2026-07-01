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

/** A verbatim excerpt grounding the card — curated (never invented) from the origin
 *  evidence + human details Resolve was given. Mirrors @brokk/core AnalysisEvidence. */
export interface ResolveEvidence {
  quote: string;
  speaker?: string | null;
  note?: string | null;
}

/** The full versioned "understanding" Resolve emits for one card: the corrected
 *  PROBLEM (revisedTitle + cited evidence + plain-language details) AND the PLAN. */
export interface ResolveAnalysis {
  /** A corrected, faithful title when the card's own is misleading; null = keep it. */
  revisedTitle: string | null;
  /** Plain-language restatement of what's actually wrong (for anyone to grasp). */
  details: string;
  /** Verbatim excerpts grounding the card — curated from what Resolve was given. */
  evidence: ResolveEvidence[];
  approach: string;
  rationale: string;
  /** atomic = one card/one PR; feature = break into the steps as sub-cards (DAG). */
  mode: "atomic" | "feature";
  steps: ResolveStep[];
  /** Open questions for the human — the handoff. Empty when the plan is confident. */
  questions: string[];
}

/** The prior version, passed on a refine so Resolve improves it instead of starting
 *  cold — and so it can compare against the human's new details. */
export interface ResolvePrior {
  version: number;
  title: string | null;
  details: string | null;
  approach: string | null;
}

export interface RunResolveInput {
  cfg: AflConfig;
  /** Read-only checkout of the project repo. */
  cwd: string;
  repoFullName: string;
  card: { title: string; body: string };
  /** Origin evidence (Muninn's verbatim meeting excerpts) to cite from — Resolve
   *  curates these into `evidence`; it must NOT invent quotes beyond what it's given. */
  evidence?: ResolveEvidence[];
  /** Prior human answers to earlier questions, to refine the plan on a re-run. */
  answers?: string;
  /** Human "Adicionar Detalhes" — NEW, authoritative information about the problem
   *  that can correct the card's framing (title/details) on a refine. */
  details?: string;
  /** The prior version, on a refine — what to improve on. */
  prior?: ResolvePrior;
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
      revised_title: { type: "string", description: "Título corrigido e fiel quando o título do card engana/está incompleto (ex.: mistura mouse e trackpad). Vazio/omitido = manter o título atual." },
      details: { type: "string", description: "O PROBLEMA em linguagem simples: o que de fato está errado, pra qualquer pessoa (inclusive não-técnica) entender. Diferente do approach (que é a solução)." },
      evidence: {
        type: "array",
        description: "Citações VERBATIM que embasam o card — CURADAS do que você recebeu (evidência da reunião + detalhes do humano). NUNCA invente aspas além do que foi dado.",
        items: {
          type: "object",
          properties: {
            quote: { type: "string", description: "As palavras exatas, como ditas/escritas." },
            speaker: { type: "string", description: "Quem falou, se souber." },
            note: { type: "string", description: "Por que esse trecho importa — uma linha." },
          },
          required: ["quote"],
        },
      },
      approach: { type: "string", description: "1-3 frases: como resolver o card, a estratégia." },
      rationale: { type: "string", description: "Por que essa abordagem — o que no código justifica. Separe o que VERIFICOU no código do que está ASSUMINDO do runtime." },
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
      questions: { type: "array", items: { type: "string" }, description: "Dúvidas pro humano (handoff): premissas de comportamento de runtime que você NÃO confirmou no código / que o código contradiz, ou ambiguidade que muda a solução. Vazio SÓ se tudo é confirmável estaticamente." },
    },
    required: ["details", "evidence", "approach", "rationale", "mode", "steps", "questions"],
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
- Leia o título e o corpo do card com atenção — inclusive o contexto (reunião, quem pediu). O corpo é o que um HUMANO afirmou; pode estar incompleto ou impreciso.
- Use grep/rg e find pra localizar os arquivos/símbolos relevantes ao que o card pede (features, componentes, rotas, libs).
- Abra os arquivos-chave (head/cat) o suficiente pra confirmar ONDE a mudança entra. Cite caminhos REAIS que você viu.
- Não leia o repo inteiro — assim que entender onde mexer, conclua.

Julgue a PREMISSA, não só o código (crítico):
- Você lê código ESTÁTICO — NÃO roda o app. Não observa runtime: o que aparece na tela, mouse × trackpad × toque, o que some/aparece, timing, foco.
- O card descreve um sintoma que alguém AFIRMOU ("X não funciona", "quebra com Y", "só funciona em parte"). Trate como HIPÓTESE, não fato. Sempre separe o que você VERIFICOU no código do que está ASSUMINDO do runtime — e deixe isso claro no rationale.
- Se o card afirma um comportamento de runtime que você (a) não consegue confirmar no código, ou (b) o código parece CONTRADIZER, NÃO resolva como se a premissa fosse verdade — vire DÚVIDA. Casos típicos: comportamento nativo do browser (um container overflow-x rola nativo com dois dedos no trackpad), diferença por dispositivo (mouse × trackpad × toque), visibilidade/timing (elemento escondido em repouso que só aparece durante a ação).
- Uma premissa errada gera um plano competente pro problema ERRADO. Duvidar cedo é mais barato que forjar o fix errado.

Corrija o PROBLEMA, não só monte o plano:
- revised_title: se o título do card engana ou está incompleto (ex.: diz "não funciona no mousepad/mouse" quando na verdade só quebra no mouse), proponha um título CORRIGIDO e fiel. Se já está bom, deixe vazio.
- details: reescreva o problema em linguagem SIMPLES — o que de fato está errado, pra qualquer pessoa entender (inclusive não-técnica). É o problema, não a solução.
- evidence: CURE as citações que você recebeu (evidência da reunião + detalhes do humano) — os trechos VERBATIM que embasam o card, com quem falou e uma nota do porquê. NUNCA invente aspas além do que foi dado; sem citação recebida, deixe vazio.
- Se vieram DETALHES ADICIONAIS do humano, eles são AUTORITATIVOS: corrigem a moldura do card. Reconcilie título/details/evidence/plano com essa informação nova (ela ganha da fala original).

Depois chame submit_analysis com:
- revised_title / details / evidence: o problema corrigido, em linguagem simples, e rastreável (como acima).
- approach + rationale: a estratégia e o porquê, ancorados no código real. No rationale, separe o que VERIFICOU no código do que ASSUMIU do runtime.
- mode: atomic se é mudança pequena/localizada (1 PR); feature se precisa quebrar em vários passos.
- steps: passos concretos, cada um com \`touches\` = arquivos REAIS (que você viu no checkout), detail e acceptance.
- questions: dúvidas pro humano quando (a) algo é genuinamente ambíguo e muda a solução (decisão de produto, dado que falta), OU (b) o card afirma um comportamento de runtime que você NÃO confirmou no código / que o código contradiz. Se está tudo confirmável no código, deixe vazio — não invente dúvidas.

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
  const evidence: ResolveEvidence[] = Array.isArray(input.evidence)
    ? (input.evidence as Record<string, unknown>[])
        .map((e) => ({ quote: str(e.quote), speaker: str(e.speaker) || null, note: str(e.note) || null }))
        .filter((e) => e.quote)
        .slice(0, 12)
    : [];
  const revisedTitle = str(input.revised_title);
  return {
    revisedTitle: revisedTitle || null,
    details: str(input.details),
    evidence,
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
  const { cfg, cwd, repoFullName, card, answers, details, evidence, prior, signal, onProgress } = input;
  const model = resolveModel(cfg, input.model ?? "sonnet");
  const maxRounds = input.maxRounds ?? 20;
  const tools = [BASH_TOOL, SUBMIT_TOOL];

  const evidenceBlock =
    evidence && evidence.length
      ? `\n\nEVIDÊNCIA DE ORIGEM (trechos da reunião — CURE em evidence, não invente além destes):\n` +
        evidence.map((e) => `- ${e.speaker ? `${e.speaker}: ` : ""}"${e.quote}"${e.note ? ` (${e.note})` : ""}`).join("\n")
      : "";
  const priorBlock = prior
    ? `\n\nVERSÃO ANTERIOR (v${prior.version} — melhore, não recomece):\nTítulo: ${prior.title ?? "—"}\nProblema: ${prior.details ?? "—"}\nAbordagem: ${prior.approach ?? "—"}`
    : "";
  const detailsBlock = details
    ? `\n\nDETALHES ADICIONAIS DO HUMANO (AUTORITATIVO — corrige a moldura; ganha da fala original):\n${details}`
    : "";
  const answersBlock = answers ? `\n\nRESPOSTAS DO HUMANO a dúvidas anteriores (incorpore ao plano):\n${answers}` : "";

  const prompt =
    `Repositório: ${repoFullName}.\n\nCARD\nTítulo: ${card.title}\nDescrição: ${card.body || "(sem descrição)"}` +
    evidenceBlock +
    priorBlock +
    detailsBlock +
    answersBlock +
    `\n\nExplore o checkout e submeta a análise (problema corrigido + plano).`;

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
