// ─────────────────────────────────────────────────────────────────────────────
// "QA na conversa" (ADR 0054): register Playwright MCP for BOTH CLI lanes so a
// Sindri session can drive the live preview (http://forge.localhost:<port>).
//
// - claude-cli → `claude mcp add` (trusted user config)
// - cursor-cli → ~/.cursor/mcp.json + `agent --approve-mcps`
//
// Chromium + @playwright/mcp are baked into the chat image. Both point at the
// SHARED browser (--cdp-endpoint) that live-view screencasts.
// ─────────────────────────────────────────────────────────────────────────────
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CDP_ENDPOINT } from "./live-view.js";

/** The HOME the CLI lane resolves (must match, or the config isn't found). */
function cliHome(): string {
  const h = process.env.HOME;
  return process.env.BROKK_CLI_HOME || (h && h !== "/" ? h : "/home/brokk");
}

function playwrightMcpCommand(): { command: string; args: string[] } {
  return {
    command: "playwright-mcp",
    args: ["--cdp-endpoint", CDP_ENDPOINT],
  };
}

/** Write ~/.cursor/mcp.json so cursor-cli loads playwright-chat. */
function ensureCursorPlaywrightMcp(): boolean {
  try {
    const home = cliHome();
    const dir = join(home, ".cursor");
    mkdirSync(dir, { recursive: true });
    const { command, args } = playwrightMcpCommand();
    const body = {
      mcpServers: {
        "playwright-chat": {
          command,
          args,
        },
      },
    };
    writeFileSync(join(dir, "mcp.json"), `${JSON.stringify(body, null, 2)}\n`, "utf8");
    // Best-effort: mark approved so --approve-mcps isn't the only path.
    spawnSync("agent", ["mcp", "enable", "playwright-chat"], {
      env: { ...process.env, HOME: home },
      timeout: 15_000,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

/** Register the Playwright MCP pointed at the SHARED browser (--cdp-endpoint), so
 *  the agent drives the same chromium the live-view screencasts (ADR 0054). Force
 *  a fresh registration (remove then add) so an older "launch-own-browser" config
 *  from a prior image is replaced. Best-effort — no claude binary → still writes
 *  the Cursor mcp.json when possible. */
export function ensurePlaywrightMcp(): boolean {
  const env = { ...process.env, HOME: cliHome() };
  let claudeOk = false;
  // "playwright" is the pre-BROKK-19 shared name: the forge registers its own
  // Playwright MCP in this same user config (shared /home/brokk volume) but needs
  // a DIFFERENT browser, so a shared name made the two lanes clobber each other.
  // Sweep the legacy name and our own, then register ours.
  for (const stale of ["playwright", "playwright-chat"]) {
    spawnSync("claude", ["mcp", "remove", stale, "-s", "user"], {
      env,
      timeout: 20_000,
      stdio: "ignore",
    });
  }
  const { command, args } = playwrightMcpCommand();
  const add = spawnSync(
    "claude",
    ["mcp", "add", "playwright-chat", "-s", "user", "--", command, ...args],
    { env, timeout: 20_000, stdio: "ignore" },
  );
  claudeOk = add.status === 0;
  const cursorOk = ensureCursorPlaywrightMcp();
  return claudeOk || cursorOk;
}
