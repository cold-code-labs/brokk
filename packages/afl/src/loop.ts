// ─────────────────────────────────────────────────────────────────────────────
// The agent loop — Afl's beating heart, persona-free and dependency-pure. One
// call drives the model + tools to completion against a transcript:
//
//   [ stream assistant → if tool_use: run each tool, feed results back, repeat
//                        | else: stop ]
//
// It knows NOTHING about cards, PRs, chat sessions, the DB, or git — only the
// Messages protocol (via streamAssistant) and a ToolExecutor. Every side effect
// a consumer needs (persist a round, emit a UI event, trace usage) is a HOOK, so
// Sindri (DB-persisting) and Brokkr (worktree-forging) ride the SAME loop with
// different hooks. Since ADR 0027 this is the ONLY loop — every persona's turn
// (forge, chat, scout, reviewer) funnels through here.
//
// The `messages` array is MUTATED in place: the loop appends each assistant round
// and each tool-result round, so when it returns the caller holds the full
// transcript (to persist, to continue, or to inspect). See NORTH-STAR §5, §9.
// ─────────────────────────────────────────────────────────────────────────────

import { compactTranscript, type CompactionResult } from "./compact.js";
import type { AflConfig } from "./config.js";
import { type DeltaSink, streamAssistant } from "./gateway.js";
import type {
  ChatTurnMessage,
  ContentBlock,
  ToolDef,
  ToolExecutor,
  ToolResult,
  ToolResultBlock,
  ToolUseBlock,
  TurnUsage,
} from "./types.js";

/** Side-effect hooks fired as the loop runs. All optional; all may be async (the
 *  loop awaits them, so a consumer can persist-before-continue for crash safety). */
export interface AgentLoopHooks {
  /** A round is starting (before its assistant stream opens). */
  onRound?: (round: number) => void | Promise<void>;
  /** Live text/thinking deltas as the assistant streams. */
  onDelta?: DeltaSink;
  /** A completed assistant round (text + thinking + tool_use), already appended to
   *  the transcript, BEFORE its tools run. */
  onAssistant?: (
    blocks: ContentBlock[],
    meta: { stopReason: string; usage: TurnUsage; model: string },
  ) => void | Promise<void>;
  /** About to execute one tool call. */
  onToolUse?: (tu: ToolUseBlock) => void | Promise<void>;
  /** One tool call finished (result already collected for the feedback turn). */
  onToolResult?: (tu: ToolUseBlock, result: ToolResult) => void | Promise<void>;
  /** All tool results for a round, collected into the user turn fed back to the
   *  model, already appended to the transcript. */
  onToolResults?: (blocks: ToolResultBlock[]) => void | Promise<void>;
  /** Older rounds were folded into a summary message (context-only — persisted
   *  transcripts are untouched). */
  onCompaction?: (c: CompactionResult) => void | Promise<void>;
}

export interface AgentLoopOptions {
  cfg: AflConfig;
  /** Concrete model id (resolve aliases with resolveModel before calling). */
  model: string;
  system: string;
  /** The conversation so far — seeded with at least one user message. MUTATED in
   *  place: assistant + tool-result rounds are appended as the loop runs. */
  messages: ChatTurnMessage[];
  tools: ToolDef[];
  exec: ToolExecutor;
  maxTokens: number;
  /** Extended-thinking budget (tokens). Omit/0 = thinking off. */
  thinkingBudget?: number;
  /** Hard ceiling on tool-use rounds (runaway guard). */
  maxRounds: number;
  /** Cumulative token ceiling (input+output across every round of THIS call).
   *  Omit/0 = unlimited. When crossed the loop returns stop="budget" without
   *  running the pending round's tools — same terminal shape as an abort. */
  maxTotalTokens?: number;
  signal?: AbortSignal;
  hooks?: AgentLoopHooks;
}

export type AgentLoopStop = "end_turn" | "max_rounds" | "aborted" | "budget";

export interface AgentLoopResult {
  /** Why the loop returned. `end_turn` = the model finished (no tool_use). */
  stop: AgentLoopStop;
  /** Assistant rounds executed. */
  rounds: number;
  /** Usage accumulated across every round of THIS call. */
  usage: TurnUsage;
  /** The last assistant round's stop_reason from the API. */
  lastStopReason: string;
}

const noop: DeltaSink = () => {};

/**
 * Drive the model + tools to completion. Returns when the model stops calling
 * tools (`end_turn`), the round ceiling is hit (`max_rounds`), or the signal
 * aborts (`aborted`). The full transcript lives in the (mutated) `messages`.
 */
export async function runAgentLoop(opts: AgentLoopOptions): Promise<AgentLoopResult> {
  const { cfg, model, system, messages, tools, exec, maxTokens, thinkingBudget, maxRounds, signal, hooks } =
    opts;
  const usage: TurnUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
  let lastStopReason = "end_turn";
  // Context size as last reported by the API (input_tokens of the newest round) —
  // the compaction trigger. Best-effort: a failed summarize never kills the turn.
  let lastRoundInput = 0;

  for (let round = 0; round < maxRounds; round++) {
    if (signal?.aborted) return { stop: "aborted", rounds: round, usage, lastStopReason };
    if (cfg.compactInputTokens > 0 && lastRoundInput >= cfg.compactInputTokens) {
      lastRoundInput = 0;
      try {
        const c = await compactTranscript(cfg, messages, { signal });
        if (c) await hooks?.onCompaction?.(c);
      } catch {
        /* best-effort — the next round may still fit */
      }
    }
    await hooks?.onRound?.(round);

    const result = await streamAssistant(
      cfg,
      { model, system, messages, tools, maxTokens, thinkingBudget },
      hooks?.onDelta ?? noop,
      signal,
    );
    usage.inputTokens += result.usage.inputTokens;
    usage.outputTokens += result.usage.outputTokens;
    usage.cacheReadTokens += result.usage.cacheReadTokens;
    usage.cacheCreationTokens += result.usage.cacheCreationTokens;
    lastStopReason = result.stopReason;
    lastRoundInput = result.usage.inputTokens;

    messages.push({ role: "assistant", content: result.blocks });
    await hooks?.onAssistant?.(result.blocks, { stopReason: result.stopReason, usage: result.usage, model });

    const toolUses = result.blocks.filter((b): b is ToolUseBlock => b.type === "tool_use");
    if (result.stopReason !== "tool_use" || toolUses.length === 0) {
      return { stop: "end_turn", rounds: round + 1, usage, lastStopReason };
    }
    if (opts.maxTotalTokens && usage.inputTokens + usage.outputTokens >= opts.maxTotalTokens) {
      return { stop: "budget", rounds: round + 1, usage, lastStopReason };
    }

    // Run every tool call this round, collecting the results into one user turn.
    const resultBlocks: ToolResultBlock[] = [];
    for (const tu of toolUses) {
      if (signal?.aborted) return { stop: "aborted", rounds: round + 1, usage, lastStopReason };
      await hooks?.onToolUse?.(tu);
      const r = await exec(tu.name, tu.input);
      resultBlocks.push({ type: "tool_result", tool_use_id: tu.id, content: r.content, is_error: !r.ok });
      await hooks?.onToolResult?.(tu, r);
    }
    messages.push({ role: "user", content: resultBlocks });
    await hooks?.onToolResults?.(resultBlocks);
  }

  return { stop: "max_rounds", rounds: maxRounds, usage, lastStopReason };
}
