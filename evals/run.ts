// Eval runner. `pnpm eval [--lane mock|llm|chat|all] [--only <id>] [--model sonnet]`
// Exit 0 = every task in every AVAILABLE lane passed. Unavailable lanes are
// SKIPPED loudly (missing gateway creds / docker), never silently.

import { execFileSync } from "node:child_process";
import { loadAflConfig, resolveModel } from "../packages/afl/src/index.js";
import { EvalFailure, makeSandbox, rmSandbox, withTimeout, type EvalCtx, type EvalTask } from "./harness.js";
import { mockTasks } from "./tasks-mock.js";
import { llmTasks } from "./tasks-llm.js";
import { buildTasks } from "./bundle-boot.eval.js";
import { chatTasks } from "./chat-turn.eval.js";

interface Outcome {
  id: string;
  lane: string;
  status: "pass" | "fail" | "skip";
  ms: number;
  retried: boolean;
  error?: string;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function hasDocker(): boolean {
  try {
    execFileSync("docker", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function runTask(task: EvalTask, model: string): Promise<Outcome> {
  const cfg = loadAflConfig();
  const attempt = async (): Promise<void> => {
    const sandbox = makeSandbox(task.id);
    const ctx: EvalCtx = { cfg, model: resolveModel(cfg, model), sandbox };
    try {
      await withTimeout(task.run(ctx), task.timeoutMs ?? 180_000, task.id);
    } finally {
      rmSandbox(sandbox);
    }
  };

  const start = Date.now();
  try {
    await attempt();
    return { id: task.id, lane: task.lane, status: "pass", ms: Date.now() - start, retried: false };
  } catch (e1) {
    // One retry for the LLM lane only (model flakiness ≠ regression). Mock/chat
    // lanes are deterministic — a failure there is a real bug, no retry.
    if (task.lane !== "llm") {
      return {
        id: task.id, lane: task.lane, status: "fail", ms: Date.now() - start, retried: false,
        error: e1 instanceof Error ? e1.message : String(e1),
      };
    }
    try {
      await attempt();
      return { id: task.id, lane: task.lane, status: "pass", ms: Date.now() - start, retried: true };
    } catch (e2) {
      return {
        id: task.id, lane: task.lane, status: "fail", ms: Date.now() - start, retried: true,
        error: e2 instanceof Error ? e2.message : String(e2),
      };
    }
  }
}

async function main(): Promise<void> {
  const laneArg = arg("lane") ?? "all";
  const only = arg("only");
  const model = arg("model") ?? process.env.EVAL_MODEL ?? "haiku";

  const cfg = loadAflConfig();
  const llmAvailable = !!cfg.authToken && process.env.EVAL_LLM !== "0";
  const chatAvailable = (hasDocker() || !!process.env.EVAL_PG_URL) && process.env.EVAL_CHAT !== "0";

  let tasks: EvalTask[] = [...mockTasks, ...buildTasks, ...chatTasks, ...llmTasks];
  if (laneArg !== "all") tasks = tasks.filter((t) => t.lane === laneArg);
  if (only) tasks = tasks.filter((t) => t.id === only);
  if (!tasks.length) {
    console.error(`no tasks match lane=${laneArg} only=${only ?? "-"}`);
    process.exit(2);
  }

  const outcomes: Outcome[] = [];
  for (const task of tasks) {
    if (task.lane === "llm" && !llmAvailable) {
      outcomes.push({ id: task.id, lane: task.lane, status: "skip", ms: 0, retried: false, error: "no ANTHROPIC_AUTH_TOKEN (or EVAL_LLM=0)" });
      continue;
    }
    if (task.lane === "chat" && !chatAvailable) {
      outcomes.push({ id: task.id, lane: task.lane, status: "skip", ms: 0, retried: false, error: "no docker / EVAL_PG_URL (or EVAL_CHAT=0)" });
      continue;
    }
    process.stdout.write(`▸ ${task.lane}/${task.id} ... `);
    const o = await runTask(task, task.model ?? model);
    outcomes.push(o);
    console.log(o.status === "pass" ? `ok${o.retried ? " (retried)" : ""} ${o.ms}ms` : `${o.status.toUpperCase()} ${o.ms}ms`);
    if (o.status === "fail") console.log(`    ${o.error?.split("\n")[0]}`);
  }

  const pass = outcomes.filter((o) => o.status === "pass").length;
  const fail = outcomes.filter((o) => o.status === "fail").length;
  const skip = outcomes.filter((o) => o.status === "skip").length;
  console.log(`\n${pass} pass · ${fail} fail · ${skip} skip  (model=${model})`);
  for (const o of outcomes.filter((x) => x.status === "fail")) {
    console.log(`\n✗ ${o.lane}/${o.id}\n  ${o.error}`);
  }
  for (const o of outcomes.filter((x) => x.status === "skip")) {
    console.log(`- skipped ${o.lane}/${o.id}: ${o.error}`);
  }
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
