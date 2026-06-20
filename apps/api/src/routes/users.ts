import { Hono } from "hono";
import { z } from "zod";
import type { AppDeps } from "../app.js";

const CreateUserBody = z.object({
  name: z.string().min(1).max(120),
  email: z.string().email(),
  githubLogin: z.string().optional(),
  role: z.string().default("member"),
});

export function usersRoutes(deps: AppDeps): Hono {
  const r = new Hono();

  r.get("/", async (c) => c.json(await deps.store.listUsers()));

  r.post("/", async (c) => {
    const parsed = CreateUserBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const user = await deps.store.insertUser(parsed.data);
    return c.json(user, 201);
  });

  r.get("/:id", async (c) => {
    const user = await deps.store.getUser(c.req.param("id"));
    if (!user) return c.json({ error: "not found" }, 404);
    return c.json(user);
  });

  r.get("/:id/subscriptions", async (c) => {
    return c.json(await deps.store.listSubscriptions(c.req.param("id")));
  });

  return r;
}
