// Golden semantic tasks against the REAL gateway. Fixed prompts + programmatic
// assertions; haiku by default (the weakest model = the strictest gate — if
// haiku passes reliably, the prompt/tool surface is sound). Each task gets one
// retry in the runner (LLM flakiness tolerance).

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  composeExecutors,
  FS_TOOL_DEFS,
  makeFsExecutor,
  runAgentLoop,
  streamAssistant,
  type ChatTurnMessage,
  type ToolDef,
} from "../packages/afl/src/index.js";
import { expect, lastAssistantText, toolsUsed, type EvalCtx, type EvalTask } from "./harness.js";

function seed(text: string): ChatTurnMessage[] {
  return [{ role: "user", content: [{ type: "text", text }] }];
}

async function agent(ctx: EvalCtx, prompt: string, extra?: { tools?: ToolDef[]; exec?: any }) {
  const messages = seed(prompt);
  const fsExec = makeFsExecutor({ cwd: ctx.sandbox, gh: false });
  const exec = extra?.exec ? composeExecutors(extra.exec, fsExec) : composeExecutors(fsExec);
  const result = await runAgentLoop({
    cfg: ctx.cfg,
    model: ctx.model,
    system:
      "You are a precise coding agent under evaluation. Work inside the current directory using the provided tools. Follow instructions EXACTLY. Be terse.",
    messages,
    tools: [...FS_TOOL_DEFS, ...(extra?.tools ?? [])],
    exec,
    maxTokens: 1024,
    maxRounds: 12,
  });
  return { messages, result };
}

export const llmTasks: EvalTask[] = [
  {
    id: "llm-plain-answer",
    lane: "llm",
    async run(ctx) {
      const messages = seed("Reply with exactly one word: pong");
      const result = await runAgentLoop({
        cfg: ctx.cfg,
        model: ctx.model,
        system: "You are under evaluation. Follow instructions exactly.",
        messages,
        tools: [],
        exec: async () => ({ ok: false, content: "no tools" }),
        maxTokens: 256,
        maxRounds: 2,
      });
      expect(result.stop === "end_turn", `stop=${result.stop}`);
      expect(/pong/i.test(lastAssistantText(messages)), `answer: ${lastAssistantText(messages)}`);
    },
  },

  {
    id: "llm-read-report",
    lane: "llm",
    async run(ctx) {
      writeFileSync(join(ctx.sandbox, "marker.txt"), "token: ZX-7741-QP\n");
      const { messages } = await agent(
        ctx,
        "Read the file marker.txt and reply with ONLY the token value it contains.",
      );
      expect(toolsUsed(messages).includes("read_file") || toolsUsed(messages).includes("bash"),
        `no read tool used: ${toolsUsed(messages).join(",")}`);
      expect(lastAssistantText(messages).includes("ZX-7741-QP"), `answer: ${lastAssistantText(messages)}`);
    },
  },

  {
    id: "llm-write-file",
    lane: "llm",
    async run(ctx) {
      await agent(ctx, 'Create a file named hello.txt containing exactly the text "HELLO-EVAL" (no quotes).');
      const p = join(ctx.sandbox, "hello.txt");
      expect(existsSync(p), "hello.txt not created");
      expect(readFileSync(p, "utf8").trim() === "HELLO-EVAL", `content: ${readFileSync(p, "utf8")}`);
    },
  },

  {
    id: "llm-edit-file",
    lane: "llm",
    async run(ctx) {
      writeFileSync(
        join(ctx.sandbox, "config.ts"),
        'export const VERSION = "1.0.0";\nexport const NAME = "demo";\n',
      );
      const { messages } = await agent(
        ctx,
        'In config.ts, change VERSION from "1.0.0" to "2.0.0". Touch nothing else.',
      );
      const out = readFileSync(join(ctx.sandbox, "config.ts"), "utf8");
      expect(out.includes('VERSION = "2.0.0"'), `VERSION not bumped:\n${out}`);
      expect(out.includes('NAME = "demo"'), `collateral damage:\n${out}`);
      expect(toolsUsed(messages).length > 0, "no tools used");
    },
  },

  {
    id: "llm-bash-count",
    lane: "llm",
    async run(ctx) {
      mkdirSync(join(ctx.sandbox, "notes"), { recursive: true });
      for (const n of ["a", "b", "c"]) writeFileSync(join(ctx.sandbox, "notes", `${n}.md`), `# ${n}\n`);
      writeFileSync(join(ctx.sandbox, "notes", "ignore.txt"), "x\n");
      const { messages } = await agent(
        ctx,
        "Count how many .md files exist under the notes/ directory. Reply with ONLY the number.",
      );
      expect(/\b3\b/.test(lastAssistantText(messages)), `answer: ${lastAssistantText(messages)}`);
    },
  },

  {
    id: "llm-structured-oneshot",
    lane: "llm",
    async run(ctx) {
      const submit: ToolDef = {
        name: "submit_answer",
        description: "Submit the final structured answer.",
        input_schema: {
          type: "object",
          properties: {
            capital: { type: "string", description: "the capital city" },
            population_millions: { type: "number" },
          },
          required: ["capital", "population_millions"],
        },
      };
      const result = await streamAssistant(
        ctx.cfg,
        {
          model: ctx.model,
          system: "Answer via the submit_answer tool only.",
          messages: seed("What is the capital of France? Include its city-proper population in millions."),
          tools: [submit],
          toolChoice: { type: "tool", name: "submit_answer" },
          maxTokens: 512,
        },
        () => {},
      );
      const tu = result.blocks.find((b) => b.type === "tool_use") as any;
      expect(tu, "no tool_use block under forced tool_choice");
      expect(/paris/i.test(String(tu.input.capital)), `capital: ${tu.input.capital}`);
      expect(
        typeof tu.input.population_millions === "number" && tu.input.population_millions > 0,
        `population: ${tu.input.population_millions}`,
      );
    },
  },

  {
    id: "llm-tool-error-recovery",
    lane: "llm",
    async run(ctx) {
      let calls = 0;
      const lookup: ToolDef = {
        name: "lookup_phrase",
        description: "Look up the secret phrase. May fail transiently — retry on failure.",
        input_schema: { type: "object", properties: {}, required: [] },
      };
      const { messages, result } = await agent(
        ctx,
        "Use lookup_phrase to fetch the secret phrase and reply with ONLY the phrase. If the tool fails temporarily, call it again.",
        {
          tools: [lookup],
          exec: async (name: string) => {
            if (name !== "lookup_phrase") return null;
            calls++;
            return calls === 1
              ? { ok: false, content: "transient backend error — please retry" }
              : { ok: true, content: "amber-falcon-42" };
          },
        },
      );
      expect(calls >= 2, `tool called ${calls}×, expected a retry after is_error`);
      expect(result.stop === "end_turn", `stop=${result.stop}`);
      expect(lastAssistantText(messages).includes("amber-falcon-42"), `answer: ${lastAssistantText(messages)}`);
    },
  },
];
