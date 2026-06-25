import { AUTH_MODES, featureBranch, taskSlug } from "@brokk/core";
import { Hono } from "hono";
import { z } from "zod";
import type { AppDeps } from "../app.js";

const CreateProjectBody = z.object({
  name: z.string().min(1).max(120),
  repositoryId: z.string().uuid(),
  model: z.string().min(1).default("sonnet"),
  authMode: z.enum(AUTH_MODES as unknown as [string, ...string[]]).default("subscription"),
  allowedTools: z.array(z.string()).default([]),
  baseBranch: z.string().default("main"),
});

export function projectsRoutes(deps: AppDeps): Hono {
  const r = new Hono();

  r.get("/", async (c) => c.json(await deps.store.listProjects()));

  r.get("/:id", async (c) => {
    const project = await deps.store.getProject(c.req.param("id"));
    if (!project) return c.json({ error: "not found" }, 404);
    return c.json(project);
  });

  r.post("/", async (c) => {
    const parsed = CreateProjectBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const project = await deps.store.insertProject(parsed.data as never);
    return c.json(project, 201);
  });

  // Huginn Phase 2: turn the discovery brief's "missing" items into PROPOSED
  // cards — one backlog task per item. Backlog (not queued) IS the approval gate:
  // claimNext never runs a backlog card, so nothing executes until you queue it.
  // Idempotent: re-running skips items already carded (matched on the item text).
  r.post("/:id/backlog-from-brief", async (c) => {
    const id = c.req.param("id");
    const project = await deps.store.getProject(id);
    if (!project) return c.json({ error: "not found" }, 404);
    const brief = await deps.store.getProjectBrief(id);
    if (!brief || brief.status !== "ready") {
      return c.json({ error: "no ready brief — scout the project first" }, 400);
    }
    const missing = brief.missing.map((m) => m.trim()).filter(Boolean);
    if (!missing.length) return c.json({ created: [], skipped: 0 }, 200);

    // Dedup against cards a prior generation already made (the item is the first
    // line of the card body).
    const existing = await deps.store.listTasks({ projectId: id });
    const discoveryCards = existing.filter((t) => (t.labels ?? []).includes(DISCOVERY_LABEL));
    const seen = new Set(discoveryCards.map((t) => normItem((t.body ?? "").split("\n")[0] ?? "")));

    // The discovery brief IS one story → its cards compose into ONE PR. We group
    // them under a single feature plan (shared feature branch, one PR opened by
    // the first card to forge). Re-runs join the same plan so new items land in
    // the same PR rather than spawning fresh ones.
    let plan = null;
    const priorPlanId = discoveryCards.find((t) => t.planId)?.planId;
    if (priorPlanId) plan = await deps.store.getPlan(priorPlanId);
    if (!plan) {
      const draft = await deps.store.insertPlan({
        projectId: id,
        prompt: `Descoberta (Huginn) — ${project.name}`,
        summary: `Itens da descoberta — ${project.name}`,
        rationale: null,
        mode: "feature",
        status: "forging",
        featureBranch: "pending",
        baseBranch: project.baseBranch,
        model: null,
        createdBy: "huginn",
      });
      plan = await deps.store.updatePlan(draft.id, {
        featureBranch: featureBranch(draft.summary, draft.id),
      });
    }

    // planKeys are stable, unique-within-plan ids the DAG references. Discovery
    // items are independent (no dependsOn), so they forge in any order onto the
    // shared branch.
    const usedKeys = new Set(
      discoveryCards.filter((t) => t.planId === plan.id).map((t) => t.planKey).filter(Boolean),
    );
    const uniqueKey = (item: string) => {
      const base = taskSlug(item).slice(0, 32) || "card";
      let key = base;
      for (let n = 2; usedKeys.has(key); n++) key = `${base}-${n}`;
      usedKeys.add(key);
      return key;
    };

    const created = [];
    let skipped = 0;
    for (const item of missing) {
      if (seen.has(normItem(item))) {
        skipped++;
        continue;
      }
      const task = await deps.store.insertTask({
        projectId: id,
        title: toCardTitle(item),
        body: `${item}\n\n— proposto pela descoberta (Huginn)`,
        status: "backlog",
        baseBranch: project.baseBranch,
        createdBy: "huginn",
        labels: [DISCOVERY_LABEL],
        planId: plan.id,
        planKey: uniqueKey(item),
        dependsOn: [],
      });
      created.push(task);
    }
    return c.json({ created, skipped, planId: plan.id }, 201);
  });

  // Huginn Phase 3: "Aprovar todos" — enqueue every PROPOSED backlog card at once
  // (those Huginn discovery or the Sindri planner staged). backlog→queued is the
  // gate, so this flips the whole proposed set into the forge in one click.
  r.post("/:id/approve-proposed", async (c) => {
    const id = c.req.param("id");
    const project = await deps.store.getProject(id);
    if (!project) return c.json({ error: "not found" }, 404);
    const backlog = await deps.store.listTasks({ projectId: id, status: "backlog" });
    const proposed = backlog.filter((t) =>
      (t.labels ?? []).some((l) => l === DISCOVERY_LABEL || l === PLAN_LABEL),
    );
    for (const t of proposed) await deps.store.updateTask(t.id, { status: "queued" });
    return c.json({ enqueued: proposed.length }, 200);
  });

  return r;
}

const DISCOVERY_LABEL = "discovery";
const PLAN_LABEL = "plan";
const normItem = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 200);
/** A concise card title from a (possibly long) missing-item sentence. */
function toCardTitle(item: string): string {
  const t = item.replace(/\s+/g, " ").trim();
  if (t.length <= 90) return t;
  return `${t.slice(0, 88).replace(/\s\S*$/, "")}…`;
}
