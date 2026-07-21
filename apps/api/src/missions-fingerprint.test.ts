import assert from "node:assert/strict";
import { test } from "node:test";
import {
  autoLiveCapReached,
  errorFingerprint,
  isAutoPaused,
  noteMimirThrottle,
  resetAutoPause,
} from "./missions.js";

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

test("autoLiveCapReached defaults to one live auto mission", () => {
  assert.equal(autoLiveCapReached(0), false);
  assert.equal(autoLiveCapReached(1), true);
  assert.equal(autoLiveCapReached(1, 2), false);
  assert.equal(autoLiveCapReached(2, 2), true);
});

test("noteMimirThrottle pauses auto-intake on 429/529 only", () => {
  resetAutoPause();
  assert.equal(isAutoPaused(), false);
  noteMimirThrottle({ status: 500, message: "boom" });
  assert.equal(isAutoPaused(), false);
  noteMimirThrottle({ status: 429, message: "upstream 429" });
  assert.equal(isAutoPaused(), true);
  resetAutoPause();
  noteMimirThrottle({ status: 529, message: "overloaded" });
  assert.equal(isAutoPaused(), true);
  resetAutoPause();
});
