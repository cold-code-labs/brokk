/**
 * BROKK-22 (forge lane): the requeue-vs-fail decision for a card whose run was
 * reaped. Wrong in one direction the card ping-pongs forever; wrong in the
 * other a single forge restart permanently fails work that would have
 * succeeded on retry. Run: `pnpm --filter @brokk/core test`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { reapedTaskTarget } from "./index.js";

test("first reap requeues (default cap 1)", () => {
  assert.equal(reapedTaskTarget(1, 1), "queued");
});

test("second reap fails — cap of 1 spent", () => {
  assert.equal(reapedTaskTarget(2, 1), "failed");
});

test("cap 0 never requeues", () => {
  assert.equal(reapedTaskTarget(1, 0), "failed");
});

test("cap 2 allows two requeues then fails", () => {
  assert.equal(reapedTaskTarget(1, 2), "queued");
  assert.equal(reapedTaskTarget(2, 2), "queued");
  assert.equal(reapedTaskTarget(3, 2), "failed");
});

test("garbage cap falls back to 1 requeue", () => {
  assert.equal(reapedTaskTarget(1, Number.NaN), "queued");
  assert.equal(reapedTaskTarget(2, Number.NaN), "failed");
  assert.equal(reapedTaskTarget(1, -5), "queued");
});
