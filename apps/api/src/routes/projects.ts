import { AUTH_MODES, featureBranch, taskSlug } from "@brokk/core";
import { Hono } from "hono";
import { z } from "zod";
import { actorFrom, canSeeProject, listScope, resolveLogtoOrgId } from "../actor.js";
import type { AppDeps } from "../app.js";

const CreateProjectBody = z.object({
  name: z.string().min(1).max(120),
  repositoryId: z.string().uuid(),
  model: z.string().min(1).default("sonnet"),
  authMode: z.enum(AUTH_MODES as unknown as [string, ...string[]]).default("subscription"),
  allowedTools: z.array(z.string()).default([]),
  baseBranch: z.string().default("main"),
  logtoOrgId: z.string().min(1).nullable().optional(),
});

export function projectsRoutes(deps: AppDeps): Hono {
  const r = new Hono();

  r.get("/", async (c) => {
    const actor = actorFrom(c);
    return c.json(await deps.store.listProjects(listScope(actor)));
  });

  r.get("/:id", async (c) => {
    const actor = actorFrom(c);
    const project = await deps.store.getProject(c.req.param("id"));
    if (!project || !canSeeProject(actor, project.logtoOrgId)) {
      return c.json({ error: "not found" }, 404);
    }
    return c.json(project);
  });

  r.post("/", async (c) => {
    const actor = actorFrom(c);
    const parsed = CreateProjectBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    // Non-staff must stamp their org; staff may leave null (CCL legado) or pick one.
    const org = resolveLogtoOrgId(actor, parsed.data.logtoOrgId ?? null);
    if (!org.ok) return c.json({ error: org.error }, org.status);
    const { logtoOrgId: _drop, ...rest } = parsed.data;
    const project = await deps.store.insertProject({ ...rest, logtoOrgId: org.logtoOrgId } as never);
    return c.json(project, 201);
  });

  // Huginn Phase 2: turn the discovery brief's "missing" items into PROPOSED
  // cards — one backlog task per item. Backlog (not queued) IS the approval gate:
  // claimNext never runs a backlog card, so nothing executes until you queue it.
  // Idempotent: re-running skips items already carded (matched on the item text).
  r.post("/:id/backlog-from-brief", async (c) => {
    const id = c.req.param("id");
    const actor = actorFrom(c);
    const project = await deps.store.getProject(id);
    if (!project || !canSeeProject(actor, project.logtoOrgId)) {
      return c.json({ error: "not found" }, 404);
    }
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

  // Muninn: turn a meeting's classified `ajustes` into PROPOSED cards — the
  // meeting-fed sibling of backlog-from-brief. Two differences from Huginn's brief:
  //  1. A meeting's ajustes are INDEPENDENT (each its own story → its own PR), so
  //     they do NOT share a feature plan; planId stays null.
  //  2. `vira_plano` ajustes (épico/discovery) are NOT forge-ready — they need the
  //     planner to break them down first. They get the MUNINN_PLAN_LABEL, which
  //     approve-proposed does NOT auto-enqueue; simple ajustes get DISCOVERY_LABEL
  //     (forge-ready). bloqueado/deferido never become cards — returned as notes.
  // Accepts the Muninn output directly (runMeetingScout runs upstream, e.g. in the
  // scout service, so this stays a fast DB write, not a 60s LLM call in-request).
  // Idempotent: dedup on card title (matched against prior Muninn cards).
  r.post("/:id/ajustes-from-meeting", async (c) => {
    const id = c.req.param("id");
    const actor = actorFrom(c);
    const project = await deps.store.getProject(id);
    if (!project || !canSeeProject(actor, project.logtoOrgId)) {
      return c.json({ error: "not found" }, 404);
    }
    const parsed = AjustesFromMeetingBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const { meetingTitle, ajustes } = parsed.data;

    const cardAjustes = ajustes.filter((a) => a.disposicao === "pronto" || a.disposicao === "discovery");
    const notes = ajustes.filter((a) => a.disposicao === "bloqueado" || a.disposicao === "deferido");

    const existing = await deps.store.listTasks({ projectId: id });
    const seen = new Set(
      existing
        .filter((t) => (t.labels ?? []).some((l) => l === DISCOVERY_LABEL || l === MUNINN_PLAN_LABEL))
        .map((t) => normItem(t.title ?? "")),
    );

    const created = [];
    let skipped = 0;
    for (const a of cardAjustes) {
      if (seen.has(normItem(a.titulo))) {
        skipped++;
        continue;
      }
      seen.add(normItem(a.titulo));
      const label = a.vira_plano ? MUNINN_PLAN_LABEL : DISCOVERY_LABEL;
      const task = await deps.store.insertTask({
        projectId: id,
        title: toCardTitle(a.titulo),
        body: `${a.o_que_pediram}\n\n— reunião: ${meetingTitle} · ${a.area}/${a.tipo} · ${a.disposicao}${a.vira_plano ? " · vira plano" : ""} (Muninn)`,
        status: "backlog",
        baseBranch: project.baseBranch,
        createdBy: "muninn",
        labels: [label],
        planId: null,
        planKey: null,
        dependsOn: [],
        // Origin evidence: the real meeting quotes, for the analyst to cite from.
        evidence: a.evidencia.map((e) => ({ quote: e.quote, speaker: e.speaker ?? null, note: null })),
      });
      created.push(task);
    }
    // notes are surfaced (bloqueado/deferido) but never carded — the caller shows
    // them so nothing said in the meeting silently vanishes.
    return c.json(
      {
        created,
        skipped,
        notes: notes.map((n) => ({ titulo: n.titulo, disposicao: n.disposicao, nota: n.nota ?? null })),
      },
      201,
    );
  });

  // Huginn Phase 3: "Aprovar todos" — enqueue every PROPOSED backlog card at once
  // (those Huginn discovery or the Sindri planner staged). backlog→queued is the
  // gate, so this flips the whole proposed set into the forge in one click.
  r.post("/:id/approve-proposed", async (c) => {
    const id = c.req.param("id");
    const actor = actorFrom(c);
    const project = await deps.store.getProject(id);
    if (!project || !canSeeProject(actor, project.logtoOrgId)) {
      return c.json({ error: "not found" }, 404);
    }
    const backlog = await deps.store.listTasks({ projectId: id, status: "backlog" });
    const proposed = backlog.filter((t) =>
      (t.labels ?? []).some((l) => l === DISCOVERY_LABEL || l === PLAN_LABEL),
    );
    // Route through transitionTask so each move lands on the lifecycle trail and
    // gets the queued⇒owner=brokk guard (a raw updateTask would bypass both).
    const who = actor.email || "human";
    for (const t of proposed) {
      await deps.store.transitionTask(t.id, "queued", { actor: who, reason: "approve-proposed" });
    }
    return c.json({ enqueued: proposed.length }, 200);
  });

  return r;
}

const DISCOVERY_LABEL = "discovery";
const PLAN_LABEL = "plan";
// Muninn ajustes flagged vira_plano — proposed but NOT forge-ready (await the
// planner). approve-proposed deliberately ignores this label.
const MUNINN_PLAN_LABEL = "muninn-plan";

// One ajuste as Muninn classifies it (mirrors packages/agents/scout meeting.ts).
const AjusteSchema = z.object({
  titulo: z.string().min(1),
  o_que_pediram: z.string().default(""),
  area: z.enum(["mockup", "crm", "ativacoes", "billing", "outro"]).default("outro"),
  tipo: z.enum(["bug", "ajuste", "feature", "epico"]).default("ajuste"),
  disposicao: z.enum(["pronto", "discovery", "bloqueado", "deferido"]).default("discovery"),
  vira_plano: z.boolean().default(false),
  // Verbatim meeting excerpts grounding the ajuste → stored as the card's origin
  // evidence (tasks.evidence) so the analyst can cite real quotes for traceability.
  evidencia: z
    .array(z.object({ quote: z.string().min(1), speaker: z.string().optional() }))
    .default([]),
  nota: z.string().optional(),
});
const AjustesFromMeetingBody = z.object({
  meetingTitle: z.string().min(1).default("Reunião"),
  ajustes: z.array(AjusteSchema).default([]),
});
const normItem = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 200);
/** A concise card title from a (possibly long) missing-item sentence. */
function toCardTitle(item: string): string {
  const t = item.replace(/\s+/g, " ").trim();
  if (t.length <= 90) return t;
  return `${t.slice(0, 88).replace(/\s\S*$/, "")}…`;
}
