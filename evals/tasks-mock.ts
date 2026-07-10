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
];
