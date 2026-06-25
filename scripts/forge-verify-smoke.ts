#!/usr/bin/env tsx
// ─────────────────────────────────────────────────────────────────────────────
// Forge verify→heal smoke — exercises the part the happy-path smoke skips: the
// ForgeEngine's verify → self-heal loop (the genuinely NEW engine code; push/PR
// is unchanged runner code the engine never touches).
//
// Two scenarios, both against the live gateway in a REAL git worktree:
//   A. verify PASSES → expect verify.ok, healAttempts=0, worktree commit-ready.
//   B. verify always RED → expect the heal machinery to fire and bound: the
//      engine runs verify, sees red, re-prompts (heal), re-verifies, stops at
//      maxHealAttempts. (We assert the LOOP wiring, not convergence — an
//      `exit 1` verify can't be fixed by code.)
//
// Usage (host with gateway env, e.g. surtr; from repo root):
//   set -a; . /home/brokk/brokk.env; set +a
//   pnpm dlx tsx scripts/forge-verify-smoke.ts [model]
// Exit 0 = both scenarios pass, 1 = a check failed, 2 = misconfigured.
// ─────────────────────────────────────────────────────────────────────────────

import { exec as execCb } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AgentRunContext, RunEvent, VerifyOutcome } from "../packages/core/src/index.js";
import { loadAflConfig } from "../packages/afl/src/config.js";
import { ForgeEngine } from "../packages/agents/forge/src/index.js";

const exec = promisify(execCb);
const model = process.argv[2] || "haiku";

const cfg = loadAflConfig();
if (!cfg.authToken) {
  console.error("✗ ANTHROPIC_AUTH_TOKEN unset — source the gateway env first (e.g. /home/brokk/brokk.env)");
  process.exit(2);
}

const engine = new ForgeEngine({
  gatewayUrl: cfg.gatewayUrl,
  authToken: cfg.authToken,
  // Keep passes cheap — the heal scenario can't converge, so bound rounds tightly.
  maxRounds: 14,
});

/** Run a shell verify in the worktree (mirrors the runner's runVerify). */
async function runVerify(cmd: string, cwd: string): Promise<VerifyOutcome> {
  try {
    const { stdout, stderr } = await exec(cmd, { cwd, timeout: 60_000 });
    return { ok: true, output: `${stdout}\n${stderr}`.trim() };
  } catch (e: any) {
    return { ok: false, output: `${e?.stdout ?? ""}\n${e?.stderr ?? ""}\n${e?.message ?? e}`.trim() };
  }
}

async function newRepo(seed: Record<string, string>): Promise<string> {
  const cwd = await fs.mkdtemp(join(tmpdir(), "forge-vsmoke-"));
  for (const [name, content] of Object.entries(seed)) await fs.writeFile(join(cwd, name), content);
  await exec("git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm seed", { cwd });
  return cwd;
}

interface Capture {
  phases: string[];
  result: Awaited<ReturnType<ForgeEngine["run"]>>;
}

async function forge(
  cwd: string,
  task: AgentRunContext["task"],
  verifyCmd: string,
  maxHealAttempts: number,
): Promise<Capture> {
  const phases: string[] = [];
  const ctx: AgentRunContext = {
    task,
    run: { id: "vsmoke", branch: "smoke", model, authMode: "subscription" },
    cwd,
    model,
    authMode: "subscription",
    allowedTools: [],
    verify: () => runVerify(verifyCmd, cwd),
    maxHealAttempts,
    emit: (e: Omit<RunEvent, "id" | "runId" | "seq" | "at">) => {
      const p = e.payload as Record<string, unknown>;
      if (e.type === "status" && p?.phase) {
        const tag =
          p.phase === "verify_done"
            ? `verify_done(ok=${p.ok},r=${p.round})`
            : p.phase === "heal"
              ? `heal(${p.attempt}/${p.of})`
              : String(p.phase);
        phases.push(tag);
        process.stdout.write(`   · ${tag}\n`);
      }
    },
  };
  const result = await engine.run(ctx);
  return { phases, result };
}

let ok = true;
const t0 = Date.now();

// ── Scenario A: verify passes, no heal ───────────────────────────────────────
console.log("🔨 Scenario A — verify PASSES (no heal expected)\n");
const cwdA = await newRepo({ "README.md": "# scratch\n" });
const a = await forge(
  cwdA,
  {
    id: "A",
    title: "Add greeting file",
    body: "Create a file GREETING.md at the repo root containing exactly the line: Hello from Brokkr",
    labels: [],
    acceptance: "GREETING.md exists and contains 'Hello from Brokkr'",
  },
  "test -f GREETING.md && grep -qi 'hello from brokkr' GREETING.md",
  2,
);
const gitDirtyA = (await exec("git status --porcelain", { cwd: cwdA })).stdout.trim();
const commitsCleanA = await exec("git add -A && git -c user.email=t@t -c user.name=t commit -qm forge", {
  cwd: cwdA,
})
  .then(() => true)
  .catch(() => false);

const aChecks: [string, boolean][] = [
  ["verify is GREEN", a.result.verify?.ok === true],
  ["healAttempts = 0", a.result.healAttempts === 0],
  ["NO heal phase emitted", !a.phases.some((p) => p.startsWith("heal"))],
  ["worktree had the new file (dirty before commit)", gitDirtyA.includes("GREETING.md")],
  ["changes are commit-ready (runner would push this)", commitsCleanA],
];
console.log("");
for (const [n, p] of aChecks) {
  console.log(`  ${p ? "✓" : "✗"} ${n}`);
  if (!p) ok = false;
}
await fs.rm(cwdA, { recursive: true, force: true }).catch(() => {});

// ── Scenario B: verify always red → heal machinery fires and bounds ──────────
console.log("\n🔨 Scenario B — verify always RED (heal must fire ×1 then stop)\n");
const cwdB = await newRepo({ "README.md": "# scratch\n" });
const b = await forge(
  cwdB,
  {
    id: "B",
    title: "Add notes file",
    body: "Create a file NOTES.md at the repo root with a one-line description of this repo.",
    labels: [],
    acceptance: null,
  },
  "echo 'forced failure (heal-loop wiring test)'; exit 1",
  1, // maxHealAttempts
);
const verifyRounds = b.phases.filter((p) => p.startsWith("verify_done")).length;
const healFired = b.phases.filter((p) => p.startsWith("heal")).length;
const bChecks: [string, boolean][] = [
  ["verify is RED", b.result.verify?.ok === false],
  ["healAttempts = 1 (bounded by maxHealAttempts)", b.result.healAttempts === 1],
  ["heal phase emitted exactly once", healFired === 1],
  ["verify ran twice (initial + 1 re-verify after heal)", verifyRounds === 2],
];
console.log("");
for (const [n, p] of bChecks) {
  console.log(`  ${p ? "✓" : "✗"} ${n}`);
  if (!p) ok = false;
}
await fs.rm(cwdB, { recursive: true, force: true }).catch(() => {});

const secs = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\n──────── ${secs}s ────────`);
console.log(ok ? "✅ VERIFY→HEAL SMOKE PASSED" : "❌ VERIFY→HEAL SMOKE FAILED");
process.exit(ok ? 0 : 1);
