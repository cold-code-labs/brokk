// ─────────────────────────────────────────────────────────────────────────────
// Muninn — the meeting scout. Huginn's twin raven (thought vs. memory): where
// Huginn (discovery.ts) flies over a CODEBASE and reports what it is and needs,
// Muninn reads what was SAID in a client meeting — a Saga transcript — and reports
// the actionable `ajustes`. It is the second front door to the same pipeline:
//
//   Saga (transcript) ─▶ [Muninn] ajustes classificados ─▶ CONFIRM (backlog)
//                          ├─ vira_plano=false → 1 card
//                          └─ vira_plano=true  → Mímir planner → Plano + DAG
//                                                             └▶ forge → Eitri → preview
//
// One-shot and read-only by construction: the transcript fits in context, so there
// is no exploration loop (unlike Huginn's bash) — a single forced structured call.
// Default model is sonnet (extraction/classification quality matters and this is a
// single call, not a hot loop). Kept dep-pure on @brokk/afl so it's testable alone.
//
// The prototype proof over real transcripts is scripts/muninn-prototype.mjs, which
// shares this exact SYSTEM prompt + tool schema.
// ─────────────────────────────────────────────────────────────────────────────

import type { AflConfig } from "@brokk/afl";
import { resolveModel, streamAssistant } from "@brokk/afl";
import type { ChatTurnMessage, ToolDef, ToolUseBlock } from "@brokk/afl";

export type Area = "mockup" | "crm" | "ativacoes" | "billing" | "outro";
export type Tipo = "bug" | "ajuste" | "feature" | "epico";
export type Disposicao = "pronto" | "discovery" | "bloqueado" | "deferido";

/** One actionable adjustment extracted from a meeting — a card-candidate. */
export interface Ajuste {
  titulo: string;
  /** What the client asked, grounded in the transcript. */
  o_que_pediram: string;
  area: Area;
  tipo: Tipo;
  disposicao: Disposicao;
  /** false → one standalone card; true → a Plano with a DAG (épico/discovery). */
  vira_plano: boolean;
  /** For bloqueado/deferido: what it waits on / why it was parked. */
  nota?: string;
}

/** The structured extraction Muninn emits from one meeting. */
export interface MeetingScout {
  reuniao_resumo: string;
  ajustes: Ajuste[];
  /** Chatter deliberately dropped (food, feira logistics…) — for transparency. */
  fora_de_escopo: string[];
}

export interface RunMeetingScoutInput {
  cfg: AflConfig;
  /** The full meeting transcript (from Saga). */
  transcript: string;
  /** Human title for context in the prompt (e.g. "Handoff da plataforma"). */
  meetingTitle: string;
  /** Model alias or id — default sonnet (quality over cost for one call). */
  model?: string;
  maxTokens?: number;
  signal?: AbortSignal;
  onProgress?: (note: string) => void;
}

const SUBMIT_TOOL: ToolDef = {
  name: "submit_ajustes",
  description:
    "Entrega a lista final de ajustes acionáveis extraídos da reunião. Chame EXATAMENTE UMA VEZ, depois de ler a transcrição inteira.",
  input_schema: {
    type: "object",
    properties: {
      reuniao_resumo: { type: "string", description: "1-2 frases: que reunião foi esta e com quem." },
      ajustes: {
        type: "array",
        description: "Cada ajuste acionável no PRODUTO. Ignore papo social, comida, logística de feira, brincadeiras.",
        items: {
          type: "object",
          properties: {
            titulo: { type: "string", description: "Título curto, imperativo." },
            o_que_pediram: { type: "string", description: "O que o cliente pediu, fiel à fala. Concreto." },
            area: { type: "string", enum: ["mockup", "crm", "ativacoes", "billing", "outro"] },
            tipo: {
              type: "string",
              enum: ["bug", "ajuste", "feature", "epico"],
              description: "bug=defeito; ajuste=tweak pequeno (prompt/default); feature=novo comportamento; epico=frente grande.",
            },
            disposicao: {
              type: "string",
              enum: ["pronto", "discovery", "bloqueado", "deferido"],
              description: "pronto=escopo claro; discovery=alinhar antes; bloqueado=espera input externo; deferido=ver depois.",
            },
            vira_plano: { type: "boolean", description: "false=1 card; true=Plano com DAG (discovery ou épico)." },
            nota: { type: "string", description: "Só p/ bloqueado/deferido: em que depende ou por que adiado." },
          },
          required: ["titulo", "o_que_pediram", "area", "tipo", "disposicao", "vira_plano"],
        },
      },
      fora_de_escopo: {
        type: "array",
        items: { type: "string" },
        description: "O que você IGNOROU de propósito (papo fora do produto), para transparência.",
      },
    },
    required: ["reuniao_resumo", "ajustes", "fora_de_escopo"],
  },
};

const SYSTEM = `Você é Muninn, o corvo-memória do Brokk. Onde Huginn sobrevoa o código, você lê o que foi DITO numa reunião de cliente e devolve os ajustes acionáveis.

Você recebe a transcrição de UMA reunião (pode ter ruído de fala, sobreposição, papo social). Sua tarefa:
1. Ler a transcrição inteira.
2. Extrair SÓ o que é acionável no PRODUTO — pedidos de mudança, bugs relatados, features, ajustes de comportamento. Um ajuste = uma tarefa fraseável.
3. Descartar tudo que não é trabalho: papo social, comida, logística da feira, brincadeiras, quem chega que horas. Liste o descartado em fora_de_escopo.
4. Classificar cada ajuste: area, tipo (bug/ajuste/feature/epico), disposicao (pronto/discovery/bloqueado/deferido) e vira_plano.

Regras de classificação:
- tipo=ajuste para tweaks pequenos (mudar um default, ajustar um prompt, trocar um texto/número hardcoded). tipo=epico para frentes grandes (várias telas/semanas) — épico NUNCA é "ajuste fino".
- disposicao=bloqueado quando depende de input externo que ainda não veio (specs do cliente, decisão de negócio dele). disposicao=deferido quando disseram "vemos depois / pós-feira".
- vira_plano=true SE tipo=epico OU disposicao=discovery. vira_plano=false para ajustes simples e prontos (viram 1 card direto).
- Inclua itens bloqueado/deferido com a disposição correta e uma nota; o pipeline os trata como nota, não card.

Seja fiel: cada ajuste ancorado em algo REAL dito. Não invente, não repita. Responda em português. Chame submit_ajustes exatamente uma vez.`;

function coerce(input: Record<string, unknown>): MeetingScout {
  const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
  const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
    (allowed as readonly string[]).includes(str(v)) ? (str(v) as T) : fallback;
  const ajustes: Ajuste[] = Array.isArray(input.ajustes)
    ? (input.ajustes as Record<string, unknown>[])
        .map((a) => ({
          titulo: str(a.titulo),
          o_que_pediram: str(a.o_que_pediram),
          area: oneOf<Area>(a.area, ["mockup", "crm", "ativacoes", "billing", "outro"], "outro"),
          tipo: oneOf<Tipo>(a.tipo, ["bug", "ajuste", "feature", "epico"], "ajuste"),
          disposicao: oneOf<Disposicao>(a.disposicao, ["pronto", "discovery", "bloqueado", "deferido"], "discovery"),
          vira_plano: Boolean(a.vira_plano),
          nota: str(a.nota) || undefined,
        }))
        .filter((a) => a.titulo)
    : [];
  return {
    reuniao_resumo: str(input.reuniao_resumo),
    ajustes,
    fora_de_escopo: Array.isArray(input.fora_de_escopo)
      ? (input.fora_de_escopo as unknown[]).map(str).filter(Boolean)
      : [],
  };
}

/** Read one meeting transcript into a classified list of ajustes. Throws if the
 *  model never returns a submit_ajustes tool call (even under a forced choice). */
export async function runMeetingScout(input: RunMeetingScoutInput): Promise<MeetingScout> {
  const { cfg, transcript, meetingTitle, signal, onProgress } = input;
  const model = resolveModel(cfg, input.model ?? "sonnet");
  const maxTokens = input.maxTokens ?? 8000;

  const messages: ChatTurnMessage[] = [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: `Reunião: "${meetingTitle}".\n\nTranscrição a seguir. Extraia e classifique os ajustes.\n\n---\n${transcript}`,
        },
      ],
    },
  ];

  onProgress?.("extracting");
  const result = await streamAssistant(
    cfg,
    { model, system: SYSTEM, messages, tools: [SUBMIT_TOOL], toolChoice: { type: "tool", name: "submit_ajustes" }, maxTokens },
    () => {},
    signal,
  );
  const submit = result.blocks.find((b): b is ToolUseBlock => b.type === "tool_use" && b.name === "submit_ajustes");
  if (!submit) throw new Error("Muninn did not return submit_ajustes");
  onProgress?.("done");
  return coerce(submit.input as Record<string, unknown>);
}
