// ─────────────────────────────────────────────────────────────────────────────
// Playwright MCP server — the browser HANDS for a driver session (ADR 0054).
//
// Runs INSIDE the forge, the only network namespace that reaches a live preview
// (previews bind 127.0.0.1:<port> in this container). The chat (Sindri) mounts
// these tools over http via the MCP bridge; the agent stays the brain, this is
// only the hands.
//
// Opt-in via BROKK_PLAYWRIGHT_MCP — inert on an ordinary runner. Binds 127.0.0.1
// by default: only the forge itself drives it. Exposing it on the shared network
// (host 0.0.0.0) needs a deliberate access story — the gate lives at our
// boundary, never in the browser tool.
//
// Teardown kills the whole PROCESS GROUP, not just the server pid: the MCP server
// spawns chromium children that a bare SIGKILL on the pid would orphan. This is
// ADR 0054's central lesson ("cancel the bg task = kill(-pgid)"), applied here at
// the server's own lifecycle.
// ─────────────────────────────────────────────────────────────────────────────
import { spawn, type ChildProcess } from "node:child_process";

export interface PlaywrightMcpHandle {
  readonly url: string;
  stop(): void;
}

export function startPlaywrightMcp(opts: {
  host: string;
  port: number;
  chromiumPath: string;
  log?: (m: string) => void;
}): PlaywrightMcpHandle {
  const log = opts.log ?? (() => {});
  // `playwright-mcp` is the bin of the globally-installed @playwright/mcp
  // (baked into the forge image). `--isolated` = no persisted profile, so each
  // driver session is throwaway; system chromium via --executable-path (Alpine
  // can't run Playwright's own download — same reason as the verify lane).
  const proc: ChildProcess = spawn(
    "playwright-mcp",
    [
      "--port", String(opts.port),
      "--host", opts.host,
      "--headless",
      "--browser", "chromium",
      "--executable-path", opts.chromiumPath,
      "--no-sandbox",
      "--isolated",
    ],
    // detached → its own process group, so stop() can signal the chromium
    // children too instead of orphaning them.
    { stdio: ["ignore", "pipe", "pipe"], detached: true },
  );
  proc.stdout?.on("data", (b) => log(`[playwright-mcp] ${String(b).trimEnd()}`));
  proc.stderr?.on("data", (b) => log(`[playwright-mcp] ${String(b).trimEnd()}`));
  proc.on("exit", (code, signal) =>
    log(`[playwright-mcp] exited (code=${code ?? "null"} signal=${signal ?? "null"})`),
  );

  let stopped = false;
  const stop = () => {
    if (stopped || proc.pid == null) return;
    stopped = true;
    const pgid = proc.pid; // detached: pid === pgid
    try {
      process.kill(-pgid, "SIGTERM");
    } catch {
      /* group already gone */
    }
    setTimeout(() => {
      try {
        process.kill(-pgid, "SIGKILL");
      } catch {
        /* group already gone */
      }
    }, 5_000).unref?.();
  };

  return { url: `http://${opts.host}:${opts.port}/mcp`, stop };
}
