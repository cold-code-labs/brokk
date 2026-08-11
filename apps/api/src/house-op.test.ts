import assert from "node:assert/strict";
import { describe, it } from "node:test";

// Mirror of apps/web/lib/house.ts op helpers — keep in sync for CI without web deps.
type OpStatus = "idle" | "forging" | "review" | "failed" | "objective";

function opStatus(input: {
  needObjective: boolean;
  running: number;
  review: number;
  briefFailed: boolean;
}): OpStatus {
  if (input.briefFailed) return "failed";
  if (input.needObjective) return "objective";
  if (input.running > 0) return "forging";
  if (input.review > 0) return "review";
  return "idle";
}

function needsAttention(input: {
  archived?: boolean;
  needObjective: boolean;
  running: number;
  review: number;
  briefFailed: boolean;
}): boolean {
  if (input.archived) return false;
  const s = opStatus(input);
  return s === "failed" || s === "objective" || s === "forging" || s === "review";
}

describe("house op status", () => {
  it("prioritizes fail over objective", () => {
    assert.equal(
      opStatus({ needObjective: true, running: 1, review: 1, briefFailed: true }),
      "failed",
    );
  });
  it("flags attention only for hot states", () => {
    assert.equal(
      needsAttention({ needObjective: false, running: 0, review: 0, briefFailed: false }),
      false,
    );
    assert.equal(
      needsAttention({ needObjective: true, running: 0, review: 0, briefFailed: false }),
      true,
    );
    assert.equal(
      needsAttention({
        archived: true,
        needObjective: true,
        running: 2,
        review: 1,
        briefFailed: true,
      }),
      false,
    );
  });
});
