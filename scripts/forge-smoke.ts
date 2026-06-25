#!/usr/bin/env tsx
// ─────────────────────────────────────────────────────────────────────────────
// Forge smoke test — exercises Brokkr (@brokk/forge) in ISOLATION.
//
// No control plane, no DB, no git/gh, no runner-secret dance: just the gateway +
// a throwaway worktree → a real file written by the agent. Proves the native loop
// (@brokk/afl runAgentLoop + the shared hands) drives tools to completion, with
// NO Agent SDK in the path. This is the standalone analogue of the dev-lane
// "1 card → real PR" smoke.
//
// Usage (on a host with gateway env, e.g. surtr; from the repo root):
//   set -a; . /home/brokk/brokk.env; set +a
//   pnpm dlx tsx scripts/forge-smoke.ts [model]
// Exit code 0 = pass, 1 = forge failed checks, 2 = misconfigured (no token).
// ─────────────────────────────────────────────────────────────────────────────

import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRunContext, RunEvent } from "../packages/core/src/index.js";
import { loadChatConfig } from "../packages/afl/src/config.js";
import { ForgeEngine } from "../packages/forge/src/index.js";

const model = process.argv[2] || "haiku";

const cfg = loadChatConfig();
if (!cfg.authToken) {
  console.error("✗ ANTHROPIC_AUTH_TOKEN unset — source the gateway env first (e.g. /home/brokk/brokk.env)");
  process.exit(2);
}

const cwd = await fs.mkdtemp(join(tmpdir(), "forge-smoke-"));
// Seed a believable tiny project so the agent has a repo to act in.
await fs.writeFile(join(cwd, "README.md"), "# scratch\nA throwaway project for the forge smoke test.\n");

console.log("🔨 Forge smoke test → Brokkr writes a file");
console.log(`   worktree: ${cwd}`);
console.log(`   gateway:  ${cfg.gatewayUrl}   model: ${model}\n`);

const engine = new ForgeEngine({ gatewayUrl: cfg.gatewayUrl, authToken: cfg.authToken });

const seen = { toolUse: 0, message: 0, usageIn: 0, usageOut: 0 };
const ctx: AgentRunContext = {
  task: {
    id: "smoke-1",
    title: "Add a greeting file",
    body: "Create a new file named GREETING.md at the repo root containing exactly the line: Hello from Brokkr",
    labels: [],
    acceptance: null,
  },
  run: { id: "run-smoke-1", branch: "smoke", model, authMode: "subscription" },
  cwd,
  model,
  authMode: "subscription",
  allowedTools: [],
  emit: (e: Omit<RunEvent, "id" | "runId" | "seq" | "at">) => {
    const p = e.payload as Record<string, unknown>;
    if (process.env.DEBUG_FORGE) process.stdout.write(`   [ev ${e.type}] ${JSON.stringify(p).slice(0, 200)}\n`);
    if (e.type === "status") process.stdout.write(`   · ${String(p?.phase)}${p?.stop ? ` (stop=${p.stop} rounds=${p.rounds})` : ""}\n`);
    if (e.type === "tool_use") {
      seen.toolUse++;
      process.stdout.write(`     ↳ ${String(p?.name)}\n`);
    }
    if (e.type === "message") seen.message++;
    if (e.type === "usage") {
      seen.usageIn += Number(p?.input_tokens ?? 0);
      seen.usageOut += Number(p?.output_tokens ?? 0);
    }
  },
};

const t0 = Date.now();
let result;
try {
  result = await engine.run(ctx);
} catch (e) {
  console.error(`\n✗ forge threw: ${(e as Error)?.message ?? e}`);
  process.exit(1);
}
const secs = ((Date.now() - t0) / 1000).toFixed(1);

let greeting = "";
try {
  greeting = (await fs.readFile(join(cwd, "GREETING.md"), "utf8")).trim();
} catch {
  /* missing → check fails below */
}

console.log(`\n──────── RESULT (${secs}s) ────────`);
console.log(`tokens: in ${result.usage.tokensIn} / out ${result.usage.tokensOut}`);
console.log(`tool calls: ${seen.toolUse} · assistant rounds: ${seen.message}`);
console.log(`GREETING.md: ${greeting ? JSON.stringify(greeting) : "(missing)"}`);

const checks: [string, boolean][] = [
  ["agent called ≥1 tool", seen.toolUse >= 1],
  ["GREETING.md was created", greeting.length > 0],
  ["file contains the greeting", /hello from brokkr/i.test(greeting)],
  ["usage was reported (in>0)", result.usage.tokensIn > 0 || seen.usageIn > 0],
];
console.log("\n──────── CHECKS ────────");
let ok = true;
for (const [name, pass] of checks) {
  console.log(`  ${pass ? "✓" : "✗"} ${name}`);
  if (!pass) ok = false;
}

await fs.rm(cwd, { recursive: true, force: true }).catch(() => {});
console.log(ok ? "\n✅ SMOKE TEST PASSED" : "\n❌ SMOKE TEST FAILED");
process.exit(ok ? 0 : 1);
