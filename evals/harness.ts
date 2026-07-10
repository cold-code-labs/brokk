// ─────────────────────────────────────────────────────────────────────────────
// Golden-task eval harness (ADR 0027 §5.2). Three lanes:
//
//   mock — deterministic loop-mechanics tasks against a scripted SSE gateway.
//          Free, fast, runs anywhere. These are the regression net for kernel
//          changes (loop unification, compaction).
//   llm  — semantic tasks against the real gateway (needs ANTHROPIC_AUTH_TOKEN
//          + ANTHROPIC_BASE_URL). Measures agent quality on fixed golden tasks.
//   chat — Sindri runTurn persistence contract against a throwaway Postgres +
//          the mock gateway (needs docker or EVAL_PG_URL).
//
// Run: pnpm eval            (all available lanes)
//      pnpm eval --lane mock --only loop-tool-roundtrip
// ─────────────────────────────────────────────────────────────────────────────

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AflConfig, ContentBlock, TextBlock } from "../packages/afl/src/index.js";

export interface EvalCtx {
  /** Afl config pointed at the lane's gateway (real or mock). */
  cfg: AflConfig;
  /** Concrete model id (llm lane) or a mock id. */
  model: string;
  /** Fresh scratch dir, removed after the task. */
  sandbox: string;
}

export interface EvalTask {
  id: string;
  lane: "mock" | "llm" | "chat";
  /** Model alias for the llm lane. Default haiku (weakest = strictest gate). */
  model?: "haiku" | "sonnet";
  timeoutMs?: number;
  run(ctx: EvalCtx): Promise<void>;
}

export class EvalFailure extends Error {}

export function expect(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new EvalFailure(msg);
}

export function makeSandbox(id: string): string {
  return mkdtempSync(join(tmpdir(), `brokk-eval-${id.replace(/[^a-z0-9-]/gi, "_")}-`));
}

export function rmSandbox(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

export function withTimeout<T>(p: Promise<T>, ms: number, id: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new EvalFailure(`${id}: timed out after ${ms}ms`)), ms);
    t.unref?.();
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/** Concatenated text of the last assistant message in a transcript. */
export function lastAssistantText(messages: { role: string; content: ContentBlock[] }[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "assistant") continue;
    return m.content
      .filter((b): b is TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
  }
  return "";
}

/** All tool names used across a transcript, in order. */
export function toolsUsed(messages: { role: string; content: ContentBlock[] }[]): string[] {
  const out: string[] = [];
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    for (const b of m.content) if (b.type === "tool_use") out.push(b.name);
  }
  return out;
}
