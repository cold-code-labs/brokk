/**
 * Dogfood for BROKK-38: a fixture path under `.brokk/inbox/` must appear in the
 * turn-context block the model sees. No xlsx parsing — paths only.
 * Run: `pnpm --filter @brokk/chat test`
 */
import assert from "node:assert/strict";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import {
  INBOX_DIR,
  attachmentContextBlock,
  inboxRelPath,
  normalizeInboxPaths,
  safeInboxFilename,
} from "./attachments.ts";

test("safeInboxFilename strips traversal and junk", () => {
  assert.equal(safeInboxFilename("../../etc/passwd"), "passwd");
  assert.equal(safeInboxFilename("custo 2024.xlsx"), "custo 2024.xlsx");
  assert.equal(safeInboxFilename("weird<>name.pdf"), "weird_name.pdf");
});

test("inboxRelPath lands under .brokk/inbox/", () => {
  assert.equal(inboxRelPath("costs.xlsx"), `${INBOX_DIR}/costs.xlsx`);
});

test("normalizeInboxPaths drops escapes and non-inbox paths", () => {
  assert.deepEqual(
    normalizeInboxPaths([
      ".brokk/inbox/ok.txt",
      ".brokk/inbox/../secrets",
      "src/app.ts",
      "/.brokk/inbox/abs.txt",
      ".brokk/inbox/nested/nope.txt",
    ]),
    [".brokk/inbox/ok.txt", ".brokk/inbox/abs.txt"],
  );
});

test("dogfood: fixture in inbox → path present in turn context", async () => {
  const root = join(tmpdir(), `brokk-inbox-dogfood-${process.pid}`);
  const rel = inboxRelPath("fixture-costs.txt");
  const abs = join(root, rel);
  await mkdir(join(root, INBOX_DIR), { recursive: true });
  await writeFile(abs, "sku,qty\nA,1\n", "utf8");

  const block = attachmentContextBlock([rel, "evil/../nope", rel]);
  assert.match(block, /## Attachments \(this turn\)/);
  assert.ok(block.includes(rel), `expected turn context to list ${rel}`);
  assert.ok(block.includes("read_file") || block.includes("FS tools"));
  assert.equal(normalizeInboxPaths([rel])[0], rel);

  await rm(root, { recursive: true, force: true });
});
