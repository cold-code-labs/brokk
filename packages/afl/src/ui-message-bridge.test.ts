import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { UiMessageBridge } from "./ui-message-bridge.js";
import { chatRowsToUIMessages } from "./blocks-to-ui-message.js";
import type { AgentEvent } from "./types.js";

describe("UiMessageBridge", () => {
  it("maps text deltas to text-start/delta/end and finish", () => {
    const b = new UiMessageBridge();
    const chunks = [
      ...b.push({ type: "text_delta", text: "Hi" }),
      ...b.push({ type: "text_delta", text: "!" }),
      ...b.push({ type: "done" }),
    ];
    const types = chunks.map((c) => c.type);
    assert.deepEqual(types, [
      "start",
      "start-step",
      "text-start",
      "text-delta",
      "text-delta",
      "text-end",
      "finish-step",
      "finish",
    ]);
  });

  it("maps tool_use and tool_result", () => {
    const b = new UiMessageBridge();
    const chunks = [
      ...b.push({
        type: "tool_use",
        id: "t1",
        name: "Read",
        input: { path: "a.ts" },
      } satisfies AgentEvent),
      ...b.push({ type: "tool_result", toolUseId: "t1", ok: true, preview: "ok" }),
      ...b.push({ type: "done" }),
    ];
    assert.ok(chunks.some((c) => c.type === "tool-input-available"));
    assert.ok(chunks.some((c) => c.type === "tool-output-available"));
  });

  it("maps thinking to reasoning parts", () => {
    const b = new UiMessageBridge();
    const chunks = [
      ...b.push({ type: "thinking_delta", text: "hmm" }),
      ...b.push({ type: "done" }),
    ];
    assert.ok(chunks.some((c) => c.type === "reasoning-start"));
    assert.ok(chunks.some((c) => c.type === "reasoning-delta"));
    assert.ok(chunks.some((c) => c.type === "reasoning-end"));
  });
});

describe("chatRowsToUIMessages", () => {
  it("hydrates text and tools", () => {
    const msgs = chatRowsToUIMessages([
      {
        id: "1",
        seq: 0,
        role: "user",
        blocks: [{ type: "text", text: "hello" }],
      },
      {
        id: "2",
        seq: 1,
        role: "assistant",
        blocks: [
          { type: "text", text: "hi" },
          { type: "tool_use", id: "t1", name: "Read", input: { path: "x" } },
          { type: "tool_result", tool_use_id: "t1", content: "body" },
        ],
      },
    ]);
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0]!.parts[0]!.type, "text");
    const tool = msgs[1]!.parts.find((p) => p.type === "dynamic-tool") as {
      state: string;
      output?: string;
    };
    assert.equal(tool.state, "output-available");
    assert.equal(tool.output, "body");
  });
});
