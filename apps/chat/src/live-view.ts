// ─────────────────────────────────────────────────────────────────────────────
// Live-view (ADR 0054) — watch the QA agent drive, live, in the preview pane.
//
// ONE shared headless chromium exposes a CDP endpoint. The Playwright MCP DRIVES
// it (registered with --cdp-endpoint) and this module SCREENCASTS it (CDP
// Page.startScreencast) — one browser, two views. Frames go out as
// multipart/x-mixed-replace (MJPEG), which a plain <img> renders natively: no
// WebSocket client, no canvas, no new dependency (node 22 ships WebSocket/fetch).
//
// The pane just points an <img> at /live/:session. That's the whole frontend.
// ─────────────────────────────────────────────────────────────────────────────
import { spawn, type ChildProcess } from "node:child_process";

const CDP_PORT = 9223;
export const CDP_ENDPOINT = `http://127.0.0.1:${CDP_PORT}`;
let proc: ChildProcess | null = null;
let relaunchTimer: ReturnType<typeof setTimeout> | null = null;
let chromiumPathCached =
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ||
  process.env.BROKK_CHROMIUM_PATH ||
  "/usr/bin/chromium";

/** The worker's HOME can be "/" (su-exec PID1 gotcha) — chromium then can't write
 *  its profile and dies on boot. Resolve a real, writable home like the CLI lane. */
function cliHome(): string {
  const h = process.env.HOME;
  return process.env.BROKK_CLI_HOME || (h && h !== "/" ? h : "/home/brokk");
}

function scheduleRelaunch(delayMs = 1_500): void {
  if (relaunchTimer) return;
  relaunchTimer = setTimeout(() => {
    relaunchTimer = null;
    console.warn("[chat] shared chromium watchdog — relaunching");
    startSharedBrowser(chromiumPathCached);
  }, delayMs);
  relaunchTimer.unref?.();
}

/** Launch (once) the shared browser the QA agent drives and we stream. Detached
 *  process group so tini reaps it; the MCP connects to it via --cdp-endpoint.
 *  Path: PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, else Debian `/usr/bin/chromium`,
 *  else Alpine `/usr/bin/chromium-browser` (BROKK-35).
 *  Exit → clear handle + watchdog relaunch (OpenCode/Playwright need CDP alive). */
export function startSharedBrowser(
  chromiumPath =
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ||
    process.env.BROKK_CHROMIUM_PATH ||
    "/usr/bin/chromium",
): void {
  if (proc) return;
  chromiumPathCached = chromiumPath;
  const home = cliHome();
  proc = spawn(
    chromiumPath,
    [
      "--headless=new",
      `--remote-debugging-port=${CDP_PORT}`,
      "--remote-debugging-address=127.0.0.1",
      "--no-sandbox",
      // Explicit writable profile dir — never fall back to $HOME/.config when
      // HOME is "/" (chromium would fail to start, silently with stdio: ignore).
      `--user-data-dir=${home}/.brokk-live-chrome`,
      "--hide-scrollbars",
      "--window-size=1280,800",
      "about:blank",
    ],
    {
      stdio: ["ignore", "ignore", "pipe"],
      detached: true,
      env: { ...process.env, HOME: home },
    },
  );
  let stderrTail = "";
  proc.stderr?.on("data", (d: Buffer) => {
    stderrTail = (stderrTail + d.toString()).slice(-800);
  });
  // Missing binary must not take down Chat (Alpine path vs Debian, etc.).
  proc.on("error", (err) => {
    console.error(`[chat] shared chromium failed (${chromiumPath}):`, err.message);
    proc = null;
    scheduleRelaunch(3_000);
  });
  proc.on("exit", (code, signal) => {
    console.warn(
      `[chat] shared chromium exited code=${code} signal=${signal}` +
        (stderrTail ? ` — ${stderrTail.trim().slice(0, 200)}` : ""),
    );
    proc = null;
    scheduleRelaunch();
  });
}

interface CdpTarget {
  type: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

/** The CDP websocket of the page the agent is driving: prefer a real app page
 *  over about:blank, else the newest. Retries — the page may still be coming up. */
async function activePageWs(): Promise<string | null> {
  for (let i = 0; i < 12; i++) {
    try {
      const list = (await fetch(`${CDP_ENDPOINT}/json`).then((r) => r.json())) as CdpTarget[];
      const pages = list.filter((t) => t.type === "page" && t.webSocketDebuggerUrl).reverse();
      const page = pages.find((p) => !p.url.startsWith("about:")) ?? pages[0];
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      /* browser not up yet — kick watchdog if the proc vanished */
      if (!proc) startSharedBrowser(chromiumPathCached);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return null;
}

/** True when the shared Chromium answers CDP `/json` (page list). */
export async function cdpReady(timeoutMs = 2_000): Promise<boolean> {
  startSharedBrowser();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const list = (await fetch(`${CDP_ENDPOINT}/json`).then((r) => r.json())) as unknown;
      if (Array.isArray(list)) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

/** Screencast the active page, calling `onFrame` with each JPEG. Returns stop().
 *  Best-effort: if there's no page yet it throws so the route can 503.
 *  On CDP WebSocket drop, one reconnect is attempted while the client is still
 *  attached (stop not called). */
export async function screencast(onFrame: (jpeg: Buffer) => void): Promise<() => void> {
  startSharedBrowser(); // idempotent — relaunch if it died
  let stopped = false;
  let ws: WebSocket | null = null;
  let id = 0;

  const attach = async (): Promise<void> => {
    const wsUrl = await activePageWs();
    if (!wsUrl) throw new Error("no active page to screencast");
    if (stopped) return;
    const sock = new WebSocket(wsUrl);
    ws = sock;
    const send = (method: string, params?: unknown) =>
      sock.readyState === sock.OPEN && sock.send(JSON.stringify({ id: ++id, method, params }));
    sock.addEventListener("open", () => {
      send("Page.enable");
      send("Page.startScreencast", {
        format: "jpeg",
        quality: 55,
        maxWidth: 1280,
        maxHeight: 800,
        everyNthFrame: 2,
      });
    });
    sock.addEventListener("message", (ev) => {
      let msg: { method?: string; params?: { data?: string; sessionId?: number } };
      try {
        msg = JSON.parse(typeof ev.data === "string" ? ev.data : "");
      } catch {
        return;
      }
      if (msg.method === "Page.screencastFrame" && msg.params?.data != null) {
        onFrame(Buffer.from(msg.params.data, "base64"));
        send("Page.screencastFrameAck", { sessionId: msg.params.sessionId });
      }
    });
    sock.addEventListener("close", () => {
      if (stopped) return;
      console.warn("[chat] screencast CDP closed — reconnecting once");
      startSharedBrowser(chromiumPathCached);
      setTimeout(() => {
        if (!stopped) void attach().catch((err) => {
          console.warn("[chat] screencast reconnect failed:", (err as Error).message);
        });
      }, 800);
    });
  };

  await attach();
  return () => {
    stopped = true;
    try {
      ws?.close();
    } catch {
      /* already closed */
    }
  };
}
