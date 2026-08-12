import assert from "node:assert/strict";
import { describe, it } from "node:test";

type OpStatus = "idle" | "forging" | "review" | "failed" | "objective";

function opStatus(input: {
  needObjective: boolean;
  running: number;
  review: number;
  briefFailed: boolean;
}): OpStatus {
  if (input.briefFailed) return "failed";
  if (input.running > 0) return "forging";
  if (input.review > 0) return "review";
  if (input.needObjective) return "objective";
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
  if (input.briefFailed) return true;
  if (input.running > 0) return true;
  if (input.review > 0) return true;
  return false;
}

function needsObjectiveSection(input: {
  archived?: boolean;
  needObjective: boolean;
  running: number;
  review: number;
  briefFailed: boolean;
}): boolean {
  if (input.archived) return false;
  if (needsAttention(input)) return false;
  return input.needObjective;
}

describe("house op status", () => {
  it("fail / forge / review beat objective", () => {
    assert.equal(
      opStatus({ needObjective: true, running: 0, review: 0, briefFailed: true }),
      "failed",
    );
    assert.equal(
      opStatus({ needObjective: true, running: 1, review: 0, briefFailed: false }),
      "forging",
    );
    assert.equal(
      opStatus({ needObjective: true, running: 0, review: 1, briefFailed: false }),
      "review",
    );
    assert.equal(
      opStatus({ needObjective: true, running: 0, review: 0, briefFailed: false }),
      "objective",
    );
  });

  it("attention is operational only — not missing objective", () => {
    assert.equal(
      needsAttention({ needObjective: true, running: 0, review: 0, briefFailed: false }),
      false,
    );
    assert.equal(
      needsObjectiveSection({
        needObjective: true,
        running: 0,
        review: 0,
        briefFailed: false,
      }),
      true,
    );
    assert.equal(
      needsAttention({ needObjective: false, running: 1, review: 0, briefFailed: false }),
      true,
    );
    assert.equal(
      needsObjectiveSection({
        needObjective: true,
        running: 1,
        review: 0,
        briefFailed: false,
      }),
      false,
    );
  });
});
