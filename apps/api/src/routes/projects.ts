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

  return r;
}
