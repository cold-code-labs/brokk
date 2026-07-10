// The Sindri persistence contract: run a REAL runTurn against a throwaway
// Postgres, with the mock gateway scripting the model. Deterministic, no
// tokens. This is the eval the loop unification (ADR 0027 §2.1) must keep
// green — it pins exactly what chat_messages/emit must look like per round.

import { execFileSync } from "node:child_process";
import { createDb, createStore, ensureChatSchema, ensureSchema } from "../packages/db/src/index.js";
import { runTurn } from "../packages/agents/chat/src/loop.js";
import type { AflConfig, AgentEvent } from "../packages/afl/src/index.js";
import { MockGateway, mockCfg } from "./mock-gateway.js";
import { expect, type EvalTask } from "./harness.js";

const PG_CONTAINER = "brokk-eval-pg";
const PG_PORT = 15499;

function sh(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { encoding: "utf8" });
}

async function startPg(): Promise<string> {
  if (process.env.EVAL_PG_URL) return process.env.EVAL_PG_URL;
  try {
    sh("docker", ["rm", "-f", PG_CONTAINER]);
  } catch {
    /* not running */
  }
  sh("docker", [
    "run", "-d", "--name", PG_CONTAINER,
    "-e", "POSTGRES_PASSWORD=eval", "-e", "POSTGRES_DB=eval",
    "-p", `127.0.0.1:${PG_PORT}:5432`,
    "postgres:16-alpine",
  ]);
  for (let i = 0; i < 60; i++) {
    try {
      sh("docker", ["exec", PG_CONTAINER, "pg_isready", "-U", "postgres"]);
      await new Promise((r) => setTimeout(r, 500)); // isready flips slightly before accepting
      return `postgres://postgres:eval@127.0.0.1:${PG_PORT}/eval`;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error("eval postgres never became ready");
}

function stopPg(): void {
  if (process.env.EVAL_PG_URL) return; // caller-managed
  try {
    sh("docker", ["rm", "-f", PG_CONTAINER]);
  } catch {
    /* already gone */
  }
}

export const chatTasks: EvalTask[] = [
  {
    id: "chat-turn-persistence",
    lane: "chat",
    timeoutMs: 120_000,
    async run(ctx) {
      const gw = new MockGateway();
      const base = await gw.start();
      const url = await startPg();
      try {
        // Fresh DB: core tables come from drizzle push (as in real provisioning),
        // then the self-heal DDL layers the chat/scout tables on top.
        execFileSync("pnpm", ["--filter", "@brokk/db", "db:push", "--force"], {
          env: { ...process.env, BROKK_DATABASE_URL: url },
          cwd: new URL("..", import.meta.url).pathname,
          stdio: "pipe",
        });
        const { db } = createDb(url);
        await ensureSchema(db);
        await ensureChatSchema(db);
        const store = createStore(db);

        const repo = await store.insertRepository({
          fullName: "eval/demo",
          owner: "eval",
          name: "demo",
          cloneUrl: "https://example.invalid/eval/demo.git",
        });
        const project = await store.insertProject({
          name: "demo",
          repositoryId: repo.id,
          model: "haiku",
        } as any);
        let session = await store.insertChatSession({
          projectId: project.id,
          title: "New chat",
          model: "haiku",
        } as any);
        session = await store.updateChatSession(session.id, { branch: "sindri/eval0001" });

        gw.load([
          {
            blocks: [
              { type: "text", text: "let me check the tree" },
              { type: "tool_use", id: "tu_ls", name: "list_dir", input: { path: "." } },
            ],
            stopReason: "tool_use",
            inputTokens: 120,
            outputTokens: 30,
          },
          {
            blocks: [{ type: "text", text: "done: EVAL-TURN-OK" }],
            stopReason: "end_turn",
            inputTokens: 200,
            outputTokens: 20,
          },
        ]);

        const events: AgentEvent[] = [];
        const cfg = mockCfg(base) as AflConfig;
        await runTurn({
          session,
          userText: "list the project files please",
          cfg,
          toolCtx: { cwd: ctx.sandbox, projectId: project.id, store, baseBranch: "dev" },
          system: "You are Sindri under evaluation. Use tools as needed.",
          emit: (e) => void events.push(e),
        });

        // ── The persistence contract ────────────────────────────────────────
        const msgs = await store.listChatMessages(session.id);
        expect(msgs.length === 4, `chat_messages rows=${msgs.length}, want 4`);
        expect(
          msgs.map((m) => m.role).join(",") === "user,assistant,user,assistant",
          `roles: ${msgs.map((m) => m.role).join(",")}`,
        );
        const seqs = msgs.map((m) => m.seq);
        expect(
          seqs.every((s, i) => i === 0 || s > seqs[i - 1]!),
          `seq not strictly increasing: ${seqs.join(",")}`,
        );
        const asst1 = msgs[1]!;
        expect(
          (asst1.blocks as any[]).some((b) => b.type === "tool_use" && b.name === "list_dir"),
          "assistant round 1 lost its tool_use block",
        );
        expect((asst1.meta as any)?.usage?.outputTokens === 30, `round1 meta.usage: ${JSON.stringify(asst1.meta)}`);
        const toolMsg = msgs[2]!;
        expect(
          (toolMsg.blocks as any[]).every((b) => b.type === "tool_result" && b.tool_use_id === "tu_ls"),
          "tool_result round malformed",
        );
        const final = msgs[3]!;
        expect(
          (final.blocks as any[]).some((b) => b.type === "text" && b.text.includes("EVAL-TURN-OK")),
          "final assistant text missing",
        );

        // ── The event-stream contract (what the SSE pane renders) ──────────
        const kinds = events.map((e: any) => e.type);
        for (const k of ["status", "message", "usage", "tool_use", "tool_result", "done"]) {
          expect(kinds.includes(k), `emit stream missing "${k}" (${kinds.join(",")})`);
        }
        const phases = events.filter((e: any) => e.type === "status").map((e: any) => e.phase);
        expect(phases.includes("turn_done"), `no turn_done phase: ${phases.join(",")}`);
        // Title derived from the first user message.
        const title = (await store.getChatSession(session.id))?.title ?? "";
        expect(title.startsWith("list the project files"), `title not derived: "${title}"`);
        // Two gateway requests; the 2nd carried the tool_result back.
        expect(gw.requests.length === 2, `gateway requests=${gw.requests.length}`);
      } finally {
        await gw.stop();
        stopPg();
      }
    },
  },
];
