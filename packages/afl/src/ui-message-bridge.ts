// AgentEvent → UIMessageChunk (AI SDK UI Message Stream v1).
// Stateful: text/reasoning need start/delta/end with stable ids per turn.

import type { UIMessageChunk } from "ai";
import type { AgentEvent } from "./types.js";

export type SindriMessageMetadata = {
  engine?: string;
  model?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens?: number;
  };
  title?: string;
};

/** Mutable converter — one instance per SSE subscriber / turn replay. */
export class UiMessageBridge {
  private textOpen = false;
  private reasoningOpen = false;
  private textId = "text-1";
  private reasoningId = "reasoning-1";
  private started = false;
  private textSeq = 0;
  private reasoningSeq = 0;

  reset(): void {
    this.textOpen = false;
    this.reasoningOpen = false;
    this.started = false;
    this.textSeq = 0;
    this.reasoningSeq = 0;
  }

  /** Convert one AgentEvent into zero or more UIMessage chunks. */
  push(e: AgentEvent): UIMessageChunk[] {
    const out: UIMessageChunk[] = [];
    const ensureStart = (meta?: SindriMessageMetadata) => {
      if (this.started) return;
      this.started = true;
      out.push({ type: "start", messageMetadata: meta });
      out.push({ type: "start-step" });
    };

    switch (e.type) {
      case "status": {
        ensureStart();
        if (e.phase === "diff_summary") {
          out.push({
            type: "data-sindri-diff",
            data: e.detail ?? {},
          } as UIMessageChunk);
        }
        out.push({
          type: "data-sindri-status",
          data: { phase: e.phase, detail: e.detail ?? null },
          transient: true,
        } as UIMessageChunk);
        break;
      }
      case "title": {
        ensureStart({ title: e.title });
        out.push({
          type: "message-metadata",
          messageMetadata: { title: e.title } satisfies SindriMessageMetadata,
        });
        break;
      }
      case "usage": {
        ensureStart();
        out.push({
          type: "message-metadata",
          messageMetadata: { usage: e.usage } satisfies SindriMessageMetadata,
        });
        break;
      }
      case "text_delta": {
        ensureStart();
        this.closeReasoning(out);
        if (!this.textOpen) {
          this.textSeq += 1;
          this.textId = `text-${this.textSeq}`;
          out.push({ type: "text-start", id: this.textId });
          this.textOpen = true;
        }
        if (e.text) out.push({ type: "text-delta", id: this.textId, delta: e.text });
        break;
      }
      case "thinking_delta": {
        ensureStart();
        this.closeText(out);
        if (!this.reasoningOpen) {
          this.reasoningSeq += 1;
          this.reasoningId = `reasoning-${this.reasoningSeq}`;
          out.push({ type: "reasoning-start", id: this.reasoningId });
          this.reasoningOpen = true;
        }
        if (e.text) out.push({ type: "reasoning-delta", id: this.reasoningId, delta: e.text });
        break;
      }
      case "tool_use": {
        ensureStart();
        this.closeText(out);
        this.closeReasoning(out);
        out.push({
          type: "tool-input-start",
          toolCallId: e.id,
          toolName: e.name,
        });
        out.push({
          type: "tool-input-available",
          toolCallId: e.id,
          toolName: e.name,
          input: e.input,
        });
        break;
      }
      case "tool_result": {
        ensureStart();
        if (e.ok) {
          out.push({
            type: "tool-output-available",
            toolCallId: e.toolUseId,
            output: e.preview,
          });
        } else {
          out.push({
            type: "tool-output-error",
            toolCallId: e.toolUseId,
            errorText: e.preview || "tool failed",
          });
        }
        break;
      }
      case "message": {
        // Late subscribers: surface tool_use blocks if streaming missed them.
        // Live text already came via text_delta — do not re-emit prose here.
        ensureStart();
        for (const b of e.blocks) {
          if (b.type === "tool_use") {
            out.push({
              type: "tool-input-available",
              toolCallId: b.id,
              toolName: b.name,
              input: b.input,
            });
          }
        }
        break;
      }
      case "done": {
        this.closeText(out);
        this.closeReasoning(out);
        if (this.started) {
          out.push({ type: "finish-step" });
          out.push({ type: "finish", finishReason: "stop" });
        }
        break;
      }
      case "error": {
        this.closeText(out);
        this.closeReasoning(out);
        out.push({ type: "error", errorText: e.message });
        if (this.started) {
          out.push({ type: "finish-step" });
          out.push({ type: "finish", finishReason: "error" });
        }
        break;
      }
      default:
        break;
    }
    return out;
  }

  private closeText(out: UIMessageChunk[]): void {
    if (!this.textOpen) return;
    out.push({ type: "text-end", id: this.textId });
    this.textOpen = false;
  }

  private closeReasoning(out: UIMessageChunk[]): void {
    if (!this.reasoningOpen) return;
    out.push({ type: "reasoning-end", id: this.reasoningId });
    this.reasoningOpen = false;
  }
}


/** Pure one-shot helper for tests / simple maps. */
export function agentEventToChunks(e: AgentEvent, bridge = new UiMessageBridge()): UIMessageChunk[] {
  return bridge.push(e);
}
