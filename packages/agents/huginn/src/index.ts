/**
 * @brokk/huginn — Huginn, the Brokk raven for Discovery → QA.
 *
 * Pipeline (product vocabulary):
 *   Discovery → QA (LLM | Automated) → Forge
 *
 * On connect / new repo: Huginn runs Discovery (brief + scenario catalog +
 * runtime hint). QA Execution (LLM+Playwright or harvested e2e) and fail→Forge
 * cards are the same loop — see Edda ADR 0067.
 *
 * Implementation today lives in `@brokk/scout`; this package is the **product
 * face**. Callers should import `@brokk/huginn`. Muninn (meetings) and Resolve
 * (per-card analysis) stay on `@brokk/scout` until they earn their own home.
 */

export {
  type DiscoveryBrief,
  runDiscovery,
  type RunDiscoveryInput,
} from "@brokk/scout";

export {
  computeQaFingerprint,
  type QaDiscoveryResult,
  type QaScenario,
  type QaScenarioPriority,
  runQaDiscovery,
  type RunQaDiscoveryInput,
} from "@brokk/scout";

export { type DetectRuntimeInput, detectRuntime } from "@brokk/scout";
