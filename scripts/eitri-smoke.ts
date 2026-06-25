#!/usr/bin/env tsx
// ─────────────────────────────────────────────────────────────────────────────
// Eitri smoke test — exercises the reviewer brain (@brokk/eitri reviewPr) in
// ISOLATION over the native @brokk/afl loop (NO Agent SDK). No daemon, no DB, no
// gh, no GitHub App: just the gateway + a real git worktree with a diff → a
// verdict + markdown review.
//
// Also asserts the reviewer is READ-ONLY: the worktree must be byte-for-byte
// unchanged after the review (it inspects, never mutates).
//
// Usage (host with gateway env, e.g. surtr; from repo root):
//   set -a; . /home/brokk/brokk.env; set +a
//   pnpm dlx tsx scripts/eitri-smoke.ts [model]
// Exit 0 = pass, 1 = checks failed, 2 = misconfigured (no token).
// ─────────────────────────────────────────────────────────────────────────────

import { exec as execCb } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { loadAflConfig } from "../packages/afl/src/config.js";
import { reviewPr } from "../packages/agents/reviewer/src/index.js";

const exec = promisify(execCb);
const model = process.argv[2] || "sonnet";

const cfg = loadAflConfig();
if (!cfg.authToken) {
  console.error("✗ ANTHROPIC_AUTH_TOKEN unset — source the gateway env first (e.g. /home/brokk/brokk.env)");
  process.exit(2);
}

// A real worktree: a clean base committed, then a change that introduces an
// obvious bug (off-by-one — reads one past the end) for the reviewer to catch.
const cwd = await fs.mkdtemp(join(tmpdir(), "eitri-smoke-"));
const BASE = `export function last(xs) {
  return xs[xs.length - 1];
}
`;
const BUGGY = `export function last(xs) {
  // BUG: off-by-one — indexes one past the end, always returns undefined
  return xs[xs.length];
}
`;
await fs.writeFile(join(cwd, "last.js"), BASE);
await exec("git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm base", { cwd });
await fs.writeFile(join(cwd, "last.js"), BUGGY);
const { stdout: diff } = await exec("git diff", { cwd });
const before = await snapshot(cwd);

console.log("🛡️ Eitri smoke test → review a buggy diff");
console.log(`   worktree: ${cwd}`);
console.log(`   gateway:  ${cfg.gatewayUrl}   model: ${model}\n`);

const t0 = Date.now();
let result;
try {
  result = await reviewPr({ cwd, model, prTitle: "Add last() helper", diff, cfg });
} catch (e) {
  console.error(`\n✗ reviewPr threw: ${(e as Error)?.message ?? e}`);
  process.exit(1);
}
const secs = ((Date.now() - t0) / 1000).toFixed(1);

const after = await snapshot(cwd);
const readOnly = before === after;

console.log(`──────── REVIEW (${secs}s) ────────`);
console.log(`verdict: ${result.verdict}`);
console.log(`${result.body.slice(0, 600)}${result.body.length > 600 ? "\n  …" : ""}`);

const checks: [string, boolean][] = [
  ["verdict is a valid value", ["APPROVE", "COMMENT", "REQUEST_CHANGES"].includes(result.verdict)],
  ["body is substantive (>40 chars, not the empty fallback)", result.body.trim().length > 40 && !/produced no output/.test(result.body)],
  ["body carries a VERDICT: line", /VERDICT:/i.test(result.body)],
  ["worktree UNCHANGED — reviewer is read-only", readOnly],
];
console.log("\n──────── CHECKS ────────");
let ok = true;
for (const [n, p] of checks) {
  console.log(`  ${p ? "✓" : "✗"} ${n}`);
  if (!p) ok = false;
}
// Soft signal (not a hard gate — verdict is model-variable): did it catch the bug?
console.log(`\n  · caught the off-by-one? ${/off.?by.?one|xs\.length|out of|undefined|bounds/i.test(result.body) ? "yes" : "unclear"}`);

await fs.rm(cwd, { recursive: true, force: true }).catch(() => {});
console.log(ok ? "\n✅ EITRI SMOKE PASSED" : "\n❌ EITRI SMOKE FAILED");
process.exit(ok ? 0 : 1);

/** A stable snapshot of the worktree's tracked files (sans .git) to detect any
 *  mutation by the reviewer. */
async function snapshot(dir: string): Promise<string> {
  const { stdout } = await exec("git status --porcelain && git diff", { cwd: dir });
  return stdout;
}
