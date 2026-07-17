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
import { CDP_ENDPOINT } from "./live-view.js";

/** The HOME the CLI lane resolves (must match, or the config isn't found). */
function cliHome(): string {
  const h = process.env.HOME;
  return process.env.BROKK_CLI_HOME || (h && h !== "/" ? h : "/home/brokk");
}

/** Register the Playwright MCP pointed at the SHARED browser (--cdp-endpoint), so
 *  the agent drives the same chromium the live-view screencasts (ADR 0054). Force
 *  a fresh registration (remove then add) so an older "launch-own-browser" config
 *  from a prior image is replaced. Best-effort — no claude binary → returns false. */
export function ensurePlaywrightMcp(): boolean {
  const env = { ...process.env, HOME: cliHome() };
  spawnSync("claude", ["mcp", "remove", "playwright", "-s", "user"], {
    env,
    timeout: 20_000,
    stdio: "ignore",
  });
  const add = spawnSync(
    "claude",
    ["mcp", "add", "playwright", "-s", "user", "--", "playwright-mcp", "--cdp-endpoint", CDP_ENDPOINT],
    { env, timeout: 20_000, stdio: "ignore" },
  );
  return add.status === 0;
}
