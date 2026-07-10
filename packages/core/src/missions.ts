// ── Regin: the mission coordinator (MultiDevin-lite, ADR 0027 §5.4) ──────────
// A mission is ONE goal handed to the coordinator persona: Regin plans it via
// Mímir, dispatches the cards to the forge, watches the board, reacts to
// failures (retry ≤2, replan ≤1, then escalate to a human) and synthesizes the
// outcome when everything lands. Pure domain here — the reconciler that drives
// it lives in apps/api (a process concern), per the dependency law (§10).

import type { Task } from "./index.js";

/** Lifecycle of a mission. `planning` = Mímir is decomposing (or the proposed
 *  cards await board approval); `running` = cards dispatched, Regin watching;
 *  `blocked` = escalated to a human (resume re-runs the tick); `done`/`failed`
 *  are terminal outcomes; `cancelled` = a human called it off. */
export type MissionStatus =
  | "planning"
  | "running"
  | "blocked"
  | "done"
  | "failed"
  | "cancelled";

export const MISSION_STATUSES: readonly MissionStatus[] = [
  "planning",
  "running",
  "blocked",
  "done",
  "failed",
  "cancelled",
] as const;

/** Regin's durable reaction counters, persisted on the mission row so a tick is
 *  crash-safe and idempotent (recomputed from db state, never from memory).
 *  Keyed by taskId. `taskIds` pins the cards the mission dispatched — covers the
 *  atomic path (no planId to load cards by). */
export interface MissionState {
  /** Retries issued per card (failed → queued). Capped at 2. */
  attempts: Record<string, number>;
  /** Replans issued per card (one-shot card revision). Capped at 1. */
  replans: Record<string, number>;
  /** The cards this mission created, stamped at planning time. */
  taskIds?: string[];
}

/** One goal under Regin's watch. */
export interface Mission {
  id: string;
  projectId: string;
  /** The human goal, verbatim — what Mímir plans and Regin shepherds. */
  goal: string;
  /** The feature plan the goal decomposed into (null for the atomic path). */
  planId: string | null;
  status: MissionStatus;
  /** Human-readable line: why blocked, the synthesis when done, etc. */
  detail: string | null;
  /** true = Regin enqueues the proposed cards himself; false = the board
   *  approves (mission rests in `planning` until a card leaves backlog). */
  autoApprove: boolean;
  /** The Sindri session that started the mission, when it came from chat. */
  chatSessionId: string | null;
  createdBy: string | null;
  state: MissionState;
  createdAt: string;
  updatedAt: string;
}

/** What a {@link MissionEvent} records on the mission's append-only trail. */
export type MissionEventType =
  | "created"
  | "status"
  | "note"
  | "retry"
  | "replan"
  | "escalation"
  | "synthesis";

/** One append-only entry in a mission's life — the task_events sibling. */
export interface MissionEvent {
  id: string;
  missionId: string;
  type: MissionEventType;
  detail: unknown;
  at: string;
}

/** Card-status counts for a mission's cards. `backlog` folds in `analysis`
 *  (both are pre-approval board states — the card hasn't been dispatched). */
export interface MissionProgress {
  total: number;
  done: number;
  failed: number;
  running: number;
  queued: number;
  review: number;
  backlog: number;
  cancelled: number;
}

/** Tally a mission's cards by status. Pure — feeds the reconciler's decisions. */
export function missionProgress(cards: Pick<Task, "status">[]): MissionProgress {
  const p: MissionProgress = {
    total: cards.length,
    done: 0,
    failed: 0,
    running: 0,
    queued: 0,
    review: 0,
    backlog: 0,
    cancelled: 0,
  };
  for (const c of cards) {
    switch (c.status) {
      case "done": p.done++; break;
      case "failed": p.failed++; break;
      case "running": p.running++; break;
      case "queued": p.queued++; break;
      case "review": p.review++; break;
      case "cancelled": p.cancelled++; break;
      // backlog + analysis are both "not yet dispatched" board states.
      default: p.backlog++; break;
    }
  }
  return p;
}

/** True when no card can still move on its own: nothing queued/running/backlog
 *  AND nothing in review — a card in `review` has an OPEN PR awaiting Eitri /
 *  merge, so the mission must keep watching, not settle. */
export function missionCardsSettled(progress: MissionProgress): boolean {
  return (
    progress.queued === 0 &&
    progress.running === 0 &&
    progress.review === 0 &&
    progress.backlog === 0
  );
}
