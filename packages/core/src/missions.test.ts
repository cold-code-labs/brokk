import assert from "node:assert/strict";
import { test } from "node:test";
import { missionCardsSettled, missionProgress } from "./index.js";
import type { TaskStatus } from "./index.js";

const cards = (...statuses: TaskStatus[]) => statuses.map((status) => ({ status }));

test("missionProgress tallies every status bucket", () => {
  const p = missionProgress(
    cards("done", "done", "failed", "running", "queued", "review", "backlog", "cancelled"),
  );
  assert.deepEqual(p, {
    total: 8,
    done: 2,
    failed: 1,
    running: 1,
    queued: 1,
    review: 1,
    backlog: 1,
    cancelled: 1,
  });
});

test("missionProgress folds analysis into backlog (pre-dispatch state)", () => {
  const p = missionProgress(cards("analysis", "backlog"));
  assert.equal(p.backlog, 2);
  assert.equal(p.total, 2);
});

test("missionProgress of no cards is all zeros", () => {
  const p = missionProgress([]);
  assert.equal(p.total, 0);
  assert.equal(missionCardsSettled(p), true);
});

test("settled: all done", () => {
  assert.equal(missionCardsSettled(missionProgress(cards("done", "done"))), true);
});

test("settled: failed and cancelled are terminal too", () => {
  assert.equal(missionCardsSettled(missionProgress(cards("done", "failed", "cancelled"))), true);
});

test("NOT settled while a card is queued/running/backlog", () => {
  assert.equal(missionCardsSettled(missionProgress(cards("done", "queued"))), false);
  assert.equal(missionCardsSettled(missionProgress(cards("done", "running"))), false);
  assert.equal(missionCardsSettled(missionProgress(cards("done", "backlog"))), false);
  assert.equal(missionCardsSettled(missionProgress(cards("done", "analysis"))), false);
});

test("NOT settled in review — the PR is open awaiting Eitri/merge", () => {
  assert.equal(missionCardsSettled(missionProgress(cards("done", "review"))), false);
});
