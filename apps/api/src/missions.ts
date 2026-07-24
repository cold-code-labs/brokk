// ─────────────────────────────────────────────────────────────────────────────
// REGIN — the mission coordinator (MultiDevin-lite, ADR 0027 §5.4).
//
// One reconciler tick (singleton, every 30s) drives every live mission through:
//   planning → plan the goal via Mímir (the SAME recipe Sindri's runPlan uses:
//               plan row + cards linked by planId/planKey/dependsOn, label
//               "plan", status backlog) → auto-approve enqueues → running.
//   running  → watch the cards; react to failures (retry ≤2 → replan ≤1 →
//               escalate/blocked), and when everything lands, synthesize the
//               outcome (one-shot) → done.
//
// Lean doctrine (NORTH-STAR §9): every LLM use here is a ONE-SHOT structured
// decision — planJob, the replan decision, the synthesis — never a loop, and at
// most ONE completion per mission per tick. Crash-safety: all state lives in
// missions/mission_events (+ the reaction counters in mission.state); a tick
// recomputes from db rows, the only in-memory state is the in-flight flag.
// ─────────────────────────────────────────────────────────────────────────────

import {
  missionCardsSettled,
  missionProgress,
  type Mission,
  type Task,
} from "@brokk/core";
import type { Store } from "@brokk/db";

export interface MissionDeps {
  store: Store;
}

const MAX_RETRIES = 2;
const MAX_REPLANS = 1;
/** Auto Brokk: identical failure fingerprint this many times → skip blind retry, go replan/escalate. */
const MAX_SAME_ERROR = 2;
/** Driver-run zombie TTL (BROKK-22): forge restart leaves `running` forever. */
const DRIVER_STALE_MS = 45 * 60 * 1000;
/** Forge-run zombie TTL (BROKK-22 forge lane): a run whose runner stopped
 *  heartbeating this long is dead — fail it and requeue the card. Comfortably
 *  above the lease TTL + heartbeat cadence so a live-but-slow runner never
 *  gets reaped. Override: BROKK_RUN_STALE_MS. */
const RUN_STALE_MS = Math.max(
  60_000,
  Number(process.env.BROKK_RUN_STALE_MS) || 15 * 60 * 1000,
);
/** How many times a reaped card goes back to `queued` before staying failed.
 *  Override: BROKK_RUN_REAP_REQUEUES. */
const RUN_REAP_REQUEUES = Math.max(
  0,
  Number.isFinite(Number(process.env.BROKK_RUN_REAP_REQUEUES))
    ? Number(process.env.BROKK_RUN_REAP_REQUEUES)
    : 1,
);
/** Auto intake: only shepherd failed cards newer than this. */
const AUTO_INTAKE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Default pause after Mímir 429/529 before auto-intake resumes (30 min). */
const DEFAULT_AUTO_PAUSE_MS = 30 * 60 * 1000;

/**
 * In-memory circuit breaker for BROKK_AUTO. Survives across ticks in-process;
 * a redeploy clears it (acceptable — Coolify restart is rare vs. seat cooldown).
 * Surtr 2026-07-20: overnight auto + seat 429 → Regin kept intaking failed cards
 * every 30s and burning the gateway; Hostinger throttled the box.
 */
let autoPausedUntil = 0;

/** Test/ops helper: clear the auto-intake pause. */
export function resetAutoPause(): void {
  autoPausedUntil = 0;
}

/** Whether auto-intake is currently paused (rate-limit cooldown). */
export function isAutoPaused(now = Date.now()): boolean {
  return now < autoPausedUntil;
}

/** Cap how many auto-brokk missions may be planning/running at once. */
export function autoLiveCapReached(
  liveAutoCount: number,
  maxLive = Number(process.env.BROKK_AUTO_MAX_LIVE ?? 1),
): boolean {
  const cap = Number.isFinite(maxLive) && maxLive > 0 ? Math.floor(maxLive) : 1;
  return liveAutoCount >= cap;
}

/** Trip the auto-intake breaker on gateway rate-limit / overload. */
export function noteMimirThrottle(err: unknown): void {
  const status =
    err && typeof err === "object" && "status" in err ? Number((err as { status: unknown }).status) : 0;
  if (status !== 429 && status !== 529) return;
  const raw = Number(process.env.BROKK_AUTO_PAUSE_MS ?? DEFAULT_AUTO_PAUSE_MS);
  const pauseMs = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_AUTO_PAUSE_MS;
  autoPausedUntil = Math.max(autoPausedUntil, Date.now() + pauseMs);
  console.warn(
    `[regin] auto-intake paused until ${new Date(autoPausedUntil).toISOString()} (mimir ${status})`,
  );
}

/** Normalize a run error into a stable fingerprint for same-error detection. */
export function errorFingerprint(err: string): string {
  return err
    .replace(/\s+/g, " ")
    .replace(/\b[0-9a-f]{7,}\b/gi, "#")
    .replace(/\d+/g, "#")
    .trim()
    .slice(-400);
}

/** Start the singleton reconciler. Overlapping ticks are guarded by an in-flight
 *  flag (a slow tick skips the next beat instead of stacking). Returns a stop fn. */
export function startMissionReconciler(deps: MissionDeps, intervalMs = 30_000): () => void {
  let inFlight = false;
  const tick = async (): Promise<void> => {
    if (inFlight) return;
    inFlight = true;
    try {
      // BROKK-22: reap driver_runs stuck after forge recreate (no heartbeat).
      const reaped = await deps.store.reapStaleDriverRuns(DRIVER_STALE_MS).catch(() => 0);
      if (reaped > 0) console.warn(`[regin] reaped ${reaped} stale driver-run(s)`);

      // BROKK-22 (forge lane): reap forge runs orphaned `running` by a dead
      // runner — fail the run, free the app lease, requeue the card (capped).
      const reapedRuns = await deps.store
        .reapStaleRuns(RUN_STALE_MS, { maxRequeues: RUN_REAP_REQUEUES })
        .catch(() => 0);
      if (reapedRuns > 0) console.warn(`[regin] reaped ${reapedRuns} stale forge run(s)`);

      // BROKK-44: overnight intake — wrap orphaned failed cards into auto missions.
      await tickAutoIntake(deps).catch((err) =>
        console.error("[regin] auto-intake failed:", err),
      );

      const missions = [
        ...(await deps.store.listMissions({ status: "planning" })),
        ...(await deps.store.listMissions({ status: "running" })),
      ];
      for (const mission of missions) {
        try {
          if (mission.status === "planning") await tickPlanning(deps, mission);
          else await tickRunning(deps, mission);
        } catch (err) {
          console.error(`[regin] mission ${mission.id.slice(0, 8)} tick failed:`, err);
        }
      }
    } catch (err) {
      console.error("[regin] tick failed:", err);
    } finally {
      inFlight = false;
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  void tick();
  console.log(`[regin] mission reconciler started (every ${Math.round(intervalMs / 1000)}s)`);
  return () => clearInterval(timer);
}

/** The mission's cards: by plan when it decomposed into a feature, else by the
 *  taskIds pinned in state (the atomic path). Exported for the /missions routes. */
export async function loadMissionCards(store: Store, mission: Mission): Promise<Task[]> {
  if (mission.planId) return store.getPlanTasks(mission.planId);
  const ids = mission.state.taskIds ?? [];
  const cards: Task[] = [];
  for (const id of ids) {
    const t = await store.getTask(id);
    if (t) cards.push(t);
  }
  return cards;
}

/** The body marker that ties a card back to its mission — also the idempotency
 *  key the planner uses to ADOPT cards from a tick that crashed mid-plan. */
const missionMark = (missionId: string): string => `missão ${missionId.slice(0, 8)}`;

// ── planning ──────────────────────────────────────────────────────────────────

async function tickPlanning(deps: MissionDeps, mission: Mission): Promise<void> {
  const { store } = deps;

  // Already planned → we're only waiting for board approval (!autoApprove).
  // Flip to running as soon as any card leaves the pre-dispatch states.
  if (mission.planId || (mission.state.taskIds?.length ?? 0) > 0) {
    const cards = await loadMissionCards(store, mission);
    const dispatched = cards.some((c) => c.status !== "backlog" && c.status !== "analysis");
    if (dispatched) {
      await store.patchMission(mission.id, { status: "running", detail: null });
      await store.addMissionEvent(mission.id, "status", {
        from: "planning",
        to: "running",
        reason: "cards aprovados no Quadro",
      });
    }
    return;
  }

  // Crash backstop: adopt orphan cards from a prior tick that crashed mid-plan.
  const orphans = (await store.listTasks({ projectId: mission.projectId })).filter(
    (t) => t.createdBy === "regin" && t.body.includes(missionMark(mission.id)),
  );
  if (orphans.length > 0) {
    const planId = orphans.find((t) => t.planId)?.planId ?? null;
    await store.patchMission(mission.id, {
      planId,
      state: { ...mission.state, taskIds: orphans.map((t) => t.id) },
    });
    await store.addMissionEvent(mission.id, "note", {
      kind: "adopted-orphan-cards",
      cards: orphans.length,
    });
    return;
  }

  // Mímir cortex terminated (2026-07-24): no planJob. Use Brokk Chat Plan → Forge.
  await store.patchMission(mission.id, {
    status: "blocked",
    detail:
      "Mímir dissolvido — planeje no Chat (OpenCode Plan) e envie ao Forge; Regin não decompõe mais goals",
  });
  await store.addMissionEvent(mission.id, "escalation", {
    reason: "mimir terminated — use Chat Plan → Forge",
  });
}

// ── running ───────────────────────────────────────────────────────────────────

async function tickRunning(deps: MissionDeps, mission: Mission): Promise<void> {
  const { store } = deps;
  const cards = await loadMissionCards(store, mission);
  if (cards.length === 0) return; // nothing to watch (shouldn't happen)
  const progress = missionProgress(cards);

  // React to failed cards. Counters live in mission.state (persisted BEFORE the
  // reaction so a crash can't double-react); a re-queued card leaves `failed`,
  // so each failure gets exactly one reaction.
  let state = mission.state;
  let reacted = false;
  for (const card of cards) {
    if (card.status !== "failed") continue;
    const attempts = state.attempts[card.id] ?? 0;
    const replans = state.replans[card.id] ?? 0;

    // Auto Brokk: fingerprint the last run error. Same fingerprint ×N → skip
    // blind retries (they won't help) and jump to replan/escalate.
    const runs = await store.listRunsByTask(card.id);
    const fp = errorFingerprint(runs[0]?.error ?? "");
    const prevFp = state.lastErrorFp?.[card.id] ?? "";
    const streak = fp && fp === prevFp ? (state.sameErrorStreak?.[card.id] ?? 0) + 1 : 1;
    state = {
      ...state,
      lastErrorFp: { ...state.lastErrorFp, [card.id]: fp },
      sameErrorStreak: { ...state.sameErrorStreak, [card.id]: streak },
    };

    const sameErrorExhausted = Boolean(fp) && streak >= MAX_SAME_ERROR;
    if (attempts < MAX_RETRIES && !sameErrorExhausted) {
      state = { ...state, attempts: { ...state.attempts, [card.id]: attempts + 1 } };
      await store.patchMission(mission.id, { state });
      await store.transitionTask(card.id, "queued", {
        actor: "regin",
        reason: `mission retry ${attempts + 1}`,
      });
      await store.addMissionEvent(mission.id, "retry", { taskId: card.id, attempt: attempts + 1 });
      reacted = true;
      continue;
    }

    if (replans < MAX_REPLANS) {
      // LLM budget: at most ONE completion per mission per tick — the replan is
      // it, so we return right after (whatever the outcome).
      state = { ...state, replans: { ...state.replans, [card.id]: replans + 1 } };
      await store.patchMission(mission.id, { state });
      const decision = await decideReplan(deps, card);
      if (decision?.action === "revise") {
        await store.updateTask(card.id, {
          body: decision.revisedBody || card.body,
          acceptance: decision.revisedAcceptance || card.acceptance,
        });
        await store.transitionTask(card.id, "queued", {
          actor: "regin",
          reason: sameErrorExhausted
            ? "mission replan (mesmo erro ×N — card revisado)"
            : "mission replan (card revisado)",
        });
        await store.addMissionEvent(mission.id, "replan", {
          taskId: card.id,
          reason: decision.reason ?? null,
          sameError: sameErrorExhausted,
        });
        return;
      }
      await escalate(store, mission, card, decision?.reason ?? "replanejamento indisponível ou falhou");
      return;
    }
    // attempts and replans exhausted — terminal for this card; handled below
    // when the whole board settles.
    await store.patchMission(mission.id, { state });
  }
  if (reacted) return; // statuses changed under us — recompute next tick

  if (!missionCardsSettled(progress)) return; // cards still moving — keep watching

  if (progress.failed > 0) {
    // Settled with failures and every reaction exhausted → the mission failed.
    await store.patchMission(mission.id, {
      status: "failed",
      detail: `${progress.failed} card(s) falharam após ${MAX_RETRIES} retries + ${MAX_REPLANS} replan`,
    });
    await store.addMissionEvent(mission.id, "status", {
      from: "running",
      to: "failed",
      reason: "reactions exhausted",
    });
    return;
  }

  // Success path: everything done. A plan also needs its shared PR MERGED
  // (plan.status='done' via markPlanDone) — cards can't be 'done' before that,
  // but check explicitly so a hand-moved board can't fake a finish.
  let prUrl: string | null = null;
  if (mission.planId) {
    const plan = await store.getPlan(mission.planId);
    if (!plan || plan.status !== "done") return; // PR ainda aberto — aguarda o merge
    prUrl = plan.prUrl;
  } else {
    prUrl = cards.find((c) => c.prUrl)?.prUrl ?? null;
  }

  const summary = await synthesize(deps, mission, cards, prUrl);
  await store.patchMission(mission.id, { status: "done", detail: summary });
  await store.addMissionEvent(mission.id, "synthesis", { summary, prUrl });
  await store.addMissionEvent(mission.id, "status", { from: "running", to: "done" });
}

/** BROKK-44 Auto Brokk intake: when BROKK_AUTO=1, wrap one orphaned recent-failed
 *  card into an autoApprove mission so Regin shepherds overnight retries.
 *  Caps: one mission per tick; at most BROKK_AUTO_MAX_LIVE auto missions in
 *  planning/running (default 1); skip while the Mímir 429 circuit breaker is open. */
async function tickAutoIntake(deps: MissionDeps): Promise<void> {
  if (process.env.BROKK_AUTO !== "1") return;
  if (isAutoPaused()) return;
  const { store } = deps;

  const active = [
    ...(await store.listMissions({ status: "planning" })),
    ...(await store.listMissions({ status: "running" })),
  ];
  const liveAuto = active.filter((m) => m.createdBy === "auto-brokk");
  if (autoLiveCapReached(liveAuto.length)) return;

  const failed = await store.listTasks({ status: "failed" });
  if (failed.length === 0) return;

  // Blocked missions still pin their cards so we don't re-intake the same failure.
  const pinned = new Set<string>();
  for (const m of [
    ...active,
    ...(await store.listMissions({ status: "blocked" })),
  ]) {
    for (const id of m.state.taskIds ?? []) pinned.add(id);
  }

  const cutoff = Date.now() - AUTO_INTAKE_MAX_AGE_MS;
  const orphan = failed.find((t) => {
    if (pinned.has(t.id)) return false;
    if (Date.parse(t.updatedAt) < cutoff) return false;
    return true;
  });
  if (!orphan) return;

  const mission = await store.insertMission({
    projectId: orphan.projectId,
    goal: `Auto Brokk: retomar card falho — ${orphan.title}`,
    autoApprove: true,
    createdBy: "auto-brokk",
  });
  await store.patchMission(mission.id, {
    status: "running",
    state: { attempts: {}, replans: {}, taskIds: [orphan.id] },
    detail: "intake overnight",
  });
  await store.addMissionEvent(mission.id, "created", {
    source: "auto-intake",
    taskId: orphan.id,
  });
  console.log(`[regin] auto-intake mission ${mission.id.slice(0, 8)} ← task ${orphan.id.slice(0, 8)}`);
}

async function escalate(store: Store, mission: Mission, card: Task, reason: string): Promise<void> {
  await store.patchMission(mission.id, {
    status: "blocked",
    detail: `card "${card.title}" precisa de um humano: ${reason}`,
  });
  await store.addMissionEvent(mission.id, "escalation", { taskId: card.id, reason });
}

// ── one-shot decisions (Mímir gone — deterministic / escalate) ────────────────

interface ReplanDecision {
  action: "revise" | "escalate";
  revisedBody?: string;
  revisedAcceptance?: string;
  reason?: string;
}

/** Replan without Mímir: escalate to human. */
async function decideReplan(_deps: MissionDeps, _card: Task): Promise<ReplanDecision | null> {
  return {
    action: "escalate",
    reason: "Mímir dissolvido — revise o card no Chat/Forge ou aprove manualmente",
  };
}

/** Deterministic outcome summary (no LLM). */
async function synthesize(
  _deps: MissionDeps,
  _mission: Mission,
  cards: Task[],
  prUrl: string | null,
): Promise<string> {
  return `Missão concluída: ${cards.length} card(s) finalizados.${prUrl ? ` PR: ${prUrl}` : ""}`;
}
