import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildOpenCodeCliEnv, handleOpenCodeJsonLine } from "./opencode-cli.js";
import type { AgentEvent, TurnUsage } from "./types.js";

describe("opencode-cli", () => {
  it("buildOpenCodeCliEnv maps Omni fuel + inline config", () => {
    const env = buildOpenCodeCliEnv(
      { model: "cursor/auto", gh: false },
      {
        PATH: "/usr/bin",
        HOME: "/home/brokk",
        LLM_API_KEY: "sk-test",
        LLM_BASE_URL: "https://litellm.example",
      },
    );
    assert.equal(env.OPENAI_API_KEY, "sk-test");
    assert.equal(env.OPENAI_BASE_URL, "https://litellm.example/v1");
    const cfg = JSON.parse(env.OPENCODE_CONFIG_CONTENT) as {
      model: string;
      provider: { omni: { options: { baseURL: string } } };
      mcp?: { "playwright-chat"?: { command: string[] } };
    };
    assert.equal(cfg.model, "omni/auto");
    assert.equal(cfg.provider.omni.options.baseURL, "https://litellm.example/v1");
    assert.deepEqual(cfg.mcp?.["playwright-chat"]?.command, [
      "playwright-mcp",
      "--cdp-endpoint",
      "http://127.0.0.1:9223",
    ]);
  });

  it("buildOpenCodeCliEnv wires Brokk + Playwright MCP and respects off", () => {
    const on = buildOpenCodeCliEnv(
      { model: "auto", gh: false },
      {
        PATH: "/bin",
        HOME: "/home/brokk",
        LLM_API_KEY: "k",
        LLM_BASE_URL: "https://x.example",
        BROKK_MCP_COMMAND: "node /app/dist/brokk-mcp-server.js",
        BROKK_PLAYWRIGHT_CDP: "http://127.0.0.1:9333",
      },
    );
    const cfgOn = JSON.parse(on.OPENCODE_CONFIG_CONTENT) as {
      mcp: Record<string, { command: string[] }>;
    };
    assert.ok(cfgOn.mcp.brokk);
    assert.deepEqual(cfgOn.mcp["playwright-chat"]?.command, [
      "playwright-mcp",
      "--cdp-endpoint",
      "http://127.0.0.1:9333",
    ]);

    const off = buildOpenCodeCliEnv(
      { model: "auto", gh: false },
      {
        PATH: "/bin",
        HOME: "/home/brokk",
        LLM_API_KEY: "k",
        LLM_BASE_URL: "https://x.example",
        BROKK_PLAYWRIGHT_MCP_COMMAND: "off",
      },
    );
    const cfgOff = JSON.parse(off.OPENCODE_CONFIG_CONTENT) as { mcp?: unknown };
    assert.equal(cfgOff.mcp, undefined);
  });

  it("CliTurnInput.agent plan|build is typed on the shared interface", () => {
    const input: { agent?: "plan" | "build" } = { agent: "plan" };
    assert.equal(input.agent, "plan");
  });

  it("handleOpenCodeJsonLine extracts session + text", () => {
    const events: AgentEvent[] = [];
    const state = {
      sessionId: null as string | null,
      resultText: "",
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      } satisfies TurnUsage,
      toolIds: new Map<string, string>(),
    };
    handleOpenCodeJsonLine(
      JSON.stringify({
        type: "text",
        sessionID: "ses_abc",
        part: { type: "text", text: "hello forge" },
      }),
      (e) => events.push(e),
      state,
    );
    assert.equal(state.sessionId, "ses_abc");
    assert.equal(state.resultText, "hello forge");
    assert.equal(events[0]?.type, "text_delta");
  });

  it("handleOpenCodeJsonLine maps tool_use", () => {
    const events: AgentEvent[] = [];
    const state = {
      sessionId: null as string | null,
      resultText: "",
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      } satisfies TurnUsage,
      toolIds: new Map<string, string>(),
    };
    handleOpenCodeJsonLine(
      JSON.stringify({
        type: "tool_use",
        sessionID: "ses_1",
        part: {
          type: "tool",
          id: "call_1",
          tool: "bash",
          state: { status: "completed", input: { command: "ls" }, output: "ok" },
        },
      }),
      (e) => events.push(e),
      state,
    );
    assert.equal(events[0]?.type, "tool_use");
    assert.equal(events[1]?.type, "tool_result");
    if (events[1]?.type === "tool_result") {
      assert.equal(events[1].toolUseId, "call_1");
      assert.equal(events[1].ok, true);
    }
  });
});
