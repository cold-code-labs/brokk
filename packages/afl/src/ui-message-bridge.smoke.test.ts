import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { UiMessageBridge } from "./ui-message-bridge.js";
import type { AgentEvent } from "./types.js";

/** Cursor-cli shaped turn → UIMessage chunks (smoke for PR1–4 wire). */
describe("ui-message smoke (cursor-cli shaped)", () => {
  it("streams text + tools + finish without legacy AgentEvent frames", () => {
    const b = new UiMessageBridge();
    const events: AgentEvent[] = [
      { type: "status", phase: "starting" },
      { type: "thinking_delta", text: "plan" },
      { type: "tool_use", id: "1", name: "Shell", input: { command: "ls" } },
      { type: "tool_result", toolUseId: "1", ok: true, preview: "ok" },
      { type: "text_delta", text: "Done." },
      { type: "title", title: "List files" },
      { type: "usage", usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 } },
      { type: "done" },
    ];
    const chunks = events.flatMap((e) => b.push(e));
    const types = chunks.map((c) => c.type);
    assert.ok(types.includes("data-sindri-status"));
    assert.ok(types.includes("reasoning-delta"));
    assert.ok(types.includes("tool-input-available"));
    assert.ok(types.includes("tool-output-available"));
    assert.ok(types.includes("text-delta"));
    assert.ok(types.includes("message-metadata"));
    assert.equal(types.at(-1), "finish");
    // No raw AgentEvent.type leaked as chunk type
    assert.ok(!types.includes("text_delta" as never));
    assert.ok(!types.includes("done" as never));
  });
});
