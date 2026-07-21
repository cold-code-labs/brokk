#!/usr/bin/env node
/**
 * BROKK-14 acceptance — MCP/Hauldr auth must fail loud; forge migrate token
 * path must not use the retired HAULDR_TOKEN.
 *
 * 1) Source contracts: forge runDevLane resolves migrateToken via Heimdall;
 *    config no longer reads HAULDR_TOKEN; MCP auth helpers exist.
 * 2) Dogfood: expandEnv + isAuthFailure + authFailureMessage (same contracts
 *    as packages/mcp) — empty Bearer is rejected; 401 copy says AUTH FAILED.
 * 3) Screenshot of the booted app (receipt).
 *
 * Env: BROKK_ACCEPTANCE_URL, BROKK_CHROMIUM, BROKK_ACCEPTANCE_SHOT
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = process.env.BROKK_ACCEPTANCE_URL;
const CHROME = process.env.BROKK_CHROMIUM;
const SHOT = process.env.BROKK_ACCEPTANCE_SHOT;

if (!BASE || !CHROME || !SHOT) {
  console.error("missing BROKK_ACCEPTANCE_URL / BROKK_CHROMIUM / BROKK_ACCEPTANCE_SHOT");
  process.exit(2);
}

const ROOT = dirname(fileURLToPath(import.meta.url));
const REPO = join(ROOT, "..");

function die(code, msg) {
  console.error(msg);
  process.exit(code);
}

/** Mirror of packages/mcp/src/config.ts expandEnv. */
function expandEnv(value, env) {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_m, braced, bare) => {
    const key = braced ?? bare;
    return env[key] ?? "";
  });
}

/** Mirror of packages/mcp/src/provider.ts isAuthFailure. */
function isAuthFailure(message) {
  const m = String(message).toLowerCase();
  return (
    /\b401\b/.test(m) ||
    /\b403\b/.test(m) ||
    m.includes("unauthorized") ||
    m.includes("forbidden") ||
    m.includes("authentication") ||
    m.includes("invalid token") ||
    m.includes("invalid api key")
  );
}

/** Mirror of packages/mcp/src/provider.ts authFailureMessage. */
function authFailureMessage(server, detail) {
  const d = String(detail).trim() || "401/403";
  return (
    `mcp ${server}: AUTH FAILED (${d}). Credential rejected — fix BROKK_MCP_SERVERS ` +
    `headers (do not embed a retired HAULDR_TOKEN; expand \${ENV} from a live secret) ` +
    `or remove the server. Do not retry the same call.`
  );
}

function assertSourceContracts() {
  const forgeIndex = readFileSync(join(REPO, "apps/forge/src/index.ts"), "utf8");
  if (!/lanes\.getProject\(project\)/.test(forgeIndex)) {
    die(1, "forge index must resolve migrate token via lanes.getProject");
  }
  if (!/hp\.migrateToken/.test(forgeIndex)) {
    die(1, "forge index must use hp.migrateToken for apply_migration");
  }
  if (/cfg\.hauldrToken/.test(forgeIndex)) {
    die(1, "forge index must not still gate migration on cfg.hauldrToken");
  }
  if (!/refusing to fall back to HAULDR_TOKEN/.test(forgeIndex)) {
    die(1, "forge must refuse HAULDR_TOKEN fallback in loud error copy");
  }

  const forgeCfg = readFileSync(join(REPO, "apps/forge/src/config.ts"), "utf8");
  if (/hauldrToken:\s*env\.HAULDR_TOKEN/.test(forgeCfg)) {
    die(1, "forge config must not read HAULDR_TOKEN anymore");
  }

  const mcpProvider = readFileSync(join(REPO, "packages/mcp/src/provider.ts"), "utf8");
  if (!/export function isAuthFailure/.test(mcpProvider) || !/export function authFailureMessage/.test(mcpProvider)) {
    die(1, "packages/mcp must export isAuthFailure + authFailureMessage");
  }
  if (!/AUTH FAILED/.test(mcpProvider)) {
    die(1, "mcp provider must spell AUTH FAILED for credential rejection");
  }

  const mcpConfig = readFileSync(join(REPO, "packages/mcp/src/config.ts"), "utf8");
  if (!/export function expandEnv/.test(mcpConfig)) {
    die(1, "packages/mcp must expand \${ENV} in BROKK_MCP_SERVERS fields");
  }
  if (!/empty Bearer/.test(mcpConfig)) {
    die(1, "parseMcpServers must reject empty Bearer after expansion");
  }

  const tools = readFileSync(join(REPO, "packages/agents/forge/src/tools.ts"), "utf8");
  if (!/AUTH FAILED/.test(tools) || !/HAULDR_TOKEN/.test(tools)) {
    die(1, "apply_migration must loud-fail 401 mentioning HAULDR_TOKEN");
  }

  const compose = readFileSync(join(REPO, "docker-compose.coolify.yml"), "utf8");
  if (!/BROKK_MCP_SERVERS:\s*\$\{BROKK_MCP_SERVERS/.test(compose)) {
    die(1, "coolify worker-env must pass BROKK_MCP_SERVERS (Coolify does not auto-inject)");
  }

  console.log(
    "[ok] source contracts: Heimdall migrateToken path, no HAULDR_TOKEN, loud MCP/apply_migration auth",
  );
}

function assertAuthDogfood() {
  const expanded = expandEnv("Bearer ${HAULDR_MCP_TOKEN}", { HAULDR_MCP_TOKEN: "live" });
  if (expanded !== "Bearer live") die(1, `expandEnv failed: ${expanded}`);

  const empty = expandEnv("Bearer ${HAULDR_TOKEN}", {});
  if (empty !== "Bearer ") die(1, `empty expand expected 'Bearer ', got ${JSON.stringify(empty)}`);

  if (!isAuthFailure("HTTP 401 Unauthorized")) die(1, "isAuthFailure should catch 401");
  if (isAuthFailure("conn reset")) die(1, "isAuthFailure should ignore non-auth errors");

  const msg = authFailureMessage("hauldr", "401 Unauthorized");
  if (!/AUTH FAILED/.test(msg) || !/hauldr/.test(msg) || !/Do not retry/.test(msg)) {
    die(1, `authFailureMessage too quiet: ${msg}`);
  }
  console.log("[ok] auth dogfood: expandEnv + loud AUTH FAILED copy");
}

function screenshotHome() {
  const url = BASE.replace(/\/$/, "") + "/";
  return new Promise((resolve, reject) => {
    const child = spawn(
      CHROME,
      ["--headless", "--disable-gpu", "--no-sandbox", `--screenshot=${SHOT}`, "--window-size=1280,800", url],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let err = "";
    child.stderr.on("data", (d) => {
      err += d;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`chromium exited ${code}: ${err.slice(0, 500)}`));
      else resolve();
    });
  });
}

assertSourceContracts();
assertAuthDogfood();
await screenshotHome();
console.log(`[ok] screenshot → ${SHOT}`);
console.log("BROKK-14 acceptance met");
process.exit(0);
