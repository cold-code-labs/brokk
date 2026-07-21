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
  featureBranch,
  missionCardsSettled,
  missionProgress,
  type Mission,
  type Task,
} from "@brokk/core";
import type { Store } from "@brokk/db";
import { extractJson, mimirComplete, planJob, type MimirConfig } from "@brokk/mimir";

export interface MissionDeps {
  store: Store;
  /** Mímir models (planner + cheap). Undefined = missions block on planning. */
  mimir?: MimirConfig;
}

const MAX_RETRIES = 2;
const MAX_REPLANS = 1;
/** Auto Brokk: identical failure fingerprint this many times → skip blind retry, go replan/escalate. */
const MAX_SAME_ERROR = 2;
/** Driver-run zombie TTL (BROKK-22): forge restart leaves `running` forever. */
const DRIVER_STALE_MS = 45 * 60 * 1000;
/** Auto intake: only shepherd failed cards newer than this. */
const AUTO_INTAKE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

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

  if (!deps.mimir) {
    await store.patchMission(mission.id, {
      status: "blocked",
      detail: "planner indisponível (Mímir não configurado)",
    });
    await store.addMissionEvent(mission.id, "escalation", { reason: "planner unavailable" });
    return;
  }

  const project = await store.getProject(mission.projectId);
  if (!project) {
    await store.patchMission(mission.id, { status: "blocked", detail: "projeto não encontrado" });
    await store.addMissionEvent(mission.id, "escalation", { reason: "project not found" });
    return;
  }

  // Crash backstop: a previous tick may have created the cards but died before
  // stamping the mission. Adopt them instead of planning (and paying) again.
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
    return; // next tick continues from the planned state
  }

  // ONE-SHOT plan — the same inputs Sindri's runPlan/mimir gives the planner:
  // the goal + the repo's warm map and memory as context.
  const repoContext = await buildRepoContext(store, project.repositoryId, mission.goal);
  let draft;
  try {
    draft = await planJob(mission.goal, deps.mimir, repoContext);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await store.patchMission(mission.id, { status: "blocked", detail: `planner falhou: ${reason}` });
    await store.addMissionEvent(mission.id, "escalation", { reason: `planner failed: ${reason}` });
    return;
  }

  const base = draft.targetBranch || project.baseBranch;
  const taskIds: string[] = [];
  let planId: string | null = null;

  // FEATURE (2+ cards) → a real Plan/DAG, exactly like runPlan: one shared
  // feature branch, cards linked by planId/planKey/dependsOn, ONE PR.
  if (draft.mode === "feature" && draft.cards.length > 1) {
    const created = await store.insertPlan({
      projectId: mission.projectId,
      prompt: mission.goal,
      summary: draft.summary,
      rationale: draft.rationale || null,
      mode: "feature",
      status: "planning",
      featureBranch: "pending",
      baseBranch: base,
      model: draft.model ?? null,
      createdBy: "regin",
    });
    const plan = await store.updatePlan(created.id, {
      featureBranch: featureBranch(draft.summary, created.id),
    });
    planId = plan.id;
    for (const card of draft.cards) {
      const t = await store.insertTask({
        projectId: mission.projectId,
        title: card.title || mission.goal.slice(0, 60),
        body: `${card.body}\n\n— planejado pelo Regin (${missionMark(mission.id)})`,
        status: "backlog",
        kind: "implement",
        planId: plan.id,
        planKey: card.key,
        dependsOn: card.dependsOn,
        baseBranch: base,
        createdBy: "regin",
        labels: ["plan"],
        acceptance: card.acceptance || null,
        forca: card.forca,
        touches: card.touches,
      });
      taskIds.push(t.id);
    }
  } else {
    // ATOMIC → one (or few) standalone backlog card(s) — runPlan's atomic path.
    for (const card of draft.cards) {
      const t = await store.insertTask({
        projectId: mission.projectId,
        title: card.title || mission.goal.slice(0, 60),
        body: `${card.body}\n\n— planejado pelo Regin (${missionMark(mission.id)})`,
        status: "backlog",
        baseBranch: base,
        createdBy: "regin",
        labels: ["plan"],
        acceptance: card.acceptance || null,
        forca: card.forca,
        touches: card.touches,
      });
      taskIds.push(t.id);
    }
  }

  await store.patchMission(mission.id, {
    planId,
    state: { ...mission.state, taskIds },
    detail: mission.autoApprove ? null : "aguardando aprovação no Quadro",
  });
  await store.addMissionEvent(mission.id, "note", {
    kind: "planned",
    mode: draft.mode,
    summary: draft.summary,
    cards: taskIds.length,
    planId,
    questions: draft.questions.map((q) => q.question),
  });

  if (mission.autoApprove) {
    // Enqueue the proposed cards the same way approve-proposed does: through
    // transitionTask, so the move lands on each card's lifecycle trail.
    for (const id of taskIds) {
      await store.transitionTask(id, "queued", { actor: "regin", reason: "mission auto-approve" });
    }
    await store.patchMission(mission.id, { status: "running" });
    await store.addMissionEvent(mission.id, "status", {
      from: "planning",
      to: "running",
      reason: `${taskIds.length} card(s) enfileirado(s)`,
    });
  }
  // !autoApprove: the mission rests in planning; the board approves (backlog →
  // queued) and the next tick's "dispatched" check above flips it to running.
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
 *  Cap: one mission per tick. Skip cards already pinned to a live mission. */
async function tickAutoIntake(deps: MissionDeps): Promise<void> {
  if (process.env.BROKK_AUTO !== "1") return;
  const { store } = deps;
  const failed = await store.listTasks({ status: "failed" });
  if (failed.length === 0) return;

  const live = [
    ...(await store.listMissions({ status: "planning" })),
    ...(await store.listMissions({ status: "running" })),
    ...(await store.listMissions({ status: "blocked" })),
  ];
  const pinned = new Set<string>();
  for (const m of live) {
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

// ── one-shot decisions (NORTH-STAR §9.5: structured, never wandering) ─────────

interface ReplanDecision {
  action: "revise" | "escalate";
  revisedBody?: string;
  revisedAcceptance?: string;
  reason?: string;
}

const REGIN_REPLAN_SYSTEM = `Você é REGIN, o capataz de missões da Cold Code Labs. Um card de forja (executado por um agente autônomo de codificação) falhou repetidamente mesmo após retries. Decida, em UMA tacada, o próximo passo:
- "revise": reescreva o card para contornar a causa da falha — um body mais específico (citando arquivos, comandos e o erro observado) e/ou uma acceptance mais realista. O card revisado volta para a fila. NÃO invente requisitos novos; preserve o objetivo original.
- "escalate": a falha exige um humano (credencial/acesso ausente, decisão de produto em aberto, erro de infra fora do repo). Explique o porquê em "reason".

Responda SOMENTE com um objeto JSON válido, sem markdown, neste formato exato:
{"action":"revise|escalate","revisedBody":"<body completo revisado — apenas quando action=revise>","revisedAcceptance":"<acceptance revisada — opcional, apenas quando action=revise>","reason":"<1-2 frases justificando a decisão>"}`;

/** ONE mimirComplete: card + last run's error tail + attempts → revise|escalate.
 *  Null on any failure (the caller escalates). */
async function decideReplan(deps: MissionDeps, card: Task): Promise<ReplanDecision | null> {
  if (!deps.mimir) return null;
  try {
    const runs = await deps.store.listRunsByTask(card.id);
    const lastError = (runs[0]?.error ?? "").slice(-2000);
    const user = [
      `CARD:`,
      `título: ${card.title}`,
      `body:\n${card.body}`,
      `acceptance: ${card.acceptance ?? "(nenhuma)"}`,
      ``,
      `TENTATIVAS: o card já falhou após retries (forjas anteriores esgotadas).`,
      ``,
      `ERRO DA ÚLTIMA EXECUÇÃO (tail):`,
      lastError || "(sem erro registrado)",
    ].join("\n");
    const { text } = await mimirComplete(deps.mimir, {
      system: REGIN_REPLAN_SYSTEM,
      user,
      model: deps.mimir.plannerModel, // the decision compounds — strong model (§9.3)
      json: true,
      maxTokens: 3000,
    });
    const raw = extractJson<ReplanDecision>(text);
    if (!raw || (raw.action !== "revise" && raw.action !== "escalate")) return null;
    return raw;
  } catch (err) {
    console.warn(`[regin] replan decision failed for card ${card.id.slice(0, 8)}:`, err);
    return null;
  }
}

/** ONE mimirComplete: 2–3 sentence outcome summary. Cheap model — cosmetic.
 *  Falls back to a deterministic line so `done` never depends on the gateway. */
async function synthesize(
  deps: MissionDeps,
  mission: Mission,
  cards: Task[],
  prUrl: string | null,
): Promise<string> {
  const fallback = `Missão concluída: ${cards.length} card(s) finalizados.${prUrl ? ` PR: ${prUrl}` : ""}`;
  if (!deps.mimir) return fallback;
  try {
    const lines = cards.map((c) => `- [${c.status}] ${c.title}`).join("\n");
    const { text } = await mimirComplete(deps.mimir, {
      system:
        "Você é Regin, o capataz de missões da Cold Code Labs. Resuma o DESFECHO da missão em 2-3 frases, no idioma do objetivo, para um humano ler no painel. Sem markdown, sem listas.",
      user: `OBJETIVO: ${mission.goal}\n\nCARDS:\n${lines}${prUrl ? `\n\nPR: ${prUrl}` : ""}`,
      model: deps.mimir.enhanceModel,
      maxTokens: 300,
    });
    return text.trim() || fallback;
  } catch {
    return fallback;
  }
}

/** Warm planner context: the repo's map (#4) + learned memory (#2), the same
 *  blocks the retired /mimir/plan route fed planJob. */
async function buildRepoContext(
  store: Store,
  repositoryId: string,
  queryText: string,
): Promise<string | undefined> {
  const repo = await store.getRepository(repositoryId).catch(() => null);
  if (!repo) return undefined;
  const memories = await store.searchRepoMemories(repo.id, queryText).catch(() => []);
  const blocks: string[] = [];
  if (repo.repoMap) blocks.push(`## Mapa do repositório\n${repo.repoMap}`);
  if (memories.length) {
    const lines = memories.map((m) => `- (${m.kind}, peso ${m.weight}) ${m.content}`);
    blocks.push(`## Memória do repositório (lições aprendidas — RESPEITE)\n${lines.join("\n")}`);
  }
  return blocks.length ? blocks.join("\n\n") : undefined;
}
