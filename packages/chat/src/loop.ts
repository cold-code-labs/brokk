// ─────────────────────────────────────────────────────────────────────────────
// The agentic turn loop — Sindri's heart. One user message → drive the model and
// tools to completion, persisting every step so the turn survives a disconnect
// (overnight) and replays on reconnect:
//
//   append user msg → [ stream assistant → persist → if tool_use: run tools,
//   persist tool_results, repeat | else: stop ]
//
// Every completed message is written to chat_messages BEFORE the next round, so a
// crash/disconnect loses at most the in-flight (still-streaming) round. Live
// deltas + completed messages are emitted to `emit` for the SSE stream.
// ─────────────────────────────────────────────────────────────────────────────

import type { ChatSession } from "@brokk/core";
import type { Store } from "@brokk/db";
import type { ChatConfig } from "@brokk/afl";
import { resolveModel } from "@brokk/afl";
import { streamAssistant } from "@brokk/afl";
import { makeExecutor, TOOL_DEFS, type ToolContext } from "./tools.js";
import type { ChatTurnMessage, ContentBlock, SindriEvent, ToolResultBlock, ToolUseBlock } from "@brokk/afl";

export interface RunTurnInput {
  session: ChatSession;
  /** The user's new message text. */
  userText: string;
  cfg: ChatConfig;
  toolCtx: ToolContext;
  /** System prompt (built by buildSystemPrompt). */
  system: string;
  emit: (e: SindriEvent) => void;
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

  const exec = makeExecutor(toolCtx);

  for (let round = 0; round < cfg.maxRounds; round++) {
    if (signal?.aborted) {
      emit({ type: "status", phase: "aborted" });
      return;
    }
    emit({ type: "status", phase: "round", detail: { round } });

    const result = await streamAssistant(
      cfg,
      { model, system, messages, tools: TOOL_DEFS, maxTokens, thinkingBudget: budget },
      (d) => emit(d.type === "text_delta" ? { type: "text_delta", text: d.text } : { type: "thinking_delta", text: d.text }),
      signal,
    );

    // Persist the assistant round (text + thinking + tool_use) before running tools.
    const assistantMsg = await store.appendChatMessage(session.id, {
      role: "assistant",
      blocks: result.blocks,
      meta: { model, stopReason: result.stopReason, usage: result.usage },
    });
    messages.push({ role: "assistant", content: result.blocks });
    emit({ type: "message", seq: assistantMsg.seq, role: "assistant", blocks: result.blocks });
    emit({ type: "usage", usage: result.usage });

    const toolUses = result.blocks.filter((b): b is ToolUseBlock => b.type === "tool_use");
    if (result.stopReason !== "tool_use" || toolUses.length === 0) {
      emit({ type: "status", phase: "turn_done" });
      emit({ type: "done" });
      return;
    }

    // Execute each tool call; collect the results into one user message.
    const resultBlocks: ToolResultBlock[] = [];
    for (const tu of toolUses) {
      if (signal?.aborted) {
        emit({ type: "status", phase: "aborted" });
        return;
      }
      emit({ type: "tool_use", id: tu.id, name: tu.name, input: tu.input });
      const r = await exec(tu.name, tu.input);
      resultBlocks.push({ type: "tool_result", tool_use_id: tu.id, content: r.content, is_error: !r.ok });
      emit({ type: "tool_result", toolUseId: tu.id, ok: r.ok, preview: r.content.slice(0, 600) });
    }

    const toolMsg = await store.appendChatMessage(session.id, { role: "user", blocks: resultBlocks });
    messages.push({ role: "user", content: resultBlocks });
    emit({ type: "message", seq: toolMsg.seq, role: "user", blocks: resultBlocks });
  }

  emit({ type: "status", phase: "max_rounds", detail: { maxRounds: cfg.maxRounds } });
  emit({ type: "done" });
}
