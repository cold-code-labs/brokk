/**
 * @brokk/scout — implementation home for Brokk scouts (LLM read-only over a
 * checkout). **Product face for Discovery → QA is `@brokk/huginn`** (ADR 0067).
 *
 * Still hosts: product brief, QA catalog scout, runtime detect, Muninn (meetings),
 * Resolve (per-card). Prefer importing Discovery/QA APIs from `@brokk/huginn`.
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
