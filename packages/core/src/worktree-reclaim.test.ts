/**
 * The reclaim rule decides what gets DELETED FROM DISK, so every branch is
 * pinned here. The load-bearing case is `devlane_` (see below): two lanes share
 * `preview-worktrees/`, and the intuitive orphan rule would delete a running
 * card's checkout. Run: `pnpm --filter @brokk/core test`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { PREVIEW_WORKTREE_TTL_MS, worktreeReclaimVerdict } from "./index.js";

const NOW = Date.parse("2026-07-19T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

function input(over: Partial<Parameters<typeof worktreeReclaimVerdict>[0]> = {}) {
  return {
    name: "maglink_dev",
    preview: { status: "stopped" as const, lastActivityAt: daysAgo(30) },
    inFlight: false,
    pinned: false,
    now: NOW,
    ...over,
  };
}

test("reclaims a rested worktree past the TTL", () => {
  const v = worktreeReclaimVerdict(input());
  assert.equal(v.reclaim, true);
  assert.match(v.reason, /> TTL/);
});

test("keeps a worktree still within the TTL", () => {
  const v = worktreeReclaimVerdict(input({ preview: { status: "stopped", lastActivityAt: daysAgo(3) } }));
  assert.equal(v.reclaim, false);
  assert.match(v.reason, /within TTL/);
});

// 🔴 The one that matters most: a dev-lane card's checkout lives in the SAME
// directory and has no preview record, so "no record → orphan → reclaim" would
// delete it mid-run. The name exclusion must win over every other rule.
test("NEVER reclaims a dev-lane card checkout, even with no record and ancient age", () => {
  const v = worktreeReclaimVerdict(
    input({ name: "devlane_logcheck_dev", preview: null }),
  );
  assert.equal(v.reclaim, false, "a running card's worktree must never be reclaimed");
  assert.match(v.reason, /dev-lane/);
});

test("the dev-lane exclusion outranks even a stale preview record", () => {
  const v = worktreeReclaimVerdict(
    input({ name: "devlane_viken", preview: { status: "stopped", lastActivityAt: daysAgo(999) } }),
  );
  assert.equal(v.reclaim, false);
});

test("reclaims a true orphan — no preview record, preview-lane name", () => {
  const v = worktreeReclaimVerdict(input({ name: "ghost_dev", preview: null }));
  assert.equal(v.reclaim, true);
  assert.match(v.reason, /no preview record/);
});

test("keeps a pinned project however idle", () => {
  const v = worktreeReclaimVerdict(
    input({ pinned: true, preview: { status: "stopped", lastActivityAt: daysAgo(999) } }),
  );
  assert.equal(v.reclaim, false);
  assert.equal(v.reason, "pinned");
});

test("keeps anything in flight in this process", () => {
  // A booting preview has no fresh lastActivityAt yet — the timestamp looks
  // ancient exactly when reclaiming would race its checkout.
  const v = worktreeReclaimVerdict(
    input({ inFlight: true, preview: { status: "stopped", lastActivityAt: daysAgo(999) } }),
  );
  assert.equal(v.reclaim, false);
  assert.match(v.reason, /in flight/);
});

for (const status of ["live", "starting"] as const) {
  test(`keeps a worktree whose preview is ${status}`, () => {
    const v = worktreeReclaimVerdict(
      input({ preview: { status, lastActivityAt: daysAgo(999) } }),
    );
    assert.equal(v.reclaim, false);
    assert.match(v.reason, new RegExp(status));
  });
}

test("refuses to reclaim on an unreadable timestamp instead of falling through", () => {
  // NaN comparisons are all false, so a naive `idle > ttl` check would let a
  // garbage date reach the delete. Failing closed is the only safe direction.
  const v = worktreeReclaimVerdict(input({ preview: { status: "stopped", lastActivityAt: "not-a-date" } }));
  assert.equal(v.reclaim, false);
  assert.match(v.reason, /unreadable/);
});

test("the TTL boundary is inclusive — exactly at the TTL is still kept", () => {
  const at = new Date(NOW - PREVIEW_WORKTREE_TTL_MS).toISOString();
  assert.equal(worktreeReclaimVerdict(input({ preview: { status: "stopped", lastActivityAt: at } })).reclaim, false);
  const past = new Date(NOW - PREVIEW_WORKTREE_TTL_MS - 1000).toISOString();
  assert.equal(worktreeReclaimVerdict(input({ preview: { status: "stopped", lastActivityAt: past } })).reclaim, true);
});

test("a custom ttl is honoured", () => {
  const v = worktreeReclaimVerdict(input({ preview: { status: "stopped", lastActivityAt: daysAgo(5) } }), 86_400_000);
  assert.equal(v.reclaim, true);
});
