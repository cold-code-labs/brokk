#!/usr/bin/env node
/**
 * BROKK-39 acceptance — floor drill-in opens Live run log with thinking + tools.
 *
 * Env:
 *   BROKK_ACCEPTANCE_URL   base URL of the booted app
 *   BROKK_CHROMIUM         headless Chromium binary
 *   BROKK_ACCEPTANCE_SHOT  PNG path for the receipt screenshot
 */
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const BASE = process.env.BROKK_ACCEPTANCE_URL;
const CHROME = process.env.BROKK_CHROMIUM;
const SHOT = process.env.BROKK_ACCEPTANCE_SHOT;

if (!BASE || !CHROME || !SHOT) {
  console.error("missing BROKK_ACCEPTANCE_URL / BROKK_CHROMIUM / BROKK_ACCEPTANCE_SHOT");
  process.exit(2);
}

const TARGET = `${BASE.replace(/\/$/, "")}/brokk/observer`;

function die(code, msg) {
  console.error(msg);
  process.exit(code);
}

/** Minimal CDP over WebSocket — dependency-free. */
async function withCdp(wsUrl, fn) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve);
    ws.addEventListener("error", reject);
  });
  let nextId = 1;
  const pending = new Map();
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(String(ev.data));
    if (msg.id != null && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  });
  const send = (method, params = {}) => {
    const id = nextId++;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  };
  try {
    return await fn(send);
  } finally {
    ws.close();
  }
}

async function waitForDevtools(stderrBuf) {
  for (let i = 0; i < 50; i++) {
    await sleep(100);
    const m = stderrBuf.text.match(/DevTools listening on (ws:\/\/\S+)/);
    if (m) return m[1];
  }
  return null;
}

async function main() {
  const chrome = spawn(
    CHROME,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--remote-debugging-port=0",
      "--window-size=1280,800",
      "about:blank",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  const stderrBuf = { text: "" };
  chrome.stderr.setEncoding("utf8");
  chrome.stderr.on("data", (c) => {
    stderrBuf.text += c;
  });

  const browserWs = await waitForDevtools(stderrBuf);
  if (!browserWs) {
    chrome.kill("SIGKILL");
    die(1, `chromium did not expose DevTools:\n${stderrBuf.text.slice(-800)}`);
  }

  const host = new URL(browserWs).host;

  try {
    // Open a page target pointed at the fixture route.
    const created = await fetch(`http://${host}/json/new?${encodeURIComponent(TARGET)}`, {
      method: "PUT",
    }).then((r) => r.json());
    const pageWs = created.webSocketDebuggerUrl;
    if (!pageWs) die(1, `no page websocket: ${JSON.stringify(created)}`);

    await withCdp(pageWs, async (send) => {
      await send("Page.enable");
      await send("Runtime.enable");
      await send("Page.navigate", { url: TARGET });

      let ready = false;
      for (let i = 0; i < 40; i++) {
        await sleep(250);
        const { result } = await send("Runtime.evaluate", {
          expression: `!!document.querySelector('[data-testid="forge-floor-row"]')`,
          returnByValue: true,
        });
        if (result?.value) {
          ready = true;
          break;
        }
      }
      if (!ready) die(1, "floor row never appeared on /brokk/observer");
      console.log("checked: forge floor row is present and clickable");

      await send("Runtime.evaluate", {
        expression: `document.querySelector('[data-testid="forge-floor-row"]').click()`,
      });
      await sleep(500);

      const { result: drawer } = await send("Runtime.evaluate", {
        expression: `!!document.querySelector('[data-testid="observer-drawer"]')`,
        returnByValue: true,
      });
      if (!drawer?.value) die(1, "drawer did not open after floor row click");
      console.log("checked: click opens observer drawer");

      const { result: log } = await send("Runtime.evaluate", {
        expression: `!!document.querySelector('[data-testid="run-log"]')`,
        returnByValue: true,
      });
      if (!log?.value) die(1, "Live run log missing in drawer");
      console.log("checked: Live run log mounted");

      const { result: thinking } = await send("Runtime.evaluate", {
        expression: `!!document.querySelector('[data-testid="run-log-thinking"]')`,
        returnByValue: true,
      });
      if (!thinking?.value) die(1, "thinking/reasoning block missing in RunLog");
      console.log("checked: thinking rendered in RunLog");

      const { result: shell } = await send("Runtime.evaluate", {
        expression: `document.body.innerText.includes("Shell")`,
        returnByValue: true,
      });
      if (!shell?.value) die(1, "tool row (Shell) missing in RunLog");
      console.log("checked: tool use rendered in RunLog");

      const { data } = await send("Page.captureScreenshot", { format: "png" });
      writeFileSync(SHOT, Buffer.from(data, "base64"));
      console.log(`screenshot → ${SHOT}`);
    });

    console.log("BROKK-39 acceptance met");
    process.exit(0);
  } finally {
    chrome.kill("SIGKILL");
  }
}

main().catch((e) => die(1, String(e?.stack || e)));
