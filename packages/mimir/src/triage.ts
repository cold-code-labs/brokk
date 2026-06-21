// ─────────────────────────────────────────────────────────────────────────────
// MÍMIR TRIADOR — the front door. Sizes a job on TWO independent axes in one
// cheap structured call:
//
//   1. refino — the specification gap (how clear the *prompt* is) → how much the
//      enhancer should restructure it. "none" = already clear, skip refining.
//   2. forca  — the task's complexity/risk → how hard the forge should run.
//      Maps downstream to a concrete model + reasoning effort (via Bifröst).
//
// These correlate but are distinct: a crystal-clear prompt can describe a brutal
// task (refino baixo, força alta) and vice-versa — so they're estimated apart.
// Auto by default; a human override is recorded as source="override" and, with
// Eitri's later verdict, calibrates the router over time.
// ─────────────────────────────────────────────────────────────────────────────

import {
  FORCA_LEVELS,
  type ForcaLevel,
  REFINO_LEVELS,
  type RefinoLevel,
} from "@brokk/core";

import type { MimirConfig } from "./config.js";
import { MimirError } from "./enhance.js";

export type TriageResult = {
  refino: RefinoLevel;
  refinoConf: number;
  forca: ForcaLevel;
  forcaConf: number;
  rationale: string;
  model: string;
};

const SYSTEM = `Você é o triador de Mímir, na Cold Code Labs. Recebe um pedido cru (uma "tarefa" ou um prompt já qualificado) destinado a um agente de codificação, e o dimensiona em DOIS eixos independentes. Não responda ao pedido nem o reescreva — apenas classifique.

EIXO 1 — refino (lacuna de especificação): quão claro o PROMPT está, e quanta estrutura o enhancer deve injetar.
- "none": já está claro e bem-especificado; não precisa refinar.
- "polish": claro, mas com ruído de gramática/ambiguidade leve.
- "structure": a intenção existe mas falta ordem (contexto → tarefa → saída).
- "engineer": vago ou complexo; precisa virar um prompt metódico completo (arquétipo).

EIXO 2 — forca (complexidade/risco da TAREFA): quão difícil/arriscada é a execução em si.
- "low": mudança trivial, isolada, baixo risco.
- "medium": escopo moderado, poucos arquivos.
- "high": toca várias partes, código compartilhado, exige cuidado.
- "extra": arquitetural, ambíguo ou alto risco; precisa do máximo de raciocínio.

Os dois eixos são INDEPENDENTES: um prompt claro pode descrever uma tarefa brutal (refino baixo, força alta) e vice-versa. Avalie cada um por si.`;

const OUTPUT_CONTRACT = `Responda SOMENTE com um objeto JSON válido, sem markdown, neste formato exato:
{"refino": "none|polish|structure|engineer", "refino_conf": <0..1>, "forca": "low|medium|high|extra", "forca_conf": <0..1>, "rationale": "<1-2 frases curtas em PT-BR justificando os dois níveis>"}`;

function clampConf(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return 0.5;
  return Math.min(1, Math.max(0, n));
}

function asRefino(v: unknown): RefinoLevel {
  return REFINO_LEVELS.includes(v as RefinoLevel) ? (v as RefinoLevel) : "structure";
}

function asForca(v: unknown): ForcaLevel {
  return FORCA_LEVELS.includes(v as ForcaLevel) ? (v as ForcaLevel) : "medium";
}

/** Triage a raw request into the two-axis decision. Throws MimirError on AI
 *  failure; never invents — falls back to safe middles (structure / medium). */
export async function triagePrompt(input: string, config: MimirConfig): Promise<TriageResult> {
  const clean = input.trim();
  if (!clean) throw new MimirError("Pedido vazio", 400);

  const res = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages: [
        { role: "system", content: `${SYSTEM}\n\n${OUTPUT_CONTRACT}` },
        { role: "user", content: clean },
      ],
      response_format: { type: "json_object" },
      max_completion_tokens: 500,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error("[mimir] triage", res.status, body.slice(0, 300));
    throw new MimirError(`OpenAI ${res.status}`, res.status);
  }

  const json = (await res.json().catch(() => null)) as ChatCompletion | null;
  const raw = json?.choices?.[0]?.message?.content ?? "";
  const p = safeParse(raw);

  return {
    refino: asRefino(p.refino),
    refinoConf: clampConf(p.refino_conf),
    forca: asForca(p.forca),
    forcaConf: clampConf(p.forca_conf),
    rationale: (p.rationale ?? "").trim(),
    model: config.model,
  };
}

type ChatCompletion = {
  choices?: { message?: { content?: string } }[];
};

type RawTriage = {
  refino?: unknown;
  refino_conf?: unknown;
  forca?: unknown;
  forca_conf?: unknown;
  rationale?: string;
};

function safeParse(raw: string): RawTriage {
  try {
    return JSON.parse(raw) as RawTriage;
  } catch {
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return JSON.parse(m[0]) as RawTriage;
      } catch {
        /* fall through */
      }
    }
    return {};
  }
}
