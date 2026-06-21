/**
 * @brokk/mimir — the counselor. Brokk's prompt intake: the triador (two-axis
 * router), the enhancer (structured refinement) and the planner (one intent →
 * cards → one PR). The bank + immutable history live in @brokk/db (schema
 * `mimir_*`); this package is the brain that decides how much to refine, how to
 * decompose, and how hard each card forges.
 *
 * Trio: Mímir advises → Brokkr forges → Eitri reviews.
 */

export { extractJson, mimirComplete } from "./client.js";
export { loadMimirConfig, type MimirConfig, type MimirProvider } from "./config.js";
export { enhancePrompt, type EnhanceResult } from "./enhance.js";
export { MimirError } from "./errors.js";
export { planJob } from "./planner.js";
export { triagePrompt, type TriageResult } from "./triage.js";
export { DEFAULT_MODE, isMimirMode, MIMIR_MODES, MODE_META } from "./types.js";
export type { ForcaLevel, MimirMode, RefinoLevel } from "./types.js";
