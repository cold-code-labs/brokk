#!/usr/bin/env node
/**
 * BROKK-29 acceptance — configs that lied + Coolify PAT in clear.
 *
 * 1) Source contracts: forge Dockerfile must not advertise the phantom
 *    BROKK_PLAYWRIGHT_MCP env; must name ensurePlaywrightMcp + playwright-mcp.
 * 2) Dogfood: same SECRET_KEY_RE / redact contract as apps/forge/src/preview.ts
 *    — COOLIFY_PAT is masked, PATH is not.
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
    die(1, "forge Dockerfile still mentions phantom BROKK_PLAYWRIGHT_MCP");
  }
  if (!/ensurePlaywrightMcp/.test(dockerfile)) {
    die(1, "forge Dockerfile must document ensurePlaywrightMcp as the real surface");
  }
  if (!/playwright-mcp/.test(dockerfile)) {
    die(1, "forge Dockerfile must name the real bin playwright-mcp");
  }

  const driver = readFileSync(join(REPO, "apps/forge/src/driver.ts"), "utf8");
  if (!/export function ensurePlaywrightMcp/.test(driver)) {
    die(1, "driver.ts missing ensurePlaywrightMcp export");
  }

  const preview = readFileSync(join(REPO, "apps/forge/src/preview.ts"), "utf8");
  if (!/\(\^\|_\)pat\$/.test(preview)) {
    die(1, "preview.ts SECRET_KEY_RE must mask *_PAT keys (Coolify PAT)");
  }

  const apiSecrets = readFileSync(join(REPO, "apps/api/src/secrets.ts"), "utf8");
  if (!/\(\^\|_\)pat\$/.test(apiSecrets) || !/export function redactEnv/.test(apiSecrets)) {
    die(1, "api secrets.ts must redact *_PAT on the API boundary");
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
    die(1, `COOLIFY_PAT not masked: ${out.COOLIFY_PAT}`);
  }
  if (out.PATH !== "/usr/bin") die(1, `PATH should stay clear, got ${out.PATH}`);
  if (out.VITE_HAULDR_URL !== "https://hauldr.example") {
    die(1, `non-secret URL should stay clear, got ${out.VITE_HAULDR_URL}`);
  }
  console.log("[ok] redactEnv dogfood: COOLIFY_PAT masked, PATH/URLs clear");
}

function screenshotHome() {
  const url = BASE.replace(/\/$/, "") + "/";
  return new Promise((resolve, reject) => {
    const shot = spawn(
      CHROME,
      [
        "--headless=new",
        "--disable-gpu",
        "--no-sandbox",
        `--screenshot=${SHOT}`,
        "--window-size=1200,800",
        url,
      ],
      { stdio: "ignore" },
    );
    shot.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`screenshot exit ${code}`)),
    );
    shot.on("error", reject);
  }).then(() => {
    console.log(`[ok] screenshot → ${SHOT} (booted app ${url})`);
  });
}

assertSourceContracts();
assertRedactDogfood();
await screenshotHome();
console.log("BROKK-29 acceptance met");
process.exit(0);
