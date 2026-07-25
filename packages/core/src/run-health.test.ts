import assert from "node:assert/strict";
import { test } from "node:test";
import { isRunStale, RUNNER_STALE_MS_DEFAULT } from "./run-health.js";

const NOW = Date.parse("2026-07-25T12:00:00Z");
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

test("healthy running run (fresh heartbeat) is not stale", () => {
  const run = { status: "running", startedAt: iso(20 * 60_000) };
  assert.equal(isRunStale(run, iso(10_000), { now: NOW }), false);
});

test("running run whose runner stopped heartbeating is stale", () => {
  const run = { status: "running", startedAt: iso(20 * 60_000) };
  assert.equal(isRunStale(run, iso(RUNNER_STALE_MS_DEFAULT + 1000), { now: NOW }), true);
});

test("no agent row falls back to startedAt age", () => {
  const zombie = { status: "running", startedAt: iso(RUNNER_STALE_MS_DEFAULT + 1000) };
  assert.equal(isRunStale(zombie, null, { now: NOW }), true);
  const young = { status: "running", startedAt: iso(5000) };
  assert.equal(isRunStale(young, null, { now: NOW }), false);
});

test("non-running runs are never stale", () => {
  for (const status of ["queued", "done", "failed", "cancelled"]) {
    assert.equal(isRunStale({ status, startedAt: iso(999_999_999) }, null, { now: NOW }), false);
  }
});

test("no anchor at all → not stale (can't judge)", () => {
  assert.equal(isRunStale({ status: "running", startedAt: null }, null, { now: NOW }), false);
});

test("staleMs override tunes the threshold", () => {
  const run = { status: "running", startedAt: iso(10 * 60_000) };
  assert.equal(isRunStale(run, iso(30_000), { now: NOW, staleMs: 60_000 }), false);
  assert.equal(isRunStale(run, iso(30_000), { now: NOW, staleMs: 20_000 }), true);
});
