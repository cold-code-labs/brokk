// ─────────────────────────────────────────────────────────────────────────────
// Sindri's turn = the kernel loop + persistence/streaming HOOKS (ADR 0027 §2.1).
// One user message → runAgentLoop drives the model and tools to completion;
// every side effect Sindri needs rides the kernel's hooks:
//
//   onAssistant / onToolResults → persist to chat_messages BEFORE the next round
//                                 (a crash/disconnect loses at most the in-flight
//                                 round; the turn survives overnight)
//   onDelta / onToolUse / ...   → the SSE event stream the workbench renders
//
// This file used to carry its own copy of the tool loop (the pre-extraction
// sibling); since ADR 0027 there is ONE loop — packages/afl/src/loop.ts.
// ─────────────────────────────────────────────────────────────────────────────

import type { ChatSession } from "@brokk/core";
import type { Store } from "@brokk/db";
import type { AflConfig } from "@brokk/afl";
import { resolveModel, runAgentLoop } from "@brokk/afl";
import { makeExecutor, TOOL_DEFS, type ToolContext } from "./tools.js";
import type { ChatTurnMessage, ContentBlock, AgentEvent, ToolDef } from "@brokk/afl";

export interface RunTurnInput {
  session: ChatSession;
  /** The user's new message text. */
  userText: string;
  cfg: AflConfig;
  toolCtx: ToolContext;
  /** System prompt (built by buildSystemPrompt). */
  system: string;
  /** Extra tool defs the host mounts (e.g. MCP, ADR 0027 §4.1) — executed by
   *  toolCtx.extraExec. */
  extraTools?: ToolDef[];
  emit: (e: AgentEvent) => void;
  signal?: AbortSignal;
}

/** Map a session's effort to an extended-thinking budget. null/low = off. */
function thinkingBudget(effort: string | null): number {
  switch ((effort ?? "").toLowerCase()) {
    case "high":
      return 6000;
    case "medium":
      return 2500;
    default:
      return 0;
  }
}

/** Rough title from the first user message — no extra model call. */
function deriveTitle(text: string): string {
  const t = text.replace(/\s+/g, " ").trim().slice(0, 60);
  return t.length ? t : "New chat";
}

export async function runTurn(input: RunTurnInput): Promise<void> {
  const { session, cfg, toolCtx, system, emit, signal } = input;
  const store: Store = toolCtx.store;
  const model = resolveModel(cfg, session.model);
  const budget = thinkingBudget(session.effort);
  const maxTokens = Math.max(cfg.maxTokens, budget + 1024);

  emit({ type: "status", phase: "turn_start", detail: { model } });

  // Persist the user's message, then load the full transcript as the API context.
  const userMsg = await store.appendChatMessage(session.id, {
    role: "user",
    blocks: [{ type: "text", text: input.userText }],
  });
  emit({ type: "message", seq: userMsg.seq, role: "user", blocks: userMsg.blocks as ContentBlock[] });

  // First turn → give the session a human title.
  if (session.title === "New chat" || !session.title) {
    const title = deriveTitle(input.userText);
    await store.updateChatSession(session.id, { title }).catch(() => {});
    emit({ type: "title", title });
  }

  const history = await store.listChatMessages(session.id);
  const messages: ChatTurnMessage[] = history.map((m) => ({
    role: m.role,
    content: m.blocks as ContentBlock[],
  }));

  const result = await runAgentLoop({
    cfg,
    model,
    system,
    messages,
    tools: input.extraTools?.length ? [...TOOL_DEFS, ...input.extraTools] : TOOL_DEFS,
    exec: makeExecutor(toolCtx),
    maxTokens,
    thinkingBudget: budget,
    maxRounds: cfg.maxRounds,
    maxTotalTokens: cfg.turnTokenBudget || undefined,
    signal,
    hooks: {
      onRound: (round) => emit({ type: "status", phase: "round", detail: { round } }),
      onDelta: (d) =>
        emit(
          d.type === "text_delta"
            ? { type: "text_delta", text: d.text }
            : { type: "thinking_delta", text: d.text },
        ),
      // Persist the assistant round (text + thinking + tool_use) before its tools run.
      onAssistant: async (blocks, meta) => {
        const assistantMsg = await store.appendChatMessage(session.id, {
          role: "assistant",
          blocks,
          meta: { model, stopReason: meta.stopReason, usage: meta.usage },
        });
        emit({ type: "message", seq: assistantMsg.seq, role: "assistant", blocks });
        emit({ type: "usage", usage: meta.usage });
      },
      onToolUse: (tu) => emit({ type: "tool_use", id: tu.id, name: tu.name, input: tu.input }),
      onToolResult: (tu, r) =>
        emit({ type: "tool_result", toolUseId: tu.id, ok: r.ok, preview: r.content.slice(0, 600) }),
      // Persist the round's tool results as one user message before the next round.
      onToolResults: async (blocks) => {
        const toolMsg = await store.appendChatMessage(session.id, { role: "user", blocks });
        emit({ type: "message", seq: toolMsg.seq, role: "user", blocks });
      },
    },
  });

  switch (result.stop) {
    case "aborted":
      emit({ type: "status", phase: "aborted" });
      return;
    case "max_rounds":
      emit({ type: "status", phase: "max_rounds", detail: { maxRounds: cfg.maxRounds } });
      emit({ type: "done" });
      return;
    case "budget":
      emit({ type: "status", phase: "budget", detail: { maxTotalTokens: cfg.turnTokenBudget } });
      emit({ type: "done" });
      return;
    default:
      emit({ type: "status", phase: "turn_done" });
      emit({ type: "done" });
  }
}
