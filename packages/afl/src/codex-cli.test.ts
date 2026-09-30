import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildCodexArgs, buildCodexCliEnv, handleCodexJsonLine, newCodexJsonState } from "./codex-cli.js";
import type { AgentEvent, TurnUsage } from "./types.js";

const SRC: NodeJS.ProcessEnv = {
  PATH: "/usr/bin",
  HOME: "/home/brokk",
  TMPDIR: "/tmp",
  OPENAI_API_KEY: "sk-test",
  GH_TOKEN: "gh-secret",
  DATABASE_URL: "postgres://should-not-leak",
  BROKK_GIT_NAME: "Brokk Bot",
  BROKK_GIT_EMAIL: "bot@brokk.dev",
};

describe("buildCodexArgs", () => {
  it("builds a fresh session that reads the prompt from stdin", () => {
    assert.deepEqual(buildCodexArgs({ prompt: "do it", cwd: "/work", model: "gpt-5-codex" }), [
      "exec",
      "--json",
      "--sandbox",
      "workspace-write",
      "--skip-git-repo-check",
      "--model",
      "gpt-5-codex",
      "-",
    ]);
  });

  it("resumes an existing thread", () => {
    assert.deepEqual(buildCodexArgs({ prompt: "continue", cwd: "/work", resume: "thread_123" }), [
      "exec",
      "resume",
      "thread_123",
      "--json",
      "--sandbox",
      "workspace-write",
      "--skip-git-repo-check",
      "-",
    ]);
  });
});

describe("buildCodexCliEnv", () => {
  it("allowlists Codex credentials, gates GH_TOKEN, and drops unrelated secrets", () => {
    const env = buildCodexCliEnv({ prompt: "x", cwd: "/work", gh: false }, SRC);
    assert.equal(env.OPENAI_API_KEY, "sk-test");
    assert.equal(env.GH_TOKEN, undefined);
    assert.equal(env.DATABASE_URL, undefined);
    assert.equal(env.GIT_AUTHOR_NAME, "Brokk Bot");
    assert.equal(env.GIT_COMMITTER_EMAIL, "bot@brokk.dev");

    const withGh = buildCodexCliEnv({ prompt: "x", cwd: "/work", gh: true }, SRC);
    assert.equal(withGh.GH_TOKEN, "gh-secret");
    assert.equal(withGh.GITHUB_TOKEN, "gh-secret");
    assert.equal(withGh.DATABASE_URL, undefined);
  });
});

describe("handleCodexJsonLine", () => {
  function feed(lines: Record<string, unknown>[]): { events: AgentEvent[]; state: ReturnType<typeof newCodexJsonState> } {
    const state = newCodexJsonState();
    const events: AgentEvent[] = [];
    for (const line of lines) handleCodexJsonLine(line, (e) => events.push(e), state);
    return { events, state };
  }

  it("captures the thread id from thread.started", () => {
    const { events, state } = feed([{ type: "thread.started", thread_id: "thr_abc" }]);
    assert.equal(state.threadId, "thr_abc");
    assert.deepEqual(events, [{ type: "status", phase: "codex_init", detail: { threadId: "thr_abc" } }]);
  });

  it("turns a completed agent_message into text_delta and resultText", () => {
    const { events, state } = feed([
      { type: "item.completed", item: { id: "m1", type: "agent_message", text: "all done" } },
    ]);
    assert.equal(state.resultText, "all done");
    assert.deepEqual(events, [{ type: "text_delta", text: "all done" }]);
  });

  it("maps turn.completed usage", () => {
    const { state } = feed([
      {
        type: "turn.completed",
        usage: {
          input_tokens: 1200,
          output_tokens: 340,
          cached_input_tokens: 800,
          cache_write_input_tokens: 50,
          reasoning_output_tokens: 999,
        },
      },
    ]);
    const usage: TurnUsage = {
      inputTokens: 1200,
      outputTokens: 340,
      cacheReadTokens: 800,
      cacheCreationTokens: 50,
    };
    assert.deepEqual(state.usage, usage);
    assert.equal(state.terminal, "success");
  });

  it("emits exactly one tool_use and one tool_result for a command", () => {
    const { events } = feed([
      { type: "item.started", item: { id: "c1", type: "command_execution", command: "ls -la" } },
      { type: "item.updated", item: { id: "c1", type: "command_execution", command: "ls -la" } },
      {
        type: "item.completed",
        item: {
          id: "c1",
          type: "command_execution",
          command: "ls -la",
          aggregated_output: "file.txt\n",
          exit_code: 0,
          status: "completed",
        },
      },
    ]);
    assert.deepEqual(events, [
      { type: "tool_use", id: "c1", name: "shell", input: { command: "ls -la" } },
      { type: "tool_result", toolUseId: "c1", ok: true, preview: "file.txt\n" },
    ]);
  });

  it("emits only the new suffix of cumulative reasoning", () => {
    const { events } = feed([
      { type: "item.started", item: { id: "r1", type: "reasoning", text: "The plan" } },
      { type: "item.updated", item: { id: "r1", type: "reasoning", text: "The plan is to edit" } },
      { type: "item.completed", item: { id: "r1", type: "reasoning", text: "The plan is to edit the file." } },
    ]);
    assert.deepEqual(
      events.map((e) => (e.type === "thinking_delta" ? e.text : "")),
      ["The plan", " is to edit", " the file."],
    );
  });

  it("turns turn.failed into a terminal error", () => {
    const { events, state } = feed([{ type: "turn.failed", error: { message: "sandbox denied the write" } }]);
    assert.equal(state.terminal, "error");
    assert.deepEqual(events, [{ type: "error", message: "sandbox denied the write" }]);
  });
});
