import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { textDeltaFromFrame } from "./cursor-cli.js";

describe("cursor-cli AgentEvent helpers", () => {
  it("textDeltaFromFrame emits suffix for cumulative frames", () => {
    const a = textDeltaFromFrame("", "Hello");
    assert.equal(a.delta, "Hello");
    const b = textDeltaFromFrame(a.next, "Hello world");
    assert.equal(b.delta, " world");
    assert.equal(b.next, "Hello world");
  });

  it("textDeltaFromFrame ignores duplicate full frame", () => {
    const a = textDeltaFromFrame("Hello", "Hello");
    assert.equal(a.delta, "");
    assert.equal(a.next, "Hello");
  });

  it("textDeltaFromFrame starts a new segment when frame is unrelated", () => {
    const a = textDeltaFromFrame("First.", "Second.");
    assert.equal(a.delta, "\nSecond.");
    assert.equal(a.next, "First.\nSecond.");
  });
});
