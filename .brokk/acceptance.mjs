#!/usr/bin/env node
/**
 * BROKK-38 acceptance receipt — dependency-free Node ESM.
 *
 * 1) Dogfood: fixture path under `.brokk/inbox/` must appear in the turn-context
 *    block (same contract as packages/agents/chat attachmentContextBlock).
 * 2) UI: Chromium opens the public /attach-smoke surface (chat is auth-gated)
 *    and asserts the Attach affordance; writes BROKK_ACCEPTANCE_SHOT.
 *
 * Env: BROKK_ACCEPTANCE_URL, BROKK_CHROMIUM, BROKK_ACCEPTANCE_SHOT
 */
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const BASE = (process.env.BROKK_ACCEPTANCE_URL || "http://127.0.0.1:3010").replace(/\/$/, "");
const CHROMIUM = process.env.BROKK_CHROMIUM || "chromium";
const SHOT = process.env.BROKK_ACCEPTANCE_SHOT || join(process.cwd(), ".brokk", "acceptance-shot.png");
const W = Number(process.env.BROKK_SHOT_W || 1000);
const H = Number(process.env.BROKK_SHOT_H || 700);

const INBOX_DIR = ".brokk/inbox";

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
  console.log(`[ok] dogfood: wrote ${rel} and found it in turn context`);
}

async function assertUiWithChromium() {
  const url = `${BASE}/attach-smoke`;
  const res = await fetch(url);
  const html = await res.text();
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  if (!html.includes('data-testid="sindri-attach"') && !html.includes("data-sindri-attach")) {
    throw new Error(`attach-smoke HTML missing attach markers\n${html.slice(0, 400)}`);
  }
  console.log(`[ok] HTTP: ${url} serves attach affordance`);

  await mkdir(dirname(SHOT), { recursive: true });
  const proc = spawn(
    CHROMIUM,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--hide-scrollbars",
      `--window-size=${W},${H}`,
      `--screenshot=${SHOT}`,
      url,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let err = "";
  proc.stderr?.on("data", (d) => {
    err = (err + d.toString()).slice(-2000);
  });
  const code = await new Promise((resolve) => proc.on("close", resolve));
  if (code !== 0) {
    throw new Error(`chromium exit ${code}: ${err || "(no stderr)"}`);
  }
  const png = await readFile(SHOT);
  if (png.byteLength < 100) throw new Error("screenshot empty");
  console.log(`[ok] screenshot ${SHOT} (${png.byteLength} bytes)`);
}

async function main() {
  console.log("BROKK-38 acceptance — chat attachments → .brokk/inbox/ + turn context");
  await dogfoodInboxContext();
  await assertUiWithChromium();
  console.log("acceptance met");
  process.exit(0);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
