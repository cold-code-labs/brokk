import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { looksLikeRemediation } from "./pr-monitor.js";

describe("looksLikeRemediation", () => {
  it("skips short praise", () => {
    assert.equal(looksLikeRemediation("LGTM"), false);
    assert.equal(looksLikeRemediation("ship it"), false);
  });

  it("flags change requests", () => {
    assert.equal(looksLikeRemediation("Please fix the null deref in checkout"), true);
    assert.equal(looksLikeRemediation("CI failed on typecheck"), true);
    assert.equal(looksLikeRemediation("blocking: must rename the helper"), true);
  });
});
