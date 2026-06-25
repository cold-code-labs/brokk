#!/usr/bin/env tsx
// ─────────────────────────────────────────────────────────────────────────────
// Huginn smoke test — exercises the discovery scout in ISOLATION.
//
// No Sindri service, no api, no DB, no runner-secret dance: just the gateway +
// a checkout → a structured brief. The scout (@brokk/scout) runs on @brokk/afl
// (gateway + the shared bash hand) — nothing from @brokk/db — so this runs as a
// standalone tsx script against the live CCL gateway.
//
// For fun, it defaults to scouting Brokk's OWN repo — the raven surveys its nest.
//
// Usage (on a host with gateway env, e.g. surtr; from the repo root):
//   set -a; . /home/brokk/brokk.env; set +a
//   pnpm dlx tsx scripts/huginn-smoke.ts [checkoutDir] [repoFullName]
// Exit code 0 = pass, 1 = brief failed checks, 2 = misconfigured (no token).
// ─────────────────────────────────────────────────────────────────────────────

// Direct source imports (standalone, no build / no root workspace link needed).
// discovery.ts resolves its own `@brokk/afl` via packages/scout/node_modules.
import { loadAflConfig } from "../packages/afl/src/config.js";
import { runDiscovery } from "../packages/agents/scout/src/discovery.js";

const cwd = process.argv[2] || process.cwd();
const repoFullName = process.argv[3] || "cold-code-labs/brokk";

const cfg = loadAflConfig();
if (!cfg.authToken) {
  console.error("✗ ANTHROPIC_AUTH_TOKEN unset — source the gateway env first (e.g. /home/brokk/brokk.env)");
  process.exit(2);
}

console.log(`🪶 Huginn smoke test → scouting ${repoFullName}`);
console.log(`   checkout: ${cwd}`);
console.log(`   gateway:  ${cfg.gatewayUrl}   model: haiku\n`);

const t0 = Date.now();
let brief;
try {
  brief = await runDiscovery({
    cfg,
    cwd,
    repoFullName,
    model: "haiku",
    onProgress: (n) => process.stdout.write(`   · ${n}\n`),
  });
} catch (e) {
  console.error(`\n✗ scout threw: ${(e as Error)?.message ?? e}`);
  process.exit(1);
}
const secs = ((Date.now() - t0) / 1000).toFixed(1);

console.log(`\n──────── BRIEF (${secs}s) ────────`);
console.log(`mission: ${brief.mission}\n`);
console.log(`built (${brief.built.length}):`);
for (const b of brief.built.slice(0, 6)) console.log(`  ✅ ${b}`);
if (brief.built.length > 6) console.log(`  … +${brief.built.length - 6} more`);
console.log(`\nmissing (${brief.missing.length}):`);
for (const m of brief.missing) console.log(`  🧭 ${m}`);
console.log(`\nstack: ${brief.stack.join(", ")}`);

// The smoke test's pass criteria — a real, grounded brief, not an empty shell.
const checks: [string, boolean][] = [
  ["mission is substantive (>20 chars)", brief.mission.trim().length > 20],
  ["summary present", brief.summary.trim().length > 0],
  ["≥3 built items", brief.built.length >= 3],
  ["≥1 missing item (backlog fuel)", brief.missing.length >= 1],
  ["≥1 stack item", brief.stack.length >= 1],
];
console.log("\n──────── CHECKS ────────");
let ok = true;
for (const [name, pass] of checks) {
  console.log(`  ${pass ? "✓" : "✗"} ${name}`);
  if (!pass) ok = false;
}
console.log(ok ? "\n✅ SMOKE TEST PASSED" : "\n❌ SMOKE TEST FAILED");
process.exit(ok ? 0 : 1);
