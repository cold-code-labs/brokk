// Deterministic loop-mechanics tasks (mock gateway — no model, no cost). These
// pin the kernel contract that consumers (Sindri persistence, forge heal loop)
// depend on: transcript shape, hook ordering, tool feedback, stops, usage.

import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  runAgentLoop,
  makeFsExecutor,
  type AflConfig,
  type ChatTurnMessage,
  type ToolExecutor,
} from "../packages/afl/src/index.js";
import { MockGateway, mockCfg } from "./mock-gateway.js";
import { expect, type EvalTask } from "./harness.js";

const ECHO_TOOL = {
  name: "echo",
  description: "Echo the given value back.",
  input_schema: {
    type: "object" as const,
    properties: { value: { type: "string" } },
    required: ["value"],
  },
};

function seed(text: string): ChatTurnMessage[] {
  return [{ role: "user", content: [{ type: "text", text }] }];
}

async function withMock<T>(fn: (gw: MockGateway, cfg: AflConfig) => Promise<T>): Promise<T> {
  const gw = new MockGateway();
  const base = await gw.start();
  try {
    return await fn(gw, mockCfg(base) as AflConfig);
  } finally {
    await gw.stop();
  }
}

export const mockTasks: EvalTask[] = [
  {
    id: "loop-tool-roundtrip",
    lane: "mock",
    async run() {
      await withMock(async (gw, cfg) => {
        gw.load([
          {
            blocks: [
              { type: "text", text: "calling the tool" },
              { type: "tool_use", id: "tu_1", name: "echo", input: { value: "ping" } },
            ],
            stopReason: "tool_use",
          },
          { blocks: [{ type: "text", text: "the tool said ping" }], stopReason: "end_turn" },
        ]);
        const events: string[] = [];
        const messages = seed("go");
        const exec: ToolExecutor = async (name, input) => {
          events.push(`exec:${name}`);
          return { ok: true, content: `echo:${(input as any).value}` };
        };
        const result = await runAgentLoop({
          cfg,
          model: "mock-haiku",
          system: "eval",
          messages,
          tools: [ECHO_TOOL],
          exec,
          maxTokens: 512,
          maxRounds: 8,
          hooks: {
            onAssistant: () => void events.push("assistant"),
            onToolUse: (tu) => void events.push(`tool_use:${tu.name}`),
            onToolResult: (tu, r) => void events.push(`tool_result:${r.ok}`),
            onToolResults: (blocks) => void events.push(`tool_results:${blocks.length}`),
          },
        });

        expect(result.stop === "end_turn", `stop=${result.stop}, want end_turn`);
        expect(result.rounds === 2, `rounds=${result.rounds}, want 2`);
        // Transcript: user, assistant(tool_use), user(tool_result), assistant(final)
        expect(messages.length === 4, `transcript len=${messages.length}, want 4`);
        expect(messages[1]!.role === "assistant" && messages[2]!.role === "user", "round shape wrong");
        const tr = messages[2]!.content[0]!;
        expect(tr.type === "tool_result" && tr.tool_use_id === "tu_1", "tool_result not fed back");
        expect((tr as any).content === "echo:ping", `tool_result content=${(tr as any).content}`);
        // Hook ordering is the persistence contract (Sindri writes on each hook).
        expect(
          events.join(",") ===
            "assistant,tool_use:echo,exec:echo,tool_result:true,tool_results:1,assistant",
          `hook order: ${events.join(",")}`,
        );
        // The 2nd request must carry the full transcript (3 messages).
        expect(gw.requests.length === 2, `requests=${gw.requests.length}`);
        expect(gw.requests[1].messages.length === 3, `2nd request msgs=${gw.requests[1].messages.length}`);
      });
    },
  },

  {
    id: "loop-multi-tool-round",
    lane: "mock",
    async run() {
      await withMock(async (gw, cfg) => {
        gw.load([
          {
            blocks: [
              { type: "tool_use", id: "tu_a", name: "echo", input: { value: "a" } },
              { type: "tool_use", id: "tu_b", name: "echo", input: { value: "b" } },
            ],
            stopReason: "tool_use",
          },
          { blocks: [{ type: "text", text: "done" }], stopReason: "end_turn" },
        ]);
        const order: string[] = [];
        const messages = seed("go");
        const result = await runAgentLoop({
          cfg,
          model: "mock-haiku",
          system: "eval",
          messages,
          tools: [ECHO_TOOL],
          exec: async (_n, input) => {
            order.push((input as any).value);
            return { ok: true, content: "ok" };
          },
          maxTokens: 512,
          maxRounds: 8,
        });
        expect(result.stop === "end_turn", `stop=${result.stop}`);
        expect(order.join(",") === "a,b", `tool exec order: ${order.join(",")}`);
        const feedback = messages[2]!;
        expect(
          feedback.content.length === 2 &&
            feedback.content.every((b) => b.type === "tool_result"),
          "both tool_results must land in ONE user turn",
        );
      });
    },
  },

  {
    id: "loop-max-rounds",
    lane: "mock",
    async run() {
      await withMock(async (gw, cfg) => {
        gw.load([
          {
            blocks: [{ type: "tool_use", id: "tu_x", name: "echo", input: { value: "again" } }],
            stopReason: "tool_use",
          },
        ]); // repeats forever
        const result = await runAgentLoop({
          cfg,
          model: "mock-haiku",
          system: "eval",
          messages: seed("go"),
          tools: [ECHO_TOOL],
          exec: async () => ({ ok: true, content: "ok" }),
          maxTokens: 512,
          maxRounds: 3,
        });
        expect(result.stop === "max_rounds", `stop=${result.stop}, want max_rounds`);
        expect(result.rounds === 3, `rounds=${result.rounds}, want 3`);
      });
    },
  },

  {
    id: "loop-abort",
    lane: "mock",
    async run() {
      await withMock(async (gw, cfg) => {
        gw.load([
          {
            blocks: [{ type: "tool_use", id: "tu_x", name: "echo", input: { value: "x" } }],
            stopReason: "tool_use",
          },
        ]);
        const ac = new AbortController();
        let execCalls = 0;
        const result = await runAgentLoop({
          cfg,
          model: "mock-haiku",
          system: "eval",
          messages: seed("go"),
          tools: [ECHO_TOOL],
          exec: async () => {
            execCalls++;
            return { ok: true, content: "ok" };
          },
          maxTokens: 512,
          maxRounds: 8,
          signal: ac.signal,
          hooks: { onAssistant: () => void ac.abort() }, // abort right after round 1 streams
        });
        expect(result.stop === "aborted", `stop=${result.stop}, want aborted`);
        expect(execCalls === 0, `exec ran ${execCalls}× after abort, want 0`);
      });
    },
  },

  {
    id: "loop-usage-and-deltas",
    lane: "mock",
    async run() {
      await withMock(async (gw, cfg) => {
        gw.load([
          {
            blocks: [{ type: "tool_use", id: "t1", name: "echo", input: { value: "x" } }],
            stopReason: "tool_use",
            inputTokens: 111,
            outputTokens: 22,
          },
          {
            blocks: [{ type: "text", text: "final answer" }],
            stopReason: "end_turn",
            inputTokens: 333,
            outputTokens: 44,
          },
        ]);
        let streamed = "";
        const messages = seed("go");
        const result = await runAgentLoop({
          cfg,
          model: "mock-haiku",
          system: "eval",
          messages,
          tools: [ECHO_TOOL],
          exec: async () => ({ ok: true, content: "ok" }),
          maxTokens: 512,
          maxRounds: 8,
          hooks: { onDelta: (d) => void (d.type === "text_delta" && (streamed += d.text)) },
        });
        expect(result.usage.inputTokens === 444, `inputTokens=${result.usage.inputTokens}, want 444`);
        expect(result.usage.outputTokens === 66, `outputTokens=${result.usage.outputTokens}, want 66`);
        expect(streamed === "final answer", `streamed deltas=${JSON.stringify(streamed)}`);
      });
    },
  },

  {
    id: "loop-token-budget",
    lane: "mock",
    async run() {
      await withMock(async (gw, cfg) => {
        gw.load([
          {
            blocks: [{ type: "tool_use", id: "t1", name: "echo", input: { value: "x" } }],
            stopReason: "tool_use",
            inputTokens: 400,
            outputTokens: 100,
          },
        ]); // repeats — every round costs 500 tokens
        let execCalls = 0;
        const result = await runAgentLoop({
          cfg,
          model: "mock-haiku",
          system: "eval",
          messages: seed("go"),
          tools: [ECHO_TOOL],
          exec: async () => {
            execCalls++;
            return { ok: true, content: "ok" };
          },
          maxTokens: 512,
          maxRounds: 8,
          maxTotalTokens: 600,
        });
        expect(result.stop === "budget", `stop=${result.stop}, want budget`);
        expect(result.rounds === 2, `rounds=${result.rounds}, want 2 (500 < 600 ≤ 1000)`);
        expect(execCalls === 1, `exec ran ${execCalls}×, want 1 (round 2's tools must NOT run)`);
        expect(result.usage.inputTokens + result.usage.outputTokens === 1000, "usage accounting drifted");
      });
    },
  },

  {
    id: "loop-compaction",
    lane: "mock",
    async run() {
      await withMock(async (gw, cfg) => {
        (cfg as any).compactInputTokens = 5000; // trigger threshold
        gw.load([
          // rounds 1-3: small context, tool churn builds transcript length
          { blocks: [{ type: "tool_use", id: "t1", name: "echo", input: { value: "1" } }], stopReason: "tool_use", inputTokens: 100 },
          { blocks: [{ type: "tool_use", id: "t2", name: "echo", input: { value: "2" } }], stopReason: "tool_use", inputTokens: 200 },
          // round 3 reports a BIG context → compaction fires before round 4
          { blocks: [{ type: "tool_use", id: "t3", name: "echo", input: { value: "3" } }], stopReason: "tool_use", inputTokens: 9000 },
          // the compaction summarizer call itself:
          { blocks: [{ type: "text", text: "SUMMARY-MARK: user wants echoes; t1,t2 done" }], stopReason: "end_turn" },
          // round 4 (post-compaction) finishes the turn
          { blocks: [{ type: "text", text: "all done" }], stopReason: "end_turn" },
        ]);
        let compacted = 0;
        const messages = seed("go");
        const result = await runAgentLoop({
          cfg,
          model: "mock-haiku",
          system: "eval",
          messages,
          tools: [ECHO_TOOL],
          exec: async () => ({ ok: true, content: "ok" }),
          maxTokens: 512,
          maxRounds: 8,
          hooks: { onCompaction: (c) => void (compacted = c.dropped) },
        });
        expect(result.stop === "end_turn", `stop=${result.stop}`);
        expect(compacted > 0, "onCompaction never fired");
        // The post-compaction request must open with the summary user message and
        // keep the surviving tail's tool pairing intact.
        const lastReq = gw.requests[gw.requests.length - 1];
        const first = lastReq.messages[0];
        expect(
          first.role === "user" && JSON.stringify(first.content).includes("SUMMARY-MARK"),
          "compacted request does not start with the summary",
        );
        const roles = lastReq.messages.map((m: any) => m.role).join(",");
        expect(roles.startsWith("user,assistant"), `post-compaction roles: ${roles}`);
        // The summarizer request itself must carry NO tools (plain completion).
        const summarizerReq = gw.requests[3];
        expect(!summarizerReq.tools, "summarizer request leaked the tool defs");
        // In-memory transcript shrank but kept the tail (assistant t3 + its result + final).
        expect(
          messages.some((m) => JSON.stringify(m.content).includes("SUMMARY-MARK")),
          "summary message not in transcript",
        );
      });
    },
  },

  {
    id: "loop-apikey-auth",
    lane: "mock",
    async run() {
      await withMock(async (gw, cfg) => {
        gw.load([{ blocks: [{ type: "text", text: "ok" }], stopReason: "end_turn" }]);
        (cfg as any).authKind = "apikey";
        (cfg as any).authToken = "sk-ant-eval-key";
        await runAgentLoop({
          cfg,
          model: "mock-haiku",
          system: "eval",
          messages: seed("hi"),
          tools: [],
          exec: async () => ({ ok: false, content: "none" }),
          maxTokens: 128,
          maxRounds: 1,
        });
        const h = gw.headers[0]!;
        expect(h["x-api-key"] === "sk-ant-eval-key", `x-api-key header: ${h["x-api-key"]}`);
        expect(!h["authorization"], `authorization must be absent in apikey mode: ${h["authorization"]}`);
        expect(!!h["anthropic-version"], "anthropic-version header missing");
      });
    },
  },

  {
    id: "fs-executor-contract",
    lane: "mock",
    async run(ctx) {
      const exec = makeFsExecutor({ cwd: ctx.sandbox, gh: false });
      // write → read round-trip
      const w = await exec("write_file", { path: "a/b.txt", content: "hello\n" });
      expect(w?.ok === true, `write_file failed: ${w?.content}`);
      expect(readFileSync(join(ctx.sandbox, "a/b.txt"), "utf8") === "hello\n", "write content mismatch");
      const r = await exec("read_file", { path: "a/b.txt" });
      expect(r?.ok === true && r.content.includes("hello"), "read_file mismatch");
      // edit_file: exact unique replacement
      writeFileSync(join(ctx.sandbox, "v.ts"), 'const VERSION = "1.0.0";\n');
      const e = await exec("edit_file", {
        path: "v.ts",
        old_string: '"1.0.0"',
        new_string: '"2.0.0"',
      });
      expect(
        readFileSync(join(ctx.sandbox, "v.ts"), "utf8").includes('"2.0.0"'),
        `edit_file did not apply (result: ${e?.content})`,
      );
      // path escape must be rejected (never serve /etc content)
      const esc = await exec("read_file", { path: "../../../../etc/hostname" });
      expect(esc !== null && esc.ok === false, "path escape must fail");
      // list_dir sees the tree
      mkdirSync(join(ctx.sandbox, "docs"), { recursive: true });
      const l = await exec("list_dir", { path: "." });
      expect(l?.ok === true && l.content.includes("docs"), "list_dir missing entry");
      expect(existsSync(join(ctx.sandbox, "a/b.txt")), "sandbox file vanished");
    },
  },

  {
    id: "bash-env-allowlist",
    lane: "mock",
    async run(ctx) {
      process.env.EVAL_SECRET_CANARY = "canary-9f31-value";
      try {
        const exec = makeFsExecutor({ cwd: ctx.sandbox, gh: false });
        const echo = await exec("bash", { command: "echo eval-bash-ok" });
        expect(echo?.ok === true && echo.content.includes("eval-bash-ok"), `bash broken: ${echo?.content}`);
        const leak = await exec("bash", { command: 'printf "%s" "$EVAL_SECRET_CANARY"' });
        expect(leak !== null, "bash returned null");
        expect(
          !leak!.content.includes("canary-9f31-value"),
          "N1 env allowlist LEAKED a process secret into the agent shell",
        );
      } finally {
        delete process.env.EVAL_SECRET_CANARY;
      }
    },
  },

  {
    id: "cache-control-and-tokens",
    lane: "mock",
    async run() {
      await withMock(async (gw, cfg) => {
        gw.load([
          {
            blocks: [{ type: "text", text: "first response" }],
            stopReason: "end_turn",
            inputTokens: 100,
            outputTokens: 50,
            cacheCreationTokens: 1024, // first round: cache is created
            cacheReadTokens: 0,
          },
          {
            blocks: [{ type: "text", text: "second response" }],
            stopReason: "end_turn",
            inputTokens: 50,
            outputTokens: 50,
            cacheCreationTokens: 0, // second round: no new cache creation
            cacheReadTokens: 1024, // cache read tokens from the previously cached system
          },
        ]);

        const messages = seed("hello");
        let roundCount = 0;
        const result = await runAgentLoop({
          cfg,
          model: "mock-haiku",
          system: "stable system prompt for testing cache",
          messages,
          tools: [],
          exec: async () => ({ ok: false, content: "" }),
          maxTokens: 512,
          maxRounds: 2,
          hooks: {
            onAssistant: () => void roundCount++,
          },
        });

        // Verify the loop ran 2 rounds
        expect(result.rounds === 2, `rounds=${result.rounds}, want 2`);
        expect(roundCount === 2, `onAssistant hook fired ${roundCount}× instead of 2`);

        // Verify that both requests were sent
        expect(gw.requests.length === 2, `requests count=${gw.requests.length}, want 2`);

        // Verify the first request has system as a block array with cache_control
        const firstReq = gw.requests[0]!;
        expect(Array.isArray(firstReq.system), `1st request system should be array, got ${typeof firstReq.system}`);
        expect(
          firstReq.system.length === 1 &&
          firstReq.system[0]?.type === "text" &&
          firstReq.system[0]?.cache_control?.type === "ephemeral",
          `1st request system[0] missing cache_control: ${JSON.stringify(firstReq.system[0])}`,
        );

        // Verify the second request also sends system with cache_control
        const secondReq = gw.requests[1]!;
        expect(Array.isArray(secondReq.system), `2nd request system should be array, got ${typeof secondReq.system}`);
        expect(
          secondReq.system.length === 1 &&
          secondReq.system[0]?.type === "text" &&
          secondReq.system[0]?.cache_control?.type === "ephemeral",
          `2nd request system[0] missing cache_control: ${JSON.stringify(secondReq.system[0])}`,
        );

        // Verify usage accumulation: first round should report cache creation, second should report cache reads
        expect(
          result.usage.cacheCreationTokens === 1024,
          `cacheCreationTokens=${result.usage.cacheCreationTokens}, want 1024`,
        );
        expect(
          result.usage.cacheReadTokens === 1024,
          `cacheReadTokens=${result.usage.cacheReadTokens}, want 1024`,
        );

        // Verify that the text content was streamed correctly
        expect(messages.length === 2, `transcript len=${messages.length}, want 2 (user, assistant)`);
        const assistantContent = messages[1]?.content;
        const textBlock = assistantContent?.find((b) => b.type === "text");
        expect(
          textBlock?.type === "text" && (textBlock as any).text.includes("second response"),
          "assistant message should contain text from both rounds",
        );
      });
    },
  },
];
