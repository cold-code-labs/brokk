// ─────────────────────────────────────────────────────────────────────────────
// Driver turn — the agent DRIVES a live preview via the Playwright MCP (ADR 0054).
//
// Forge-local by decision: the browser runs where the preview binds (127.0.0.1
// in this container). The genuine Claude CLI is the brain; a stdio Playwright MCP
// is the hands.
//
// The MCP is REGISTERED in the CLI's user config (not passed via
// `--strict-mcp-config`): the flag path leaves a headless server ⏸ pending-
// approval, so its tools never load — a `claude mcp add` registration is trusted
// and loads in any cwd. Validated live (2026-07-17): the agent drove the maglink
// preview and created a project, confirmed in db_maglink_dev.
//
// Cancellation rides runClaudeCliTurn's abort, which signals the whole process
// group — so the CLI, the stdio MCP, and the chromium it launched all die
// together (no orphans). That IS the bg-task kill switch (ADR 0054).
// ─────────────────────────────────────────────────────────────────────────────
import { spawnSync } from "node:child_process";
import { runClaudeCliTurn, type AgentEvent, type CliTurnOutcome } from "@brokk/afl";

const MCP_NAME = "playwright";

/** The same HOME the CLI lane resolves (cliEnv): real + writable, never "/".
 *  Registration and the turn MUST agree or the config isn't found. */
function cliHome(): string {
  const h = process.env.HOME;
  return process.env.BROKK_CLI_HOME || (h && h !== "/" ? h : "/home/brokk");
}

/** Register the stdio Playwright MCP in the CLI user config, once. Idempotent:
 *  a no-op when already present. Throws only if a fresh registration fails. */
export function ensurePlaywrightMcp(chromiumPath: string): void {
  const env = { ...process.env, HOME: cliHome() };
  const present = spawnSync("claude", ["mcp", "get", MCP_NAME], {
    env,
    timeout: 20_000,
    stdio: "ignore",
  });
  if (present.status === 0) return;
  const add = spawnSync(
    "claude",
    [
      "mcp", "add", MCP_NAME, "-s", "user", "--",
      "playwright-mcp",
      "--headless",
      "--browser", "chromium",
      "--executable-path", chromiumPath,
      "--no-sandbox",
      "--isolated",
    ],
    { env, timeout: 20_000, stdio: "ignore" },
  );
  if (add.status !== 0) {
    throw new Error(`Playwright MCP registration failed (claude mcp add exited ${add.status})`);
  }
}

const DRIVER_SYSTEM =
  "You are Brokk's preview DRIVER. You operate a LIVE web app through the " +
  "Playwright MCP browser tools (mcp__playwright__*) ONLY — never edit files, " +
  "never use bash or curl to fetch pages, never git. Take a browser_snapshot to " +
  "read the page before acting, click and type via the tools, and report " +
  "concisely what you observed. If a step fails, say so plainly instead of " +
  "inventing success.";

export interface DriverTurnInput {
  /** Worktree of the app being driven — a real cwd keeps the CLI happy; the
   *  driver does not edit it. */
  cwd: string;
  /** The live preview URL the browser drives, e.g. http://127.0.0.1:4101 . */
  previewUrl: string;
  /** What to do, in plain language (acceptance-style instruction). */
  instruction: string;
  /** Chromium the MCP drives (BROKK_CHROMIUM / cfg.chromiumPath). */
  chromiumPath: string;
  model?: string;
  maxTurns?: number;
  timeoutMs?: number;
  /** Abort → the whole CLI process group is torn down (bg-task cancel). */
  signal?: AbortSignal;
  emit?: (e: AgentEvent) => void;
}

/** Run one driver turn: the agent drives `previewUrl` to satisfy `instruction`. */
export function runDriverTurn(input: DriverTurnInput): Promise<CliTurnOutcome> {
  ensurePlaywrightMcp(input.chromiumPath);
  const prompt =
    `The live app is at ${input.previewUrl} . Use the browser tools to do this:\n\n` +
    `${input.instruction}\n\n` +
    `Start by navigating there. If you land on a login screen, click the ` +
    `"Entrar como demo" button. End with a browser_snapshot and a one-paragraph ` +
    `report of whether you succeeded.`;
  return runClaudeCliTurn({
    cwd: input.cwd,
    prompt,
    model: input.model,
    appendSystem: DRIVER_SYSTEM,
    maxTurns: input.maxTurns ?? 50,
    timeoutMs: input.timeoutMs ?? 600_000,
    signal: input.signal,
    emit: input.emit,
  });
}
