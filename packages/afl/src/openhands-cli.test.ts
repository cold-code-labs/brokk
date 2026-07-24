import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildOpenHandsCliEnv, mapOpenHandsEvent, ohText } from "./openhands-cli.js";
import type { AgentEvent } from "./types.js";

describe("openhands-cli env", () => {
  it("appends /v1 to LiteLLM root and defaults RUNTIME=process", () => {
    const env = buildOpenHandsCliEnv(
      { model: "openai/cursor/auto" },
      {
        PATH: "/usr/bin",
        HOME: "/home/brokk",
        LLM_BASE_URL: "http://litellm:4000",
        LLM_API_KEY: "sk-test",
      },
    );
    assert.equal(env.LLM_BASE_URL, "http://litellm:4000/v1");
    assert.equal(env.LLM_API_KEY, "sk-test");
    assert.equal(env.LLM_MODEL, "openai/cursor/auto");
    assert.equal(env.RUNTIME, "process");
  });

  it("does not double-append /v1", () => {
    const env = buildOpenHandsCliEnv(
      {},
      {
        PATH: "/usr/bin",
        HOME: "/home/brokk",
        LLM_BASE_URL: "http://litellm:4000/v1",
        LLM_API_KEY: "sk",
      },
    );
    assert.equal(env.LLM_BASE_URL, "http://litellm:4000/v1");
  });
});

describe("ohText", () => {
  it("flattens OH content block arrays instead of [object Object]", () => {
    assert.equal(
      ohText([{ type: "text", text: "hello" }, { type: "text", text: "world" }]),
      "hello\nworld",
    );
  });
});

describe("mapOpenHandsEvent", () => {
  function collect(raw: Record<string, unknown>): AgentEvent[] {
    const out: AgentEvent[] = [];
    mapOpenHandsEvent(raw, (e) => out.push(e), new Map());
    return out;
  }

  it("maps ActionEvent via tool_name, not kind=ActionEvent", () => {
    const ev = collect({
      id: "a1",
      kind: "ActionEvent",
      source: "agent",
      tool_name: "terminal",
      tool_call_id: "call_1",
      thought: [{ type: "text", text: "checking package.json" }],
      action: { kind: "TerminalAction", command: "cat package.json" },
    });
    const use = ev.find((e) => e.type === "tool_use");
    assert.ok(use && use.type === "tool_use");
    assert.equal(use.name, "terminal");
    assert.equal(use.id, "call_1");
    assert.equal(use.input.command, "cat package.json");
    const thought = ev.find((e) => e.type === "text_delta");
    assert.ok(thought && thought.type === "text_delta");
    assert.match(thought.text, /checking package/);
  });

  it("maps ObservationEvent content arrays to a readable preview", () => {
    const ids = new Map<string, string>([["call_1", "terminal"]]);
    const out: AgentEvent[] = [];
    mapOpenHandsEvent(
      {
        kind: "ObservationEvent",
        source: "environment",
        tool_name: "terminal",
        action_id: "call_1",
        observation: {
          kind: "TerminalObservation",
          content: [{ type: "text", text: "lockfile ok\nERR_PNPM_IGNORED_BUILDS" }],
          is_error: false,
        },
      },
      (e) => out.push(e),
      ids,
    );
    assert.equal(out.length, 1);
    assert.equal(out[0]!.type, "tool_result");
    if (out[0]!.type === "tool_result") {
      assert.equal(out[0].toolUseId, "call_1");
      assert.match(out[0].preview, /ERR_PNPM_IGNORED_BUILDS/);
      assert.equal(out[0].ok, true);
    }
  });

  it("maps file_editor actions without collapsing to ActionEvent", () => {
    const ev = collect({
      kind: "ActionEvent",
      tool_name: "file_editor",
      tool_call_id: "fe1",
      action: { kind: "FileEditorAction", command: "view", path: "/tmp/x.ts" },
    });
    const use = ev.find((e) => e.type === "tool_use");
    assert.ok(use && use.type === "tool_use");
    assert.equal(use.name, "file_editor");
    assert.equal(use.input.path, "/tmp/x.ts");
  });
});
