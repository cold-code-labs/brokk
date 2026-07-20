import assert from "node:assert/strict";
import { test } from "node:test";
import { foldRunLogEvents } from "./run-log.js";

test("foldRunLogEvents coalesces thinking deltas into one live entry", () => {
  const entries = foldRunLogEvents([
    { type: "thinking", payload: { text: "Let me " } },
    { type: "thinking", payload: { text: "check the floor." } },
  ]);
  assert.deepEqual(entries, [
    { kind: "thinking", text: "Let me check the floor.", live: true },
  ]);
});

test("foldRunLogEvents prefers finalized thinking on message over live buffer", () => {
  const entries = foldRunLogEvents([
    { type: "thinking", payload: { text: "partial…" } },
    {
      type: "message",
      payload: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Full reasoning." },
          { type: "text", text: "Done." },
          { type: "tool_use", id: "t1", name: "bash", input: { command: "ls" } },
        ],
      },
    },
    {
      type: "tool_result",
      payload: { tool_use_id: "t1", ok: true, preview: "ok" },
    },
  ]);
  assert.equal(entries.length, 3);
  assert.deepEqual(entries[0], { kind: "thinking", text: "Full reasoning.", live: false });
  assert.deepEqual(entries[1], { kind: "text", text: "Done." });
  assert.equal(entries[2]?.kind, "tool");
  if (entries[2]?.kind === "tool") {
    assert.equal(entries[2].tool.id, "t1");
    assert.equal(entries[2].result?.ok, true);
  }
});

test("foldRunLogEvents dedupes standalone tool_use already in a message", () => {
  const entries = foldRunLogEvents([
    {
      type: "message",
      payload: {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "Read", input: { path: "a.ts" } }],
      },
    },
    { type: "tool_use", payload: { id: "t1", name: "Read", input: { path: "a.ts" } } },
  ]);
  assert.equal(entries.filter((e) => e.kind === "tool").length, 1);
});

test("foldRunLogEvents renders orphan standalone tool_use", () => {
  const entries = foldRunLogEvents([
    { type: "tool_use", payload: { id: "t9", name: "bash", input: { command: "pwd" } } },
  ]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.kind, "tool");
});
