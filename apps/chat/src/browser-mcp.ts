// ─────────────────────────────────────────────────────────────────────────────
// "QA na conversa" (ADR 0054): register the stdio Playwright MCP in the CLI user
// config so a claude-cli Sindri session has the browser tools and can drive the
// live preview (at http://forge:<port>) to do a visual / GUI / QA review right in
// the conversation. Chromium + @playwright/mcp are baked into the chat image.
//
// Registered via `claude mcp add` (trusted user config) — NOT --mcp-config, whose
// headless servers stay ⏸ pending-approval so their tools never load (learned the
// hard way in the forge driver, ADR 0054).
// ─────────────────────────────────────────────────────────────────────────────
import { spawnSync } from "node:child_process";

/** The HOME the CLI lane resolves (must match, or the config isn't found). */
function cliHome(): string {
  const h = process.env.HOME;
  return process.env.BROKK_CLI_HOME || (h && h !== "/" ? h : "/home/brokk");
}

/** Idempotently register the Playwright MCP. Best-effort: a chat runner without
 *  the claude binary / chromium just skips it (returns false). */
export function ensurePlaywrightMcp(chromiumPath = "/usr/bin/chromium-browser"): boolean {
  const env = { ...process.env, HOME: cliHome() };
  const present = spawnSync("claude", ["mcp", "get", "playwright"], {
    env,
    timeout: 20_000,
    stdio: "ignore",
  });
  if (present.status === 0) return true;
  const add = spawnSync(
    "claude",
    [
      "mcp", "add", "playwright", "-s", "user", "--",
      "playwright-mcp",
      "--headless",
      "--browser", "chromium",
      "--executable-path", chromiumPath,
      "--no-sandbox",
      "--isolated",
    ],
    { env, timeout: 20_000, stdio: "ignore" },
  );
  return add.status === 0;
}
