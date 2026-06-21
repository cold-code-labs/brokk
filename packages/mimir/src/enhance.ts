// ─────────────────────────────────────────────────────────────────────────────
// MÍMIR ENHANCER — refines a raw prompt into a better one. One-shot structured
// rewrite (not tool orchestration): a non-reasoning model delivers quality close
// to a flagship at ~1/8 the cost. Returns the refined prompt + a short rationale
// of what improved, so the history shows the curve over time.
//
// Ported verbatim from Heimdall's lib/mimir/enhance.ts; the only change is that
// model/endpoint/key come from MimirConfig (so it can route through Bifröst)
// instead of Asgard's env.
// ─────────────────────────────────────────────────────────────────────────────

import type { MimirMode } from "@brokk/core";

import type { MimirConfig } from "./config.js";
import { DEFAULT_MODE, isMimirMode } from "./types.js";

export type EnhanceResult = {
  enhanced: string;
  rationale: string;
  model: string;
  mode: MimirMode;
};

export class MimirError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "MimirError";
    this.status = status;
  }
  userMessage(): string {
    if (this.status === 429) {
      return "Mímir está sem saldo na conta de IA no momento. Adicione créditos e o refino volta.";
    }
    if (this.status === 401 || this.status === 403) {
      return "A chave de IA foi recusada (401/403). Verifique a `MIMIR_API_KEY`.";
    }
    return "Não consegui refinar o prompt agora. Tente de novo em instantes.";
  }
}

// Common preamble: Mímir's persona + the invariants shared by all three modes +
// the JSON output contract. Each mode only appends its specific instructions.
const PREAMBLE = `Você é Mímir, o conselheiro de sabedoria da Cold Code Labs: um especialista em engenharia de prompts.

Regras que valem SEMPRE, em qualquer modo:
- Nunca invente requisitos factuais que mudem a tarefa (linguagem, framework, prazo, números, persona específica) se o autor não os mencionou.
- Preserve o idioma do prompt original (PT-BR continua PT-BR).
- Não responda ao prompt; apenas o reescreva.`;

const OUTPUT_CONTRACT = `Responda SOMENTE com um objeto JSON válido, sem markdown, neste formato exato:
{"enhanced": "<o prompt refinado, pronto p/ colar>", "rationale": "<2-4 frases curtas em PT-BR explicando o que você melhorou e por quê>"}`;

const MODE_INSTRUCTIONS: Record<MimirMode, string> = {
  polish: `MODO: LEVE (polir).
Sua tarefa é POLIR o prompt abaixo sem alterar o significado, o tom ou a intenção do autor.

Faça:
- Corrigir gramática, ortografia, pontuação e concordância.
- Desfazer ambiguidades óbvias, reescrevendo frases confusas de forma mínima.
- Manter o tamanho aproximadamente igual ao original.

Não faça:
- Não adicione estrutura, seções, listas ou persona.
- Não acrescente conteúdo, requisitos ou contexto que o autor não escreveu.
- Não mude o registro (formal/informal) do texto.`,
  structure: `MODO: MÉDIO (estruturar).
Sua tarefa é ESTRUTURAR o prompt abaixo, organizando a intenção do autor numa sequência clara.

Faça:
- Reescreva o pedido numa ordem lógica: primeiro o contexto, depois a tarefa, depois o resultado esperado.
- Quando houver vários passos, numere-os ("1. ..., 2. ...").
- Separe contexto de tarefa quando isso for inferível do próprio texto.
- Se o formato de saída for óbvio (ex.: lista, tabela, código), adicione no máximo uma linha indicando-o.

Não faça:
- Não adicione persona ("atue como...").
- Não invente critérios, checklists ou requisitos que o autor não mencionou.
- Não expanda além de ~2x o tamanho do original.`,
  engineer: `MODO: FORTE (engenheiro de prompts).
Sua tarefa é transformar o pedido abaixo num prompt completo e metódico, no padrão de engenharia de prompt.

Estruture a saída exatamente nestes blocos (omita um bloco só se for genuinamente irrelevante para o pedido):
- Persona: comece com "Atue como [papel mais adequado à tarefa]".
- Contexto: liste em bullets tudo que foi dito ou que pode ser inferido com segurança do pedido.
- Tarefa: descreva o objetivo em passos numerados, do geral ao específico.
- Formato de saída: especifique idioma, organização (seções/listas/tabelas) e qualquer critério de qualidade relevante.

Princípios:
- Extraia a intenção do autor e a expanda com tudo que um bom prompt teria, MAS sem inventar fatos que mudem a tarefa.
- Seja específico e acionável; prefira instruções verificáveis a adjetivos.
- Respeite um teto de tamanho razoável — não infle com texto redundante.`,
};

// Token ceiling per mode: the modes decide *when* to expand, the ceiling caps
// *how much*. Generous on purpose — a safety cap, not a target.
const MODE_MAX_TOKENS: Record<MimirMode, number> = {
  polish: 2500,
  structure: 4000,
  engineer: 8000,
};

function systemFor(mode: MimirMode): string {
  return `${PREAMBLE}\n\n${MODE_INSTRUCTIONS[mode]}\n\n${OUTPUT_CONTRACT}`;
}

/** Refine a prompt in the given mode. Throws MimirError on AI failure. */
export async function enhancePrompt(
  input: string,
  mode: MimirMode,
  config: MimirConfig,
): Promise<EnhanceResult> {
  const clean = input.trim();
  if (!clean) throw new MimirError("Prompt vazio", 400);
  const safeMode: MimirMode = isMimirMode(mode) ? mode : DEFAULT_MODE;

  const res = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages: [
        { role: "system", content: systemFor(safeMode) },
        { role: "user", content: clean },
      ],
      response_format: { type: "json_object" },
      max_completion_tokens: MODE_MAX_TOKENS[safeMode],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error("[mimir] enhance", res.status, body.slice(0, 300));
    throw new MimirError(`OpenAI ${res.status}`, res.status);
  }

  const json = (await res.json().catch(() => null)) as ChatCompletion | null;
  const raw = json?.choices?.[0]?.message?.content ?? "";
  const parsed = safeParse(raw);
  if (!parsed.enhanced) {
    console.error("[mimir] enhance: no 'enhanced' in response", raw.slice(0, 300));
    throw new MimirError("Resposta inesperada do modelo.", 502);
  }

  return {
    enhanced: parsed.enhanced.trim(),
    rationale: (parsed.rationale ?? "").trim(),
    model: config.model,
    mode: safeMode,
  };
}

type ChatCompletion = {
  choices?: { message?: { content?: string } }[];
};

function safeParse(raw: string): { enhanced?: string; rationale?: string } {
  try {
    return JSON.parse(raw) as { enhanced?: string; rationale?: string };
  } catch {
    // Model sometimes wraps in ```json … ``` — try to extract the object.
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return JSON.parse(m[0]) as { enhanced?: string; rationale?: string };
      } catch {
        /* fall through */
      }
    }
    return {};
  }
}
