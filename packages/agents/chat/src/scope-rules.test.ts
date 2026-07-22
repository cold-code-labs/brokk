import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

test("SCOPE_RULES treats pt-BR No X as inside X, not English no", () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "context.ts"), "utf8");
  assert.match(src, /export const SCOPE_RULES/);
  assert.match(src, /No X/);
  assert.match(src, /inside the sidebar/i);
  assert.match(src, /does NOT mean remove/i);
  assert.match(src, /Label\/copy\/rename/i);
  assert.match(src, /confirm in one short question/i);
});
