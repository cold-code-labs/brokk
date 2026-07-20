// ─────────────────────────────────────────────────────────────────────────────
// Persist composer attachments into the session checkout's `.brokk/inbox/`.
// Used when the client could not POST fs/write yet (no checkout) and sent
// inline bytes with the message — after ensure(), we land them here.
// ─────────────────────────────────────────────────────────────────────────────

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { inboxRelPath, normalizeInboxPaths, safeInboxFilename } from "@brokk/chat";

const MAX_BYTES = 12 * 1024 * 1024; // 12 MiB per file — spreadsheets stay small
const MAX_FILES = 8;

export type InboxUpload = { name: string; dataBase64: string };

/** Write inline uploads under `.brokk/inbox/` and return the relative paths. */
export async function writeInboxUploads(
  cwd: string,
  uploads: readonly InboxUpload[],
): Promise<string[]> {
  const paths: string[] = [];
  const used = new Set<string>();
  for (const u of uploads.slice(0, MAX_FILES)) {
    const name = safeInboxFilename(u.name);
    if (!name) continue;
    let rel = inboxRelPath(name);
    // Collision: costs.xlsx → costs-2.xlsx
    if (used.has(rel)) {
      const dot = name.lastIndexOf(".");
      const stem = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot) : "";
      let n = 2;
      while (used.has(inboxRelPath(`${stem}-${n}${ext}`))) n++;
      rel = inboxRelPath(`${stem}-${n}${ext}`);
    }
    used.add(rel);
    let buf: Buffer;
    try {
      buf = Buffer.from(u.dataBase64 ?? "", "base64");
    } catch {
      continue;
    }
    if (!buf.length || buf.length > MAX_BYTES) continue;
    const abs = join(cwd, rel);
    await mkdir(join(cwd, ".brokk", "inbox"), { recursive: true });
    await writeFile(abs, buf);
    paths.push(rel);
  }
  return normalizeInboxPaths(paths);
}
