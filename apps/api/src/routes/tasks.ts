import { TASK_STATUSES } from "@brokk/core";
import { Hono } from "hono";
import { z } from "zod";
import type { AppDeps } from "../app.js";

const CreateTaskBody = z.object({
  projectId: z.string().uuid(),
  title: z.string().min(1).max(200),
  body: z.string().default(""),
  priority: z.number().int().default(0),
  labels: z.array(z.string()).default([]),
  baseBranch: z.string().optional(),
  createdBy: z.string().optional(),
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
    const task = await deps.store.insertTask({ ...parsed.data, status: "backlog" });
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

  // Edit fields or move column.
  r.patch("/:id", async (c) => {
    const parsed = PatchTaskBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const task = await deps.store.updateTask(c.req.param("id"), parsed.data as never);
    return c.json(task);
  });

  // Move a card to `queued` → enqueues a run (a runner will claim it).
  r.post("/:id/enqueue", async (c) => {
    const id = c.req.param("id");
    const task = await deps.store.getTask(id);
    if (!task) return c.json({ error: "not found" }, 404);
    const updated = await deps.store.updateTask(id, { status: "queued" });
    return c.json(updated);
  });

  return r;
}
