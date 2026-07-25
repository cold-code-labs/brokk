/**
 * E2E gate (UI / behaviour) — market-shaped.
 *
 * After verify passes, Brokk boots the card worktree on an ephemeral port and
 * runs the repo's E2E command. Priority:
 *   1. `.brokk/profile.json` → `commands.e2e`
 *   2. `playwright.config.*` → `pnpm exec playwright test`
 *   3. Legacy `.brokk/acceptance.mjs` (compat)
 *
 * Env injected for the check:
 *   PLAYWRIGHT_BASE_URL / BASE_URL / BROKK_ACCEPTANCE_URL → http://127.0.0.1:PORT
 *   BROKK_CHROMIUM / PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH → headless Chromium
 *   BROKK_ACCEPTANCE_SHOT → optional PNG path (legacy scripts)
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import type { AcceptanceReceipt } from "@brokk/core";
import { buildDetectCtx, composeCommand, resolveRuntime } from "@brokk/core/runtime";
import type { RunnerConfig } from "./config.js";
import { resolveE2eGate, type E2eGate } from "./profile.js";

const LEGACY_CHECK_REL = ".brokk/acceptance.mjs";
const BOOT_TIMEOUT_MS = Number(process.env.BROKK_E2E_BOOT_MS || process.env.BROKK_ACCEPTANCE_BOOT_MS) || 180_000;
const CHECK_TIMEOUT_MS = Number(process.env.BROKK_E2E_CHECK_MS || process.env.BROKK_ACCEPTANCE_CHECK_MS) || 120_000;
const SHOT_W = 1000;
const SHOT_H = 700;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error("no port"))));
    });
  });
}

async function waitForHttp(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 3000);
      await fetch(url, { signal: ctrl.signal });
      clearTimeout(t);
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  return false;
}

/** Next.js 16 registers a running `next dev` in `.next/dev/lock` (pid/port/url);
 *  a second `next dev` in the same dir reads that lock and REFUSES to bind the
 *  requested port — it points at the already-running server instead ("Another
 *  next dev server is already running"). On the forge that silently broke the
 *  acceptance gate: the app booted in <1s but on the OLD port, so the harness
 *  polled the assigned port and timed out at 180s — the #1 failure bucket. Clear
 *  a stale lock (and kill its process) before booting so `next dev -p $PORT`
 *  owns a fresh instance. Best-effort: absent lock / other runtimes → no-op. */
async function clearStaleNextDev(appDir: string, log: (m: string) => void): Promise<void> {
  const devDir = join(appDir, ".next", "dev");
  const lock = join(devDir, "lock");
  if (!existsSync(lock)) return;
  try {
    const raw = await readFile(lock, "utf8");
    const pid = Number(JSON.parse(raw)?.pid);
    if (Number.isInteger(pid) && pid > 1) {
      try {
        process.kill(pid, "SIGKILL");
        log(`[e2e] killed stale next dev (pid ${pid}) from .next/dev/lock`);
      } catch {
        /* already gone */
      }
    }
  } catch {
    /* unreadable/legacy lock — removing the dir below is enough */
  }
  await rm(devDir, { recursive: true, force: true }).catch(() => {});
  log("[e2e] cleared stale .next/dev registry before boot");
}

/** True when the worktree declares an E2E gate (profile, Playwright, or legacy). */
export async function e2eGateExists(wtPath: string): Promise<boolean> {
  const gate = await resolveE2eGate(wtPath);
  return gate.source !== "none";
}

/** @deprecated Prefer `e2eGateExists` — kept for call-site clarity during rename. */
export async function acceptanceCheckExists(wtPath: string): Promise<boolean> {
  return e2eGateExists(wtPath);
}

export type E2eReceipt = AcceptanceReceipt & { source?: E2eGate["source"] };

/**
 * Run the E2E gate in `wtPath`. Returns null when no gate is configured.
 * Never throws: boot/check failure → red receipt.
 */
export async function runE2eGate(opts: {
  wtPath: string;
  cfg: RunnerConfig;
  bootEnv?: Record<string, string>;
  log?: (m: string) => void;
}): Promise<E2eReceipt | null> {
  const { wtPath, cfg, bootEnv = {}, log = () => {} } = opts;
  const gate = await resolveE2eGate(wtPath);
  if (gate.source === "none") return null;

  const spec = await resolveRuntime(null, buildDetectCtx(wtPath));
  if (!spec.supported) {
    return {
      ran: true,
      ok: false,
      source: gate.source,
      output: `e2e skipped: no supported runtime to boot (${spec.reason ?? "unknown"})`,
    };
  }

  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const shot = join(cfg.workDir || "/tmp", `brokk-e2e-${port}.png`);
  const cmd = composeCommand(spec, "dev").replace(/\$PORT|\$\{PORT\}/g, String(port));

  const appDir = spec.appRoot ? join(wtPath, spec.appRoot) : wtPath;
  for (const f of spec.prepareFiles ?? []) {
    const dest = join(appDir, f.path);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, f.contents);
    log(`[e2e] wrote prepare file ${f.path}`);
  }

  // Next 16 dev-server-reuse would otherwise redirect this boot to a stale
  // instance on a different port and hang the poll → false "did not boot".
  await clearStaleNextDev(appDir, log);

  log(`[e2e] source=${gate.source} booting: ${cmd} (:${port})`);
  const proc = spawn("sh", ["-c", cmd], {
    cwd: wtPath,
    env: { ...process.env, ...bootEnv, PORT: String(port), NODE_ENV: "development", CI: "true" },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let bootLog = "";
  const cap = (d: Buffer) => {
    bootLog = (bootLog + d.toString()).slice(-4000);
  };
  proc.stdout?.on("data", cap);
  proc.stderr?.on("data", cap);

  const kill = () => {
    try {
      if (proc.pid) process.kill(-proc.pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  };

  try {
    const ready = await waitForHttp(url, BOOT_TIMEOUT_MS);
    if (!ready) {
      return {
        ran: true,
        ok: false,
        source: gate.source,
        output: `e2e app did not boot within ${BOOT_TIMEOUT_MS / 1000}s\n\n${bootLog}`,
      };
    }
    log(`[e2e] up on :${port} — running ${gate.cmd}`);

    const checkEnv: Record<string, string> = {
      ...process.env,
      ...bootEnv,
      PLAYWRIGHT_BASE_URL: url,
      BASE_URL: url,
      BROKK_ACCEPTANCE_URL: url,
      BROKK_CHROMIUM: cfg.chromiumPath,
      PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: cfg.chromiumPath,
      BROKK_ACCEPTANCE_SHOT: shot,
      BROKK_SHOT_W: String(SHOT_W),
      BROKK_SHOT_H: String(SHOT_H),
      CI: "true",
    };

    const result = await new Promise<{ code: number; out: string }>((resolve) => {
      const check =
        gate.source === "legacy-acceptance"
          ? spawn("node", [LEGACY_CHECK_REL], {
              cwd: wtPath,
              env: checkEnv,
              stdio: ["ignore", "pipe", "pipe"],
            })
          : spawn("sh", ["-c", gate.cmd], {
              cwd: wtPath,
              env: checkEnv,
              stdio: ["ignore", "pipe", "pipe"],
            });
      let out = "";
      const grab = (d: Buffer) => {
        out = (out + d.toString()).slice(-8000);
      };
      check.stdout?.on("data", grab);
      check.stderr?.on("data", grab);
      const timer = setTimeout(() => {
        out += `\n[e2e] check timed out after ${CHECK_TIMEOUT_MS / 1000}s`;
        check.kill("SIGKILL");
      }, CHECK_TIMEOUT_MS);
      check.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code: code ?? 1, out: out.trim() });
      });
      check.on("error", (err) => {
        clearTimeout(timer);
        resolve({ code: 1, out: `${out}\n[e2e] check spawn error: ${err}`.trim() });
      });
    });

    let screenshot: string | undefined;
    if (existsSync(shot)) {
      try {
        const png = await readFile(shot);
        if (png.byteLength <= 800_000) {
          screenshot = `data:image/png;base64,${png.toString("base64")}`;
        } else {
          log(`[e2e] screenshot too large (${png.byteLength}B) — dropping`);
        }
      } catch (err) {
        log(`[e2e] screenshot read failed: ${err}`);
      }
      await rm(shot, { force: true }).catch(() => {});
    }

    return {
      ran: true,
      ok: result.code === 0,
      output: result.out,
      screenshot,
      source: gate.source,
    };
  } finally {
    kill();
  }
}

/** @deprecated Prefer `runE2eGate`. */
export const runAcceptanceReceipt = runE2eGate;
