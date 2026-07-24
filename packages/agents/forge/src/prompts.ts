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
  "reviewable changes, and cover the behaviour you change with a test — using the " +
  "test tooling ALREADY in the repo. Never install a new test framework or " +
  "dependency (Playwright, Jest, Vitest, etc.) just to write a test: match the test " +
  "effort to the size of the change and keep the PR proportional (a one-line fix " +
  "must not drag in a new toolchain + lockfile churn). Do not push or open PRs " +
  "yourself — that is handled for you.";

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
        "behaviour you can't confirm from code alone, drive the running app to CHECK it from",
        "the `bash` tool (a short `chrome-headless-shell` script, or `curl` for HTTP) — checking",
        "is free and needs no dependency.",
        "Only commit an e2e spec if the repo ALREADY has an e2e setup (an `e2e/` dir or",
        "Playwright/Cypress in devDependencies) — extend that. Do NOT `install` Playwright or any",
        "new test dependency to create one: for a small or localized change, the repo's own",
        "typecheck/build plus (if useful) a lightweight test in the EXISTING tooling is the",
        "acceptance receipt the verify step re-runs. Dragging in a browser test runner for a",
        "one-line fix bloats the PR and breaks verify when the new dep won't install cleanly.",
        "",
        "### E2E gate (UI/behaviour cards)",
        "Prefer the repo's Playwright suite when present (`playwright.config.*` or",
        "`.brokk/profile.json` → `commands.e2e`). Brokk boots the app and runs that command",
        "with PLAYWRIGHT_BASE_URL / BASE_URL set — green verify proves it compiles, E2E",
        "proves it BEHAVES.",
        "  - Prefer extending existing `e2e/` / Playwright specs. Do NOT add Playwright as a",
        "    new dependency for a one-line fix when the repo has no browser tests yet.",
        "  - Legacy fallback only: `.brokk/acceptance.mjs` (dependency-free Node ESM) with",
        "    BROKK_ACCEPTANCE_URL / BROKK_CHROMIUM / BROKK_ACCEPTANCE_SHOT — still supported,",
        "    but prefer Playwright going forward.",
        "  - Skip the gate when the change has no observable runtime behaviour (pure refactor,",
        "    types, docs).",
      ].join("\n")
    : "";
  const acceptance = ctx.task.acceptance
    ? [
        "",
        "## Acceptance (the success condition — you MUST make this true)",
        ctx.task.acceptance,
        "Prove it with a test using the repo's EXISTING tooling — don't add a new framework or",
        "dependency for it, and keep the test proportional to the change (a trivial fix may be",
        "covered by the existing typecheck/build rather than a brand-new spec).",
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
  // Dev-lane doctrine (ADR 0017 §6b): a `migration` context means this app has a
  // shared dev database and the `apply_migration` tool. Schema changes go through
  // it — never raw DDL, never a hand-written migration file — so the files and the
  // live DB can't drift and the deploy skips what's already applied.
  const migrationHint = ctx.migration
    ? [
        "",
        "## Database schema — migrations only (never raw DDL)",
        "This app's schema is code in `db/migrations/*.sql`, applied to a shared dev database.",
        "To change the schema (create/alter/drop a table, column, index, view, function, RLS",
        "policy, trigger, grant): call the `apply_migration` tool with a short `name` and the",
        "`sql`. It writes the migration file AND applies it to the dev DB now, so the preview",
        "reflects it immediately.",
        "- NEVER run DDL by hand (psql/bash, a DB client) and NEVER create or edit files under",
        "  `db/migrations/` with write_file/edit_file — `apply_migration` owns that path.",
        "- Prefer ADDITIVE changes (`create table if not exists`, add a column). A destructive",
        "  change (drop/rename) can break the running dev-build that shares this database.",
        "- One migration per schema change. Already-applied migrations are skipped on deploy.",
      ].join("\n")
    : "";
  return [
    `# Task: ${ctx.task.title}`,
    ctx.task.body || "(no description)",
    labels,
    acceptance,
    memory,
    migrationHint,
    browserHint,
    "",
    "When done, ensure changes are committed-ready (Brokk will commit, push, and open the PR).",
  ].join("\n");
}

/**
 * Compress a verify failure for the heal prompt.
 * Full `pnpm install` dumps divert the agent into chasing env noise (e.g.
 * ERR_PNPM_IGNORED_BUILDS → inventing pnpm-workspace.yaml). Prefer the root
 * error code + a short tail of meaningful lines.
 */
export function summarizeVerifyFailure(output: string, opts?: { maxLines?: number; maxChars?: number }): string {
  const maxLines = opts?.maxLines ?? 30;
  const maxChars = opts?.maxChars ?? 3500;
  const text = output.replace(/\r\n/g, "\n").trim();
  if (!text) return "(no verify output)";

  const hints: string[] = [];
  if (/ERR_PNPM_IGNORED_BUILDS/i.test(text)) {
    hints.push(
      "Harness note: ERR_PNPM_IGNORED_BUILDS is a pnpm policy/env issue. Prefer `.npmrc` with `strict-dep-builds=false` (fleet convention). Do NOT invent `pnpm-workspace.yaml` allowBuilds placeholders. If the real code fix is already done, leave package manager config alone unless verify still fails after that.",
    );
  }
  if (/Missing script:\s*["']?typecheck/i.test(text)) {
    hints.push(
      "Harness note: this repo has no `typecheck` script. Prefer `pnpm exec tsc --noEmit` (if tsconfig exists) or the repo's existing `build`/`lint` — do not add a new test framework.",
    );
  }
  if (/ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY/i.test(text)) {
    hints.push("Harness note: pnpm wanted a TTY to purge node_modules — usually fixed by CI=true in verify; re-run / avoid manual rm of node_modules.");
  }

  const lines = text.split("\n").map((l) => l.trimEnd());
  const noise = (l: string) =>
    /^\s*\+\s+\S+@?\S*\s+\d/.test(l) || // pnpm "+ pkg version" install dump
    /^Progress:\s/i.test(l) ||
    /^Packages:\s*\+/i.test(l) ||
    /^\? Verifying lockfile/i.test(l) ||
    /^Lockfile is up to date/i.test(l) ||
    /^\++$/.test(l.trim());
  const interesting = lines.filter(
    (l) =>
      !noise(l) &&
      /error|fail|ERR_|ELIFECYCLE|TS\d{4}|ENOENT|EACCES|not found|Cannot find|Missing script|Command failed/i.test(l),
  );
  const tail = lines.filter((l) => !noise(l)).slice(-maxLines);
  const pick: string[] = [];
  const seen = new Set<string>();
  const push = (l: string) => {
    const key = l.trim();
    if (!key || seen.has(key)) return;
    seen.add(key);
    pick.push(l);
  };
  for (const l of interesting.slice(-Math.min(15, maxLines))) push(l);
  for (const l of tail) push(l);

  const body = [...hints, hints.length ? "" : null, ...pick].filter((x): x is string => x != null).join("\n");
  return body.length > maxChars ? body.slice(-maxChars) : body;
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
    summarizeVerifyFailure(verifyOutput),
    "```",
  ].join("\n");
}
