/**
 * @brokk/scout — Huginn, the discovery scout. Odin's raven: flies over a read-only
 * checkout and reports a structured product brief (mission / built / missing /
 * stack). Runs on @brokk/afl (gateway + the shared read-only bash hand), one-shot
 * and read-only by construction — it reads, never writes or pushes. The brief's
 * `missing[]` is the raw material for an auto-proposed backlog. See NORTH-STAR §7.
 */

export { type DiscoveryBrief, runDiscovery, type RunDiscoveryInput } from "./discovery.js";
export { type DetectRuntimeInput, detectRuntime } from "./runtime.js";
// Resolve — the per-card analysis scout (Muninn's sibling): ONE card + a read-only
// checkout → a concrete resolution plan (approach / steps / questions / mode).
export {
  type ResolveAnalysis,
  type ResolveEvidence,
  type ResolvePrior,
  type ResolveStep,
  runResolve,
  type RunResolveInput,
} from "./resolve.js";
// Muninn — the meeting scout: a Saga transcript → classified ajustes (+ verbatim
// evidencia). runMeetingScout runs it; the chat backfill re-runs it over a transcript.
export {
  type Ajuste,
  type MeetingEvidence,
  type MeetingScout,
  runMeetingScout,
  type RunMeetingScoutInput,
} from "./meeting.js";
// QA Discovery — user-journey catalog for Full / Targeted GUI QA (fingerprint → stale).
export {
  computeQaFingerprint,
  type QaDiscoveryResult,
  type QaScenario,
  type QaScenarioPriority,
  runQaDiscovery,
  type RunQaDiscoveryInput,
} from "./qa-discovery.js";
