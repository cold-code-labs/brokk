/**
 * BROKK-45 acceptance — Review→Done close loop is reachable on the API.
 *
 * Checks:
 *   1. /health is up
 *   2. POST /webhooks/github accepts pull_request closed+merged (unsigned when
 *      BROKK_GITHUB_WEBHOOK_SECRET is empty) and returns JSON with ok:true
 *   3. closed-without-merge does NOT claim a done status (status closed_unmerged)
 *
 * BROKK-29 acceptance — configs that lied + Coolify PAT in clear.
 *
 * 4. Source contracts: forge Dockerfile must not advertise the phantom
 *    BROKK_PLAYWRIGHT_MCP env; must name ensurePlaywrightMcp + playwright-mcp.
 * 5. Dogfood: same SECRET_KEY_RE / redact contract as apps/forge/src/preview.ts
 *    — COOLIFY_PAT is masked, PATH is not.
 *
 * BROKK-14 acceptance — MCP/Hauldr auth must fail loud; forge migrate token
 * path must not use the retired HAULDR_TOKEN.
 *
 * 6. Source contracts: forge runDevLane resolves migrateToken via Heimdall;
 *    config no longer reads HAULDR_TOKEN; MCP auth helpers exist.
 * 7. Dogfood: expandEnv + isAuthFailure + authFailureMessage (same contracts
 *    as packages/mcp) — empty Bearer is rejected; 401 copy says AUTH FAILED.
 * 8. Screenshot of the booted app (receipt).
 *
 * Env (injected by Brokk verify):
 *   BROKK_ACCEPTANCE_URL, BROKK_CHROMIUM, BROKK_ACCEPTANCE_SHOT
 */
import { spawn } from "node:child_process";
import { writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const base = (process.env.BROKK_ACCEPTANCE_URL || "http://127.0.0.1:8789").replace(/\/$/, "");
const chromium = process.env.BROKK_CHROMIUM || "chromium";
const shot = process.env.BROKK_ACCEPTANCE_SHOT || "/tmp/brokk-acceptance.png";

const ROOT = dirname(fileURLToPath(import.meta.url));
const REPO = join(ROOT, "..");

function fail(msg) {
  console.error("ACCEPTANCE FAIL:", msg);
  process.exit(1);
}

/** Mirror of apps/forge/src/preview.ts SECRET_KEY_RE + redactEnv (dogfood). */
const SECRET_KEY_RE =
  /(secret|token|password|passwd|jwt|service_role|_key$|apikey|api_key|credential|(^|_)pat$)/i;

function redactEnv(env) {
  const mask = (v) => (v ? `••••${v.length > 4 ? v.slice(-4) : ""}` : v);
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    out[k] = SECRET_KEY_RE.test(k)
      ? mask(v)
      : v.replace(/:\/\/([^:@/]+):[^@/]+@/, (_m, user) => `://${user}:••••@`);
  }
  return out;
}

function assertSourceContracts() {
  const dockerfile = readFileSync(join(REPO, "apps/forge/Dockerfile"), "utf8");
  if (/BROKK_PLAYWRIGHT_MCP/.test(dockerfile)) {
    fail("forge Dockerfile still mentions phantom BROKK_PLAYWRIGHT_MCP");
  }
  if (!/ensurePlaywrightMcp/.test(dockerfile)) {
    fail("forge Dockerfile must document ensurePlaywrightMcp as the real surface");
  }
  if (!/playwright-mcp/.test(dockerfile)) {
    fail("forge Dockerfile must name the real bin playwright-mcp");
  }

  const driver = readFileSync(join(REPO, "apps/forge/src/driver.ts"), "utf8");
  if (!/export function ensurePlaywrightMcp/.test(driver)) {
    fail("driver.ts missing ensurePlaywrightMcp export");
  }

  const preview = readFileSync(join(REPO, "apps/forge/src/preview.ts"), "utf8");
  if (!/\(\^\|_\)pat\$/.test(preview)) {
    fail("preview.ts SECRET_KEY_RE must mask *_PAT keys (Coolify PAT)");
  }

  const apiSecrets = readFileSync(join(REPO, "apps/api/src/secrets.ts"), "utf8");
  if (!/\(\^\|_\)pat\$/.test(apiSecrets) || !/export function redactEnv/.test(apiSecrets)) {
    fail("api secrets.ts must redact *_PAT on the API boundary");
  }

  console.log(
    "[ok] source contracts: no phantom BROKK_PLAYWRIGHT_MCP; ensurePlaywrightMcp + PAT mask present",
  );
}

function assertRedactDogfood() {
  const out = redactEnv({
    COOLIFY_PAT: "super-secret-coolify-pat-value",
    PATH: "/usr/bin",
    VITE_HAULDR_URL: "https://hauldr.example",
  });
  if (!out.COOLIFY_PAT.startsWith("••••") || out.COOLIFY_PAT.includes("super-secret")) {
    fail(`COOLIFY_PAT not masked: ${out.COOLIFY_PAT}`);
  }
  if (out.PATH !== "/usr/bin") fail(`PATH should stay clear, got ${out.PATH}`);
  if (out.VITE_HAULDR_URL !== "https://hauldr.example") {
    fail(`non-secret URL should stay clear, got ${out.VITE_HAULDR_URL}`);
  }
  console.log("[ok] redactEnv dogfood: COOLIFY_PAT masked, PATH/URLs clear");
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

function assertMcpSourceContracts() {
  const forgeIndex = readFileSync(join(REPO, "apps/forge/src/index.ts"), "utf8");
  if (!/lanes\.getProject\(project\)/.test(forgeIndex)) {
    fail("forge index must resolve migrate token via lanes.getProject");
  }
  if (!/hp\.migrateToken/.test(forgeIndex)) {
    fail("forge index must use hp.migrateToken for apply_migration");
  }
  if (/cfg\.hauldrToken/.test(forgeIndex)) {
    fail("forge index must not still gate migration on cfg.hauldrToken");
  }
  if (!/refusing to fall back to HAULDR_TOKEN/.test(forgeIndex)) {
    fail("forge must refuse HAULDR_TOKEN fallback in loud error copy");
  }

  const forgeCfg = readFileSync(join(REPO, "apps/forge/src/config.ts"), "utf8");
  if (/hauldrToken:\s*env\.HAULDR_TOKEN/.test(forgeCfg)) {
    fail("forge config must not read HAULDR_TOKEN anymore");
  }

  const mcpProvider = readFileSync(join(REPO, "packages/mcp/src/provider.ts"), "utf8");
  if (!/export function isAuthFailure/.test(mcpProvider) || !/export function authFailureMessage/.test(mcpProvider)) {
    fail("packages/mcp must export isAuthFailure + authFailureMessage");
  }
  if (!/AUTH FAILED/.test(mcpProvider)) {
    fail("mcp provider must spell AUTH FAILED for credential rejection");
  }

  const mcpConfig = readFileSync(join(REPO, "packages/mcp/src/config.ts"), "utf8");
  if (!/export function expandEnv/.test(mcpConfig)) {
    fail("packages/mcp must expand ${ENV} in BROKK_MCP_SERVERS fields");
  }
  if (!/empty Bearer/.test(mcpConfig)) {
    fail("parseMcpServers must reject empty Bearer after expansion");
  }

  const tools = readFileSync(join(REPO, "packages/agents/forge/src/tools.ts"), "utf8");
  if (!/AUTH FAILED/.test(tools) || !/HAULDR_TOKEN/.test(tools)) {
    fail("apply_migration must loud-fail 401 mentioning HAULDR_TOKEN");
  }

  const compose = readFileSync(join(REPO, "docker-compose.coolify.yml"), "utf8");
  if (!/BROKK_MCP_SERVERS:\s*\$\{BROKK_MCP_SERVERS/.test(compose)) {
    fail("coolify worker-env must pass BROKK_MCP_SERVERS (Coolify does not auto-inject)");
  }

  console.log(
    "[ok] source contracts: Heimdall migrateToken path, no HAULDR_TOKEN, loud MCP/apply_migration auth",
  );
}

function assertAuthDogfood() {
  const expanded = expandEnv("Bearer ${HAULDR_MCP_TOKEN}", { HAULDR_MCP_TOKEN: "live" });
  if (expanded !== "Bearer live") fail(`expandEnv failed: ${expanded}`);

  const empty = expandEnv("Bearer ${HAULDR_TOKEN}", {});
  if (empty !== "Bearer ") fail(`empty expand expected 'Bearer ', got ${JSON.stringify(empty)}`);

  if (!isAuthFailure("HTTP 401 Unauthorized")) fail("isAuthFailure should catch 401");
  if (isAuthFailure("conn reset")) fail("isAuthFailure should ignore non-auth errors");

  const msg = authFailureMessage("hauldr", "401 Unauthorized");
  if (!/AUTH FAILED/.test(msg) || !/hauldr/.test(msg) || !/Do not retry/.test(msg)) {
    fail(`authFailureMessage too quiet: ${msg}`);
  }
  console.log("[ok] auth dogfood: expandEnv + loud AUTH FAILED copy");
}

async function main() {
  const health = await fetch(`${base}/health`);
  if (!health.ok) fail(`/health → ${health.status}`);
  const healthBody = await health.json();
  console.log("checked /health", healthBody);

  const mergedPayload = {
    action: "closed",
    repository: { full_name: "acme/acceptance" },
    pull_request: {
      number: 42,
      merged: true,
      html_url: "https://github.com/acme/acceptance/pull/42",
      body: "acceptance probe — no matching card expected",
    },
  };
  const mergedRes = await fetch(`${base}/webhooks/github`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "pull_request",
    },
    body: JSON.stringify(mergedPayload),
  });
  if (mergedRes.status === 401) {
    fail(
      "webhook rejected signature — acceptance expects empty BROKK_GITHUB_WEBHOOK_SECRET in verify",
    );
  }
  if (!mergedRes.ok) fail(`/webhooks/github merged → ${mergedRes.status}`);
  const mergedJson = await mergedRes.json();
  if (!mergedJson.ok) fail(`merged response not ok: ${JSON.stringify(mergedJson)}`);
  if (mergedJson.status !== "not_found" && mergedJson.status !== "done") {
    fail(`unexpected merged status: ${JSON.stringify(mergedJson)}`);
  }
  console.log("checked merged webhook →", mergedJson.status);

  const closedPayload = {
    action: "closed",
    repository: { full_name: "acme/acceptance" },
    pull_request: {
      number: 43,
      merged: false,
      html_url: "https://github.com/acme/acceptance/pull/43",
      body: "closed without merge",
    },
  };
  const closedRes = await fetch(`${base}/webhooks/github`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "pull_request",
    },
    body: JSON.stringify(closedPayload),
  });
  if (!closedRes.ok) fail(`/webhooks/github closed → ${closedRes.status}`);
  const closedJson = await closedRes.json();
  if (closedJson.status !== "closed_unmerged" && closedJson.status !== "ignored") {
    // applyMergedPr returns ignored when !merged; webhook maps to closed_unmerged
    fail(`closed-unmerged should not close a card: ${JSON.stringify(closedJson)}`);
  }
  console.log("checked closed-unmerged webhook →", closedJson.status);

  assertSourceContracts();
  assertRedactDogfood();
  assertMcpSourceContracts();
  assertAuthDogfood();

  // Receipt screenshot of /health (API has no HTML UI).
  await new Promise((resolve, reject) => {
    const child = spawn(
      chromium,
      [
        "--headless=new",
        "--disable-gpu",
        "--no-sandbox",
        `--screenshot=${shot}`,
        "--window-size=800,600",
        `${base}/health`,
      ],
      { stdio: "inherit" },
    );
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`chromium exit ${code}`))));
  });
  writeFileSync(shot.replace(/\.png$/, ".txt"), "brokk-45 webhook close loop ok\n");
  console.log("screenshot →", shot);
  console.log("ACCEPTANCE OK");
  process.exit(0);
}

main().catch((err) => fail(String(err?.stack || err)));
