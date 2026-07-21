import assert from "node:assert/strict";
import { test } from "node:test";
import { errorFingerprint } from "./missions.js";

test("errorFingerprint collapses whitespace and volatile digits/hashes", () => {
  const a = errorFingerprint("verify failed:\n  line 12 at abcdef0123456");
  const b = errorFingerprint("verify failed:   line 99 at deadbeef9999999");
  assert.equal(a, b);
});

test("errorFingerprint distinguishes real message changes", () => {
  const a = errorFingerprint("verify failed: type error in Foo.ts");
  const b = errorFingerprint("acceptance failed: button missing");
  assert.notEqual(a, b);
});
