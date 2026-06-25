// ─────────────────────────────────────────────────────────────────────────────
// Brokkr's voice — the forge persona (system prompt) and the per-task prompts.
// Moved verbatim from the old SDK engine (runner/engine.ts) so behaviour carries
// over; the only change is the browser hint, which now points at the bash hands
// (the native loop has no Playwright MCP — §9 minimal tool surface). The task
// brief, its acceptance, and per-repo memory are assembled here; repo conventions
// (CLAUDE.md/AGENTS.md) the agent reads from cwd itself.
// ─────────────────────────────────────────────────────────────────────────────

import type { AgentRunContext } from "@brokk/core";

/** Brokkr's system prompt — the lean, role-specific identity (§9 #2). */
export const DEFAULT_SYSTEM_PROMPT =
  "You are Brokk, an autonomous coding agent. Implement the task in the current " +
  "repository working tree. Follow the repo's existing conventions. Make focused, " +
  "reviewable changes, and cover the behaviour you change with a test. Do not push " +
  "or open PRs yourself — that is handled for you.";

type Task = AgentRunContext["task"];

/** Assemble the initial task prompt: the task, its success condition, the per-repo
 *  memory (learned conventions / past review failures), and an optional browser
 *  hint. The system persona is delivered separately (as the API `system`), so this
 *  is the user turn. */
export function buildPrompt(ctx: AgentRunContext, browser?: boolean): string {
  const labels = ctx.task.labels.length ? `\nLabels: ${ctx.task.labels.join(", ")}` : "";
  const browserHint = browser
    ? [
        "",
        "## Browser available",
        "The runner host has a headless Chromium. When a card's acceptance is a UI or HTTP",
        "behaviour, drive the running app to check it from the `bash` tool (e.g. a short",
        "Playwright/`chrome-headless-shell` script, or `curl` for HTTP), and commit a Playwright",
        "e2e spec (under `e2e/`, reading `process.env.BASE_URL`) that proves it — that spec is the",
        "durable acceptance receipt the verify step re-runs.",
      ].join("\n")
    : "";
  const acceptance = ctx.task.acceptance
    ? [
        "",
        "## Acceptance (the success condition — you MUST make this true)",
        ctx.task.acceptance,
        "Add or extend a test that proves it. The change is not done until a test covers this behaviour.",
      ].join("\n")
    : "";
  const memory =
    ctx.memory && ctx.memory.length
      ? [
          "",
          "## Repo memory (lessons from past work here — respect these)",
          ...ctx.memory.map((m) => `- ${m}`),
        ].join("\n")
      : "";
  return [
    `# Task: ${ctx.task.title}`,
    ctx.task.body || "(no description)",
    labels,
    acceptance,
    memory,
    browserHint,
    "",
    "When done, ensure changes are committed-ready (Brokk will commit, push, and open the PR).",
  ].join("\n");
}

/** Re-prompt for a heal pass: the agent's previous changes are already in the
 *  worktree (and, on the native loop, in this same conversation); the verify
 *  command failed — fix it so verification passes. */
export function buildHealPrompt(ctx: AgentRunContext, verifyOutput: string): string {
  const acceptance = ctx.task.acceptance
    ? `\nThe acceptance condition still stands: ${ctx.task.acceptance}\n`
    : "";
  return [
    "Your previous changes are in the working tree, but VERIFICATION FAILED.",
    "Read the failure output below, fix the code (and tests) so the verify command passes,",
    "and keep the original task intact. Do not revert working changes — repair them.",
    acceptance,
    `# Task (unchanged): ${ctx.task.title}`,
    "",
    "## Verify failure output",
    "```",
    verifyOutput.slice(-12_000),
    "```",
  ].join("\n");
}
