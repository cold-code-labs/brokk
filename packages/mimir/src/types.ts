// ─────────────────────────────────────────────────────────────────────────────
// MÍMIR — refinement modes (client-safe metadata; no server deps here).
// The axis between the modes is not quality — it's *how much structure Mímir
// injects* over what the author wrote. The domain types (MimirMode etc.) live
// in @brokk/core; here are only the UI labels + helpers.
// ─────────────────────────────────────────────────────────────────────────────

import type { MimirMode } from "@brokk/core";

export { MIMIR_MODES } from "@brokk/core";
export type { ForcaLevel, MimirMode, RefinoLevel } from "@brokk/core";

export const DEFAULT_MODE: MimirMode = "structure";

export function isMimirMode(v: unknown): v is MimirMode {
  return v === "polish" || v === "structure" || v === "engineer";
}

/** Metadata for the UI: short label + one-line hint per mode. */
export const MODE_META: Record<MimirMode, { label: string; hint: string }> = {
  polish: {
    label: "Leve",
    hint: "Corrige gramática e clareza, sem mudar a estrutura.",
  },
  structure: {
    label: "Médio",
    hint: "Organiza em ordem lógica: contexto, tarefa, resultado.",
  },
  engineer: {
    label: "Forte",
    hint: "Prompt metódico completo: persona, contexto, tarefa e formato.",
  },
};
