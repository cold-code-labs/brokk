/**
 * Live-acceptance receipt (Nv2 QA).
 *
 * After verify passes, if the card shipped an acceptance check at
 * `.brokk/acceptance.mjs`, boot the worktree app on an ephemeral port and run
 * that check against it — proving the change behaves, not just compiles. The
 * receipt (pass/fail + a screenshot) rides the PR and the board run-log.
 *
 * Contract with the check script (the agent writes it, per the forge prompt):
 *   - dependency-free Node ESM, driven by env:
 *       BROKK_ACCEPTANCE_URL   → base URL of the booted app (http://127.0.0.1:PORT)
 *       BROKK_CHROMIUM         → path to a headless Chromium binary
 *       BROKK_ACCEPTANCE_SHOT  → write a PNG screenshot here (optional but wanted)
 *   - exit 0 = acceptance met, non-zero = not met. stdout/stderr are the receipt.
 *
 * The screenshot path is OUTSIDE the worktree, so it is never committed — only
 * the check script itself rides the PR (so verify re-runs it forever).
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import type { AcceptanceReceipt } from "@brokk/core";
import { buildDetectCtx, composeCommand, resolveRuntime } from "@brokk/core/runtime";
import type { RunnerConfig } from "./config.js";

const CHECK_REL = ".brokk/acceptance.mjs";
/** Next cold-boot on busy Surtr often exceeds 90s; override via env. */
const BOOT_TIMEOUT_MS = Number(process.env.BROKK_ACCEPTANCE_BOOT_MS ?? 180_000);
const CHECK_TIMEOUT_MS = Number(process.env.BROKK_ACCEPTANCE_CHECK_MS ?? 120_000);
/** Cap the receipt screenshot so a base64 data URL stays reasonable in the event
 *  stream (jsonb + SSE). Chromium honours these as the viewport. */
const SHOT_W = 1000;
const SHOT_H = 700;

/** Ask the kernel for a free TCP port (bind :0, read it back, release). */
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

/** Poll the booted app until it answers HTTP (any status) or we give up. */
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

/**
 * Run the acceptance receipt in `wtPath`. Returns null when the card shipped no
 * check (non-UI card — nothing to prove). Never throws: a boot/check failure is
 * a red receipt, not a runner crash.
 */
export async function runAcceptanceReceipt(opts: {
  wtPath: string;
  cfg: RunnerConfig;
  /** Extra env for the booted app (e.g. per-app Hauldr secrets), so gated pages
   *  can actually render. Merged under the runner env. */
  bootEnv?: Record<string, string>;
  log?: (m: string) => void;
}): Promise<AcceptanceReceipt | null> {
  const { wtPath, cfg, bootEnv = {}, log = () => {} } = opts;
  const checkPath = join(wtPath, CHECK_REL);
  if (!existsSync(checkPath)) return null;

  const spec = await resolveRuntime(null, buildDetectCtx(wtPath));
  if (!spec.supported) {
    return {
      ran: true,
      ok: false,
      output: `acceptance skipped: no supported runtime to boot (${spec.reason ?? "unknown"})`,
    };
  }

  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const shot = join(cfg.workDir || "/tmp", `brokk-receipt-${port}.png`);
  const cmd = composeCommand(spec, "dev").replace(/\$PORT|\$\{PORT\}/g, String(port));

  log(`[acceptance] booting: ${cmd} (:${port})`);
  const proc = spawn("sh", ["-c", cmd], {
    cwd: wtPath,
    // CI=true for the same non-interactive-pnpm reason as verify: the boot command
    // re-runs `pnpm install`, and without a TTY pnpm would abort on a modules purge.
    env: { ...process.env, ...bootEnv, PORT: String(port), NODE_ENV: "development", CI: "true" },
    detached: true, // own process group, so we can kill the whole tree
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
        output: `acceptance app did not boot within ${BOOT_TIMEOUT_MS / 1000}s\n\n${bootLog}`,
      };
    }
    log(`[acceptance] up on :${port} — running ${CHECK_REL}`);

    const result = await new Promise<{ code: number; out: string }>((resolve) => {
      const check = spawn("node", [CHECK_REL], {
        cwd: wtPath,
        env: {
          ...process.env,
          ...bootEnv,
          BROKK_ACCEPTANCE_URL: url,
          BROKK_CHROMIUM: cfg.chromiumPath,
          BROKK_ACCEPTANCE_SHOT: shot,
          BROKK_SHOT_W: String(SHOT_W),
          BROKK_SHOT_H: String(SHOT_H),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      const grab = (d: Buffer) => {
        out = (out + d.toString()).slice(-8000);
      };
      check.stdout?.on("data", grab);
      check.stderr?.on("data", grab);
      const timer = setTimeout(() => {
        out += `\n[acceptance] check timed out after ${CHECK_TIMEOUT_MS / 1000}s`;
        check.kill("SIGKILL");
      }, CHECK_TIMEOUT_MS);
      check.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code: code ?? 1, out: out.trim() });
      });
      check.on("error", (err) => {
        clearTimeout(timer);
        resolve({ code: 1, out: `${out}\n[acceptance] check spawn error: ${err}`.trim() });
      });
    });

    let screenshot: string | undefined;
    if (existsSync(shot)) {
      try {
        const png = await readFile(shot);
        // ~1000×700 PNG is well under the 500KB comfort ceiling for a jsonb event.
        if (png.byteLength <= 800_000) {
          screenshot = `data:image/png;base64,${png.toString("base64")}`;
        } else {
          log(`[acceptance] screenshot too large (${png.byteLength}B) — dropping`);
        }
      } catch (err) {
        log(`[acceptance] screenshot read failed: ${err}`);
      }
      await rm(shot, { force: true }).catch(() => {});
    }

    return { ran: true, ok: result.code === 0, output: result.out, screenshot };
  } finally {
    kill();
  }
}
