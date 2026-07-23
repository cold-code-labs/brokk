import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildOpenHandsCliEnv } from "./openhands-cli.js";

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
