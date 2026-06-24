import { AUTH_MODES } from "@brokk/core";
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
    const seen = new Set(
      existing
        .filter((t) => (t.labels ?? []).includes(DISCOVERY_LABEL))
        .map((t) => normItem((t.body ?? "").split("\n")[0] ?? "")),
    );

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
      });
      created.push(task);
    }
    return c.json({ created, skipped }, 201);
  });

  return r;
}

const DISCOVERY_LABEL = "discovery";
const normItem = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 200);
/** A concise card title from a (possibly long) missing-item sentence. */
function toCardTitle(item: string): string {
  const t = item.replace(/\s+/g, " ").trim();
  if (t.length <= 90) return t;
  return `${t.slice(0, 88).replace(/\s\S*$/, "")}…`;
}
