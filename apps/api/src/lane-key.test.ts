import assert from "node:assert/strict";
import { test } from "node:test";
import { laneKeyForCard } from "@brokk/db";

// The lane key is the git resource a card serializes on (Wave 2). These tests pin
// the precedence and the "standalone → null → parallelizes" rule that unlocks
// same-repo throughput. Only the fields laneKeyForCard reads are supplied.
type Card = Parameters<typeof laneKeyForCard>[0];
const card = (over: Partial<Card> = {}): Card => ({
  planId: null,
  projectId: "proj-1",
  kind: "implement",
  branch: null,
  ...over,
});
const DEVLANE = new Set(["logcheck", "svalinn"]);

test("standalone PR card → no lane (parallelizes, even same repo)", () => {
  // Non-dev-lane app, no plan, not revise → forks a unique branch → nothing to wait on.
  assert.equal(laneKeyForCard(card(), "some-app", null, DEVLANE), null);
});

test("two standalone cards of the same repo get no lane → never contend", () => {
  const a = laneKeyForCard(card(), "some-app", null, DEVLANE);
  const b = laneKeyForCard(card(), "some-app", null, DEVLANE);
  assert.equal(a, null);
  assert.equal(b, null);
});

test("plan/story card → the plan's shared feature branch (serial per branch)", () => {
  assert.equal(
    laneKeyForCard(card({ planId: "plan-9" }), "some-app", "feat/checkout", DEVLANE),
    "proj-1:feat/checkout",
  );
});

test("two plan cards on the same feature branch share a lane → serial", () => {
  const a = laneKeyForCard(card({ planId: "p1" }), "some-app", "feat/x", DEVLANE);
  const b = laneKeyForCard(card({ planId: "p2" }), "some-app", "feat/x", DEVLANE);
  assert.equal(a, b); // same key → they contend
});

test("plan cards on different feature branches of one repo parallelize", () => {
  const a = laneKeyForCard(card({ planId: "p1" }), "some-app", "feat/x", DEVLANE);
  const b = laneKeyForCard(card({ planId: "p2" }), "some-app", "feat/y", DEVLANE);
  assert.notEqual(a, b);
});

test("revise card → the PR branch it updates", () => {
  assert.equal(
    laneKeyForCard(card({ kind: "revise", branch: "brokk/fix-42" }), "some-app", null, DEVLANE),
    "proj-1:brokk/fix-42",
  );
});

test("dev-lane app standalone card → the app's shared `dev` checkout", () => {
  assert.equal(laneKeyForCard(card(), "logcheck", null, DEVLANE), "proj-1:dev");
});

test("precedence: a plan card for a dev-lane app keys on the feature branch, not dev", () => {
  // Plans always take the PR route (isDevLaneCard returns false for plans), so the
  // contended resource is the feature branch — never the shared dev checkout.
  assert.equal(
    laneKeyForCard(card({ planId: "p1" }), "logcheck", "feat/z", DEVLANE),
    "proj-1:feat/z",
  );
});

test("lane keys are project-scoped (same branch name, different apps don't collide)", () => {
  const a = laneKeyForCard(card({ kind: "revise", branch: "dev" }), "some-app", null, DEVLANE);
  const b = laneKeyForCard(
    { planId: null, projectId: "proj-2", kind: "revise", branch: "dev" },
    "some-app",
    null,
    DEVLANE,
  );
  assert.notEqual(a, b);
});
