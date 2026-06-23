import {
  featureBranch,
  FORCA_LEVELS,
  type ForcaLevel,
  REFINO_LEVELS,
  type RefinoLevel,
} from "@brokk/core";
import type { MimirConfig } from "@brokk/mimir";
import { enhancePrompt, isMimirMode, MimirError, planJob, triagePrompt } from "@brokk/mimir";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import type { AppDeps } from "../app.js";

// Author is an optional snapshot (no auth context in the API yet — the board is
// behind CF Access at the edge). The UI can pass the configured member.
const Author = z.object({
  authorId: z.string().optional(),
  authorName: z.string().optional(),
  authorEmail: z.string().optional(),
});

const CreatePromptBody = z
  .object({
    title: z.string().min(1).max(200),
    body: z.string().min(1),
    tags: z.array(z.string()).default([]),
  })
  .merge(Author);

const UpdatePromptBody = z.object({
  title: z.string().min(1).max(200).optional(),
  body: z.string().min(1).optional(),
  tags: z.array(z.string()).optional(),
});

const TriageBody = z.object({ input: z.string().min(1) });

const LinkBody = z.object({ taskId: z.string().min(1) });

const EnhanceBody = z
  .object({
    input: z.string().min(1),
    mode: z.string().default("structure"),
    // The triador's decision that drove this enhance (recorded for the loop).
    triage: z
      .object({
        refino: z.string(),
        refinoConf: z.number().optional(),
        forca: z.string(),
        forcaConf: z.number().optional(),
        rationale: z.string().optional(),
        source: z.enum(["auto", "override"]).default("auto"),
        model: z.string().optional(),
      })
      .optional(),
  })
  .merge(Author);

const PlanBody = z.object({
  input: z.string().min(1),
  projectId: z.string().optional(),
});

const PlannedCardSchema = z.object({
  key: z.string().min(1),
  title: z.string().min(1),
  body: z.string().min(1),
  forca: z.enum(["low", "medium", "high", "extra"]),
  model: z.string(),
  effort: z.enum(["low", "medium", "high"]),
  dependsOn: z.array(z.string()).default([]),
  touches: z.array(z.string()).default([]),
  acceptance: z.string().default(""),
});

const PlanApplyBody = z
  .object({
    input: z.string().min(1),
    projectId: z.string().min(1),
    plan: z.object({
      mode: z.enum(["atomic", "feature"]),
      summary: z.string().min(1),
      rationale: z.string().default(""),
      targetBranch: z.string().default("dev"),
      model: z.string().optional(),
      cards: z.array(PlannedCardSchema).min(1),
    }),
  })
  .merge(Author);

const asRefino = (v: string): RefinoLevel =>
  (REFINO_LEVELS as readonly string[]).includes(v) ? (v as RefinoLevel) : "structure";
const asForca = (v: string): ForcaLevel =>
  (FORCA_LEVELS as readonly string[]).includes(v) ? (v as ForcaLevel) : "medium";

/** Assemble the planner's repo context (#2 + #4): the warm repo map (tree +
 *  packages, refreshed by the runner after each forge) and the per-repo memory
 *  (conventions, pitfalls, past review failures). Empty string when the project
 *  is unknown or nothing's been learned/mapped yet — the planner runs without it. */
async function buildRepoContext(
  store: AppDeps["store"],
  projectId?: string,
  queryText?: string,
): Promise<string | undefined> {
  if (!projectId) return undefined;
  const project = await store.getProject(projectId).catch(() => null);
  if (!project) return undefined;
  const repo = await store.getRepository(project.repositoryId).catch(() => null);
  if (!repo) return undefined;
  // Semantic recall when we have the intent text (#2); else weight order.
  const memories = queryText
    ? await store.searchRepoMemories(repo.id, queryText).catch(() => [])
    : await store.listRepoMemories(repo.id).catch(() => []);
  const blocks: string[] = [];
  if (repo.repoMap) blocks.push(`## Mapa do repositório\n${repo.repoMap}`);
  if (memories.length) {
    const lines = memories.map((m) => `- (${m.kind}, peso ${m.weight}) ${m.content}`);
    blocks.push(
      `## Memória do repositório (lições aprendidas — RESPEITE)\n${lines.join("\n")}`,
    );
  }
  return blocks.length ? blocks.join("\n\n") : undefined;
}

export function mimirRoutes(deps: AppDeps): Hono {
  const r = new Hono();
  const mimir: MimirConfig | undefined = deps.mimir;

  // ── The bank ──────────────────────────────────────────────────────────────
  r.get("/prompts", async (c) => {
    const authorId = c.req.query("authorId") || undefined;
    return c.json(await deps.store.listMimirPrompts({ authorId }));
  });

  r.get("/prompts/search", async (c) => {
    const q = c.req.query("q") ?? "";
    if (!q.trim()) return c.json([]);
    return c.json(await deps.store.searchMimirPrompts(q));
  });

  r.post("/prompts", async (c) => {
    const p = CreatePromptBody.safeParse(await c.req.json().catch(() => ({})));
    if (!p.success) return c.json({ error: p.error.flatten() }, 400);
    return c.json(await deps.store.insertMimirPrompt(p.data), 201);
  });

  r.get("/prompts/:id", async (c) => {
    const row = await deps.store.getMimirPrompt(c.req.param("id"));
    if (!row) return c.json({ error: "not found" }, 404);
    return c.json(row);
  });

  r.patch("/prompts/:id", async (c) => {
    const p = UpdatePromptBody.safeParse(await c.req.json().catch(() => ({})));
    if (!p.success) return c.json({ error: p.error.flatten() }, 400);
    return c.json(await deps.store.updateMimirPrompt(c.req.param("id"), p.data));
  });

  r.delete("/prompts/:id", async (c) => {
    await deps.store.deleteMimirPrompt(c.req.param("id"));
    return c.json({ ok: true });
  });

  // ── The history ─────────────────────────────────────────────────────────────
  r.get("/revisions", async (c) => {
    const authorId = c.req.query("authorId") || undefined;
    return c.json(await deps.store.listMimirRevisions({ authorId }));
  });

  // ── The calibration loop ────────────────────────────────────────────────────
  // Link a triage to the task it forged, then read each decision against its real
  // outcome (run status + Eitri's verdict) to learn whether the levels fit.
  r.post("/triage/:id/link", async (c) => {
    const p = LinkBody.safeParse(await c.req.json().catch(() => ({})));
    if (!p.success) return c.json({ error: p.error.flatten() }, 400);
    return c.json(await deps.store.linkTriageToTask(c.req.param("id"), p.data.taskId));
  });

  r.get("/calibration", async (c) => c.json(await deps.store.listTriageCalibration()));

  // ── The triador (advisory — no write until an enhance happens) ──────────────
  r.post("/triage", async (c) => {
    if (!mimir) return c.json({ error: "MIMIR_API_KEY not configured" }, 503);
    const p = TriageBody.safeParse(await c.req.json().catch(() => ({})));
    if (!p.success) return c.json({ error: p.error.flatten() }, 400);
    try {
      return c.json(await triagePrompt(p.data.input, mimir));
    } catch (e) {
      if (e instanceof MimirError)
        return c.json({ error: e.userMessage() }, (e.status || 500) as ContentfulStatusCode);
      throw e;
    }
  });

  // ── The enhancer (records an immutable revision; links the triage if given) ──
  r.post("/enhance", async (c) => {
    if (!mimir) return c.json({ error: "MIMIR_API_KEY not configured" }, 503);
    const p = EnhanceBody.safeParse(await c.req.json().catch(() => ({})));
    if (!p.success) return c.json({ error: p.error.flatten() }, 400);
    const mode = isMimirMode(p.data.mode) ? p.data.mode : "structure";
    try {
      const result = await enhancePrompt(p.data.input, mode, mimir);
      const revision = await deps.store.insertMimirRevision({
        input: p.data.input,
        output: result.enhanced,
        rationale: result.rationale,
        model: result.model,
        mode: result.mode,
        authorId: p.data.authorId ?? null,
        authorName: p.data.authorName ?? null,
        authorEmail: p.data.authorEmail ?? null,
      });
      let triageId: string | undefined;
      if (p.data.triage) {
        const t = p.data.triage;
        const tri = await deps.store.insertMimirTriage({
          revisionId: revision.id,
          refinoLevel: asRefino(t.refino),
          refinoConf: t.refinoConf ?? null,
          forcaLevel: asForca(t.forca),
          forcaConf: t.forcaConf ?? null,
          rationale: t.rationale ?? null,
          source: t.source,
          triageModel: t.model ?? null,
        });
        triageId = tri.id;
      }
      return c.json({ ...result, revisionId: revision.id, triageId });
    } catch (e) {
      if (e instanceof MimirError)
        return c.json({ error: e.userMessage() }, (e.status || 500) as ContentfulStatusCode);
      throw e;
    }
  });

  // ── The planner (advisory — one intent → cards) ─────────────────────────────
  r.post("/plan", async (c) => {
    if (!mimir) return c.json({ error: "Mímir não configurado" }, 503);
    const p = PlanBody.safeParse(await c.req.json().catch(() => ({})));
    if (!p.success) return c.json({ error: p.error.flatten() }, 400);
    try {
      const repoContext = await buildRepoContext(deps.store, p.data.projectId, p.data.input);
      return c.json(await planJob(p.data.input, mimir, repoContext));
    } catch (e) {
      if (e instanceof MimirError)
        return c.json({ error: e.userMessage() }, (e.status || 500) as ContentfulStatusCode);
      throw e;
    }
  });

  // ── Apply a (reviewed/edited) plan → persist it + queue the cards ────────────
  r.post("/plan/apply", async (c) => {
    const p = PlanApplyBody.safeParse(await c.req.json().catch(() => ({})));
    if (!p.success) return c.json({ error: p.error.flatten() }, 400);
    const { input, projectId, plan } = p.data;

    const project = await deps.store.getProject(projectId);
    if (!project) return c.json({ error: "projeto não encontrado" }, 400);

    const createdBy = p.data.authorName ?? p.data.authorId ?? null;
    // Insert the plan, then derive its feature branch from the new id.
    const draft = await deps.store.insertPlan({
      projectId,
      prompt: input,
      summary: plan.summary,
      rationale: plan.rationale || null,
      mode: plan.mode,
      status: "forging",
      featureBranch: "pending",
      baseBranch: plan.targetBranch,
      model: plan.model ?? null,
      createdBy,
    });
    const planRow = await deps.store.updatePlan(draft.id, {
      featureBranch: featureBranch(plan.summary, draft.id),
    });

    const tasks = [];
    for (const card of plan.cards) {
      tasks.push(
        await deps.store.insertTask({
          projectId,
          title: card.title,
          body: card.body,
          status: "queued",
          kind: "implement",
          planId: planRow.id,
          planKey: card.key,
          dependsOn: card.dependsOn,
          forca: card.forca,
          touches: card.touches,
          acceptance: card.acceptance || null,
          baseBranch: plan.targetBranch,
          createdBy,
        }),
      );
    }
    return c.json({ plan: planRow, tasks }, 201);
  });

  r.get("/plans", async (c) => {
    const projectId = c.req.query("projectId") || undefined;
    return c.json(await deps.store.listPlans({ projectId }));
  });

  r.get("/plans/:id", async (c) => {
    const plan = await deps.store.getPlan(c.req.param("id"));
    if (!plan) return c.json({ error: "not found" }, 404);
    const tasks = await deps.store.getPlanTasks(plan.id);
    return c.json({ plan, tasks });
  });

  return r;
}
