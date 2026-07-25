import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FuelBreaker, isFuelError } from "./fuel.js";

describe("isFuelError", () => {
  it("flags CLI turn-driver 'no result' failures as fuel", () => {
    assert.equal(isFuelError("Error: cursor-agent CLI pass failed: ..."), true);
    assert.equal(isFuelError("openhands exited 0 without JSONL agent events (no real turn)"), true);
    assert.equal(isFuelError("claude exited 1 without a result event"), true);
  });
  it("flags hard gateway/network errors as fuel", () => {
    assert.equal(isFuelError("fetch failed: ECONNREFUSED 127.0.0.1:4000"), true);
    assert.equal(isFuelError("litellm: no healthy deployment available"), true);
    assert.equal(isFuelError("503 Service Unavailable from upstream gateway"), true);
  });
  it("does NOT flag downstream (fuel worked, change failed) errors", () => {
    assert.equal(isFuelError("acceptance failed: app did not boot within 180s"), false);
    assert.equal(isFuelError("verify failed: packages/afl typecheck$ tsc --noEmit"), false);
    assert.equal(isFuelError("Error: Command failed: gh pr create --repo ..."), false);
  });
});

describe("FuelBreaker", () => {
  const mk = (now: () => number) =>
    new FuelBreaker({ threshold: 3, baseCooldownMs: 1000, maxCooldownMs: 8000, now });

  it("stays closed and trips only after `threshold` consecutive fuel errors", () => {
    let t = 0;
    const b = mk(() => t);
    assert.equal(b.canClaim(), true);
    b.record("fuel-error");
    b.record("fuel-error");
    assert.equal(b.isOpen, false, "not open before threshold");
    assert.equal(b.canClaim(), true);
    b.record("fuel-error"); // 3rd → trip
    assert.equal(b.isOpen, true);
    assert.equal(b.canClaim(), false, "OPEN blocks claiming");
  });

  it("a non-fuel outcome resets the consecutive count", () => {
    let t = 0;
    const b = mk(() => t);
    b.record("fuel-error");
    b.record("fuel-error");
    b.record("other-error"); // fuel answered → reset
    b.record("fuel-error");
    assert.equal(b.isOpen, false, "count reset, so one more fuel error is not the 3rd");
  });

  it("goes half-open after cooldown; a good trial closes it", () => {
    let t = 0;
    const b = mk(() => t);
    b.record("fuel-error");
    b.record("fuel-error");
    b.record("fuel-error"); // OPEN, cooldown 1000
    assert.equal(b.canClaim(), false);
    t = 1000; // cooldown elapsed
    assert.equal(b.canClaim(), true, "half-open lets a trial through");
    b.record("ok"); // trial succeeded → closed
    assert.equal(b.isOpen, false);
    assert.equal(b.canClaim(), true);
  });

  it("a failed trial re-opens with exponential backoff", () => {
    let t = 0;
    const b = mk(() => t);
    b.record("fuel-error");
    b.record("fuel-error");
    b.record("fuel-error"); // OPEN @ cooldown 1000 (retry at t=1000)
    t = 1000;
    assert.equal(b.canClaim(), true); // half-open trial
    b.record("fuel-error"); // trial failed → re-open, cooldown doubled to 2000
    assert.equal(b.isOpen, true);
    t = 1500;
    assert.equal(b.canClaim(), false, "still blocked — backoff grew to 2000ms");
    t = 3000;
    assert.equal(b.canClaim(), true);
  });
});
