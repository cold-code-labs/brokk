import { featureBranch, TASK_OWNERS, TASK_STATUSES } from "@brokk/core";
import type { TaskOwner } from "@brokk/core";
import { Hono } from "hono";
import { z } from "zod";
import type { AppDeps } from "../app.js";

// The actor recorded on a lifecycle event for a human-initiated API call. When the
// app gains a session (Logto) this becomes the user's email; until then, 'human'.
function actorOf(c: { req: { header: (n: string) => string | undefined } }): string {
  return c.req.header("x-brokk-actor") || "human";
}

// Sub-cards Resolve spawns from a `feature` analysis carry this label (the forge-
// ready sibling of the discovery/muninn labels).
const RESOLVE_LABEL = "resolve";

/** A concise card title from a (possibly long) step title. */
function toCardTitle(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= 90 ? t : `${t.slice(0, 88).replace(/\s\S*$/, "")}…`;
}

const CreateTaskBody = z.object({
  projectId: z.string().uuid(),
  title: z.string().min(1).max(200),
  body: z.string().default(""),
  priority: z.number().int().default(0),
  labels: z.array(z.string()).default([]),
  baseBranch: z.string().optional(),
  createdBy: z.string().optional(),
  /** Who drives the card. Default 'brokk' (flows to the forge); pass 'human' to
   *  add a card you'll resolve yourself (the runner won't claim it). */
  owner: z.enum(TASK_OWNERS as unknown as [string, ...string[]]).optional(),
});

const PatchTaskBody = z.object({
  title: z.string().min(1).max(200).optional(),
  body: z.string().optional(),
  status: z.enum(TASK_STATUSES as unknown as [string, ...string[]]).optional(),
  priority: z.number().int().optional(),
  labels: z.array(z.string()).optional(),
  baseBranch: z.string().nullable().optional(),
  prUrl: z.string().nullable().optional(),
});

export function tasksRoutes(deps: AppDeps): Hono {
  const r = new Hono();

  r.get("/", async (c) => {
    const projectId = c.req.query("projectId") ?? undefined;
    return c.json(await deps.store.listTasks({ projectId }));
  });

  r.post("/", async (c) => {
    const parsed = CreateTaskBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    // A card added from the board is `manual`; createdBy falls back to the actor so
    // the genesis lifecycle event is attributed to the person who added it.
    const task = await deps.store.insertTask({
      ...parsed.data,
      owner: parsed.data.owner as TaskOwner | undefined,
      status: "backlog",
      source: "manual",
      createdBy: parsed.data.createdBy ?? actorOf(c),
    });
    return c.json(task, 201);
  });

  r.get("/:id", async (c) => {
    const task = await deps.store.getTask(c.req.param("id"));
    if (!task) return c.json({ error: "not found" }, 404);
    return c.json(task);
  });

  // Runs for a task (newest first) — powers the card's run history + live log.
  r.get("/:id/runs", async (c) => {
    return c.json(await deps.store.listRunsByTask(c.req.param("id")));
  });

  // Edit fields or move column. A status change is routed through transitionTask so
  // it lands on the card's lifecycle trail; pure field edits use updateTask.
  r.patch("/:id", async (c) => {
    const parsed = PatchTaskBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const { status, ...fields } = parsed.data;
    if (status) {
      const task = await deps.store.transitionTask(c.req.param("id"), status as never, {
        actor: actorOf(c),
        reason: "board edit",
        extra: fields as never,
      });
      return c.json(task);
    }
    const task = await deps.store.updateTask(c.req.param("id"), fields as never);
    return c.json(task);
  });

  // Move a card to `queued` → enqueues a run (a runner will claim it).
  r.post("/:id/enqueue", async (c) => {
    const id = c.req.param("id");
    const task = await deps.store.getTask(id);
    if (!task) return c.json({ error: "not found" }, 404);
    const updated = await deps.store.transitionTask(id, "queued", { actor: actorOf(c) });
    return c.json(updated);
  });

  // The card's Resolve analysis (the plan the scout produced), if any. Read-only —
  // the scout writes it via the chat/Sindri runtime; the drawer polls it here too.
  r.get("/:id/analysis", async (c) => {
    return c.json(await deps.store.getTaskAnalysis(c.req.param("id")));
  });

  // Approve a ready analysis — the drawer's "aprovar" button. Two paths, driven by
  // the plan's `mode`:
  //   atomic  → the card is forge-ready: enrich it with the plan's acceptance +
  //             touches and enqueue it (one card → one PR).
  //   feature → the card is an epic: decompose the ordered steps into sub-cards
  //             under ONE feature plan (shared branch, one PR). Steps are sequential
  //             so each sub-card dependsOn the previous (the DAG). The parent is
  //             marked done — its work now lives in the sub-cards it spawned.
  r.post("/:id/analysis/approve", async (c) => {
    const id = c.req.param("id");
    const task = await deps.store.getTask(id);
    if (!task) return c.json({ error: "not found" }, 404);
    const analysis = await deps.store.getTaskAnalysis(id);
    if (!analysis || analysis.status !== "ready") {
      return c.json({ error: "no ready analysis — analyse the card first" }, 400);
    }
    const project = await deps.store.getProject(task.projectId);
    if (!project) return c.json({ error: "project not found" }, 404);
    const baseBranch = task.baseBranch ?? project.baseBranch;

    // The analyst's corrected title (when the card's own was misleading) is applied
    // to the card on approval — the fix Muninn's first framing missed.
    const titlePatch = analysis.revisedTitle ? { title: analysis.revisedTitle } : {};

    if (analysis.mode !== "feature") {
      const touches = [...new Set(analysis.steps.flatMap((s) => s.touches))].slice(0, 30);
      const updated = await deps.store.transitionTask(id, "queued", {
        actor: "resolve",
        reason: "analysis approved (atomic)",
        extra: {
          ...titlePatch,
          acceptance: analysis.steps[0]?.acceptance || analysis.approach || task.acceptance,
          touches,
        },
      });
      return c.json({ mode: "atomic", task: updated, cards: [] }, 200);
    }

    const draft = await deps.store.insertPlan({
      projectId: task.projectId,
      prompt: task.title,
      summary: `Resolução — ${task.title}`,
      rationale: analysis.rationale,
      mode: "feature",
      status: "forging",
      featureBranch: "pending",
      baseBranch,
      model: null,
      createdBy: "resolve",
    });
    const plan = await deps.store.updatePlan(draft.id, {
      featureBranch: featureBranch(draft.summary, draft.id),
    });

    const cards = [];
    let prevKey: string | null = null;
    for (let i = 0; i < analysis.steps.length; i++) {
      const step = analysis.steps[i]!;
      const key = `s${i + 1}`;
      const filesNote = step.touches.length ? `\n\nArquivos: ${step.touches.join(", ")}` : "";
      const card = await deps.store.insertTask({
        projectId: task.projectId,
        title: toCardTitle(step.title),
        body: `${step.detail}${filesNote}\n\n— passo ${i + 1}/${analysis.steps.length} de "${task.title}" (Resolve)`,
        status: "queued",
        baseBranch,
        createdBy: "resolve",
        labels: [RESOLVE_LABEL],
        planId: plan.id,
        planKey: key,
        dependsOn: prevKey ? [prevKey] : [],
        acceptance: step.acceptance || null,
        touches: step.touches,
      });
      cards.push(card);
      prevKey = key;
    }

    await deps.store.transitionTask(id, "done", {
      actor: "resolve",
      reason: `decomposed into ${cards.length} sub-cards`,
      extra: titlePatch,
    });
    return c.json({ mode: "feature", planId: plan.id, parent: id, cards }, 201);
  });

  // ── Handoff: pull a card out of the forge / hand it back ─────────────────────
  // Phase A "resolver independente do Brokk": owner='human' takes the card off the
  // runner's claim set; owner='brokk' returns it. Logged on the lifecycle trail.
  const OwnerBody = z.object({
    owner: z.enum(TASK_OWNERS as unknown as [string, ...string[]]),
    reason: z.string().optional(),
  });
  r.patch("/:id/owner", async (c) => {
    const parsed = OwnerBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const task = await deps.store.getTask(c.req.param("id"));
    if (!task) return c.json({ error: "not found" }, 404);
    const updated = await deps.store.setTaskOwner(c.req.param("id"), parsed.data.owner as never, {
      actor: actorOf(c),
      reason: parsed.data.reason,
    });
    return c.json(updated);
  });

  // Mark a card resolved by hand (outside the forge) — moves it to done, records a
  // 'resolved' note, and claims it for the human so the runner never revisits it.
  const ResolveBody = z.object({ reason: z.string().optional() });
  r.post("/:id/resolve", async (c) => {
    const parsed = ResolveBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const id = c.req.param("id");
    const task = await deps.store.getTask(id);
    if (!task) return c.json({ error: "not found" }, 404);
    const actor = actorOf(c);
    if (task.owner !== "human") {
      await deps.store.setTaskOwner(id, "human" as never, { actor, reason: "resolved by hand" });
    }
    const updated = await deps.store.transitionTask(id, "done", {
      actor,
      reason: parsed.data.reason || "resolved outside the forge",
    });
    return c.json(updated);
  });

  // The card's append-only lifecycle trail — powers the drawer timeline.
  r.get("/:id/events", async (c) => {
    return c.json(await deps.store.listTaskEvents(c.req.param("id")));
  });

  return r;
}
