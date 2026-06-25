/**
 * @brokk/reviewer — Eitri, the forge's second smith. The review brain: read the
 * PR diff in worktree context with the read-only hands and return a verdict +
 * markdown review, native over the @brokk/afl agent loop (no Agent SDK). A pure
 * library — the daemon that polls PRs and posts the verdict lives in apps/reviewer.
 * See docs/NORTH-STAR.md §7, §9, §10.
 */

export { type ReviewResult, reviewPr, SYSTEM_PROMPT, type Verdict } from "./review.js";
