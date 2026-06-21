/**
 * @brokk/mimir — the counselor. Brokk's prompt intake: the triador (two-axis
 * router) + the enhancer (structured refinement). The prompt bank + immutable
 * history live in @brokk/db (schema `mimir_*`); this package is the brain that
 * decides how much to refine + how hard to forge, and does the refining.
 *
 * Trio: Mímir advises → Brokkr forges → Eitri reviews.
 */

export { loadMimirConfig, type MimirConfig } from "./config.js";
export { enhancePrompt, type EnhanceResult, MimirError } from "./enhance.js";
export { triagePrompt, type TriageResult } from "./triage.js";
export { DEFAULT_MODE, isMimirMode, MIMIR_MODES, MODE_META } from "./types.js";
export type { ForcaLevel, MimirMode, RefinoLevel } from "./types.js";
