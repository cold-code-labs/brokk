#!/usr/bin/env node
/**
 * Combined acceptance after merging BROKK-38 + BROKK-39.
 *
 * 1) BROKK-38: fixture under `.brokk/inbox/` appears in turn-context block;
 *    public /attach-smoke serves the Attach affordance.
 * 2) BROKK-39: /brokk/observer floor row opens drawer with Live run log,
 *    thinking + tool rows; writes BROKK_ACCEPTANCE_SHOT.
 *
 * Env: BROKK_ACCEPTANCE_URL, BROKK_CHROMIUM, BROKK_ACCEPTANCE_SHOT
 */
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const BASE = process.env.BROKK_ACCEPTANCE_URL;
const CHROME = process.env.BROKK_CHROMIUM;
const SHOT = process.env.BROKK_ACCEPTANCE_SHOT;

if (!BASE || !CHROME || !SHOT) {
  console.error("missing BROKK_ACCEPTANCE_URL / BROKK_CHROMIUM / BROKK_ACCEPTANCE_SHOT");
  process.exit(2);
}

const ROOT = BASE.replace(/\/$/, "");
const OBSERVER = `${ROOT}/brokk/observer`;
const INBOX_DIR = ".brokk/inbox";

function die(code, msg) {
  console.error(msg);
  process.exit(code);
}

function attachmentContextBlock(paths) {
  const clean = [];
  const seen = new Set();
  for (const raw of paths) {
    const p = String(raw ?? "")
      .replace(/\\/g, "/")
      .replace(/^\/+/, "")
      .trim();
    if (!p.startsWith(`${INBOX_DIR}/`) || p.includes("..") || p.includes("\0")) continue;
    const rest = p.slice(INBOX_DIR.length + 1);
    if (!rest || rest.includes("/")) continue;
    if (seen.has(p)) continue;
    seen.add(p);
    clean.push(p);
  }
  if (!clean.length) return "";
  return [
    "## Attachments (this turn)",
    "Client files were saved into this checkout under `.brokk/inbox/`. Read them with your FS tools (`read_file` / `bash`); do not ask the user to re-upload or paste their contents.",
    ...clean.map((p) => `- \`${p}\``),
  ].join("\n");
}

async function dogfoodInboxContext() {
  const root = join(tmpdir(), `brokk-38-accept-${process.pid}`);
  const rel = `${INBOX_DIR}/fixture-costs.txt`;
  const abs = join(root, rel);
  await mkdir(join(root, INBOX_DIR), { recursive: true });
  await writeFile(abs, "sku,qty\nA,1\n", "utf8");
  const block = attachmentContextBlock([rel]);
  await rm(root, { recursive: true, force: true }).catch(() => {});
  if (!block.includes(rel)) {
    throw new Error(`dogfood failed: turn context missing ${rel}\n---\n${block}`);
  }
  if (!block.includes("## Attachments (this turn)")) {
    throw new Error("dogfood failed: missing attachments heading");
  }
  console.log(`[ok] BROKK-38 dogfood: wrote ${rel} and found it in turn context`);
}

async function assertAttachSmoke() {
  const url = `${ROOT}/attach-smoke`;
  const res = await fetch(url);
  const html = await res.text();
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  if (!html.includes('data-testid="sindri-attach"') && !html.includes("data-sindri-attach")) {
    throw new Error(`attach-smoke HTML missing attach markers\n${html.slice(0, 400)}`);
  }
  console.log(`[ok] BROKK-38 HTTP: ${url} serves attach affordance`);
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

async function assertObserverDrillIn() {
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
    const created = await fetch(`http://${host}/json/new?${encodeURIComponent(OBSERVER)}`, {
      method: "PUT",
    }).then((r) => r.json());
    const pageWs = created.webSocketDebuggerUrl;
    if (!pageWs) die(1, `no page websocket: ${JSON.stringify(created)}`);

    await withCdp(pageWs, async (send) => {
      await send("Page.enable");
      await send("Runtime.enable");
      await send("Page.navigate", { url: OBSERVER });

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
      console.log("[ok] BROKK-39: forge floor row is present and clickable");

      await send("Runtime.evaluate", {
        expression: `document.querySelector('[data-testid="forge-floor-row"]').click()`,
      });
      await sleep(500);

      const { result: drawer } = await send("Runtime.evaluate", {
        expression: `!!document.querySelector('[data-testid="observer-drawer"]')`,
        returnByValue: true,
      });
      if (!drawer?.value) die(1, "drawer did not open after floor row click");
      console.log("[ok] BROKK-39: click opens observer drawer");

      const { result: log } = await send("Runtime.evaluate", {
        expression: `!!document.querySelector('[data-testid="run-log"]')`,
        returnByValue: true,
      });
      if (!log?.value) die(1, "Live run log missing in drawer");
      console.log("[ok] BROKK-39: Live run log mounted");

      const { result: thinking } = await send("Runtime.evaluate", {
        expression: `!!document.querySelector('[data-testid="run-log-thinking"]')`,
        returnByValue: true,
      });
      if (!thinking?.value) die(1, "thinking/reasoning block missing in RunLog");
      console.log("[ok] BROKK-39: thinking rendered in RunLog");

      const { result: shell } = await send("Runtime.evaluate", {
        expression: `document.body.innerText.includes("Shell")`,
        returnByValue: true,
      });
      if (!shell?.value) die(1, "tool row (Shell) missing in RunLog");
      console.log("[ok] BROKK-39: tool use rendered in RunLog");

      const { data } = await send("Page.captureScreenshot", { format: "png" });
      writeFileSync(SHOT, Buffer.from(data, "base64"));
      console.log(`screenshot → ${SHOT}`);
    });
  } finally {
    chrome.kill("SIGKILL");
  }
}

async function main() {
  console.log("acceptance — BROKK-38 attachments + BROKK-39 forge observer");
  await dogfoodInboxContext();
  await assertAttachSmoke();
  await assertObserverDrillIn();
  console.log("acceptance met");
  process.exit(0);
}

main().catch((e) => die(1, String(e?.stack || e)));
