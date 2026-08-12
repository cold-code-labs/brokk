import { Hono } from "hono";
import { z } from "zod";
import type { AppDeps } from "../app.js";
import { requireActor } from "../actor.js";

const CreateUserBody = z.object({
  name: z.string().min(1).max(120),
  email: z.string().email(),
  githubLogin: z.string().optional(),
  role: z.string().default("member"),
});

/** Crew roster is staff-only (Admin/Proprietário / CCL). Members must not list
 *  or mint seats for arbitrary users. */
function requireStaff(
  c: Parameters<typeof requireActor>[0],
  runnerSecret: string,
): ReturnType<typeof requireActor> | { ok: false; error: string; status: 403 } {
  const who = requireActor(c, runnerSecret);
  if (!who.ok) return who;
  if (!who.actor.isStaff) return { ok: false, error: "forbidden", status: 403 };
  return who;
}

export function usersRoutes(deps: AppDeps): Hono {
  const r = new Hono();

  r.get("/", async (c) => {
    const who = requireStaff(c, deps.runnerSecret);
    if (!who.ok) return c.json({ error: who.error }, who.status);
    return c.json(await deps.store.listUsers());
  });

  r.post("/", async (c) => {
    const who = requireStaff(c, deps.runnerSecret);
    if (!who.ok) return c.json({ error: who.error }, who.status);
    const parsed = CreateUserBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const user = await deps.store.insertUser(parsed.data);
    return c.json(user, 201);
  });

  r.get("/:id", async (c) => {
    const who = requireStaff(c, deps.runnerSecret);
    if (!who.ok) return c.json({ error: who.error }, who.status);
    const user = await deps.store.getUser(c.req.param("id"));
    if (!user) return c.json({ error: "not found" }, 404);
    return c.json(user);
  });

  r.get("/:id/subscriptions", async (c) => {
    const who = requireStaff(c, deps.runnerSecret);
    if (!who.ok) return c.json({ error: who.error }, who.status);
    return c.json(await deps.store.listSubscriptions(c.req.param("id")));
  });

  return r;
}
