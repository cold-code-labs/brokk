// ─────────────────────────────────────────────────────────────────────────────
// The turn manager. A turn runs DETACHED from the HTTP request that started it:
// the browser can close (or you can go to sleep) and the agent keeps forging —
// the overnight property. Live events fan out to any number of SSE subscribers
// through a per-session emitter, with a ring buffer so a (re)connecting client
// replays what it missed mid-round. Persisted messages (chat_messages) are the
// durable record; this layer is just the live tail.
// ─────────────────────────────────────────────────────────────────────────────

import { EventEmitter } from "node:events";
import type { AgentEvent } from "@brokk/chat";

interface ActiveTurn {
  emitter: EventEmitter;
  /** Recent events for replay to late subscribers (capped). */
  buffer: AgentEvent[];
  abort: AbortController;
  startedAt: number;
}

export class TurnManager {
  private active = new Map<string, ActiveTurn>();
  /** Sessions that just finished — keep the tail briefly for a racing reconnect. */
  private recent = new Map<string, { buffer: AgentEvent[]; at: number }>();

  isRunning(sessionId: string): boolean {
    return this.active.has(sessionId);
  }

  /**
   * Start a detached turn. `run` receives an `emit` sink and an AbortSignal; it
   * runs to completion independently of any subscriber. Returns immediately.
   */
  start(sessionId: string, run: (emit: (e: AgentEvent) => void, signal: AbortSignal) => Promise<void>): void {
    if (this.active.has(sessionId)) throw new Error("a turn is already running for this session");
    const emitter = new EventEmitter();
    emitter.setMaxListeners(0);
    const buffer: AgentEvent[] = [];
    const abort = new AbortController();
    const turn: ActiveTurn = { emitter, buffer, abort, startedAt: Date.now() };
    this.active.set(sessionId, turn);

    const emit = (e: AgentEvent) => {
      buffer.push(e);
      if (buffer.length > 2000) buffer.splice(0, buffer.length - 2000);
      emitter.emit("event", e);
    };

    void run(emit, abort.signal)
      .catch((err) => emit({ type: "error", message: (err as Error)?.message ?? String(err) }))
      .finally(() => {
        // Ensure a terminal event so subscribers unblock even on an odd exit.
        if (!buffer.some((e) => e.type === "done" || e.type === "error")) emit({ type: "done" });
        this.recent.set(sessionId, { buffer: turn.buffer, at: Date.now() });
        this.active.delete(sessionId);
        // Drop the tail after a grace window.
        setTimeout(() => {
          const r = this.recent.get(sessionId);
          if (r && Date.now() - r.at >= 30_000) this.recent.delete(sessionId);
        }, 31_000).unref?.();
      });
  }

  /**
   * Subscribe to a session's live events. Immediately replays the buffer (so a
   * mid-round reconnect catches up), then streams new events until `onEvent`
   * returns false or the turn ends. Returns an unsubscribe fn. If no turn is
   * active, replays the recent tail (if any) and signals completion.
   */
  subscribe(sessionId: string, onEvent: (e: AgentEvent) => void): () => void {
    const turn = this.active.get(sessionId);
    if (!turn) {
      const r = this.recent.get(sessionId);
      if (r) for (const e of r.buffer) onEvent(e);
      else onEvent({ type: "done" });
      return () => {};
    }
    for (const e of turn.buffer) onEvent(e);
    const handler = (e: AgentEvent) => onEvent(e);
    turn.emitter.on("event", handler);
    return () => turn.emitter.off("event", handler);
  }

  /** Request a running turn to stop at the next safe point. */
  stop(sessionId: string): boolean {
    const turn = this.active.get(sessionId);
    if (!turn) return false;
    turn.abort.abort();
    return true;
  }
}
