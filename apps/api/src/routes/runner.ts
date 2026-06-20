import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { z } from "zod";
import type { AppDeps } from "../app.js";

/** Guard for machine endpoints: requires `Authorization: Bearer <secret>`.
 *  If no secret is configured the endpoints are closed (503) rather than open. */
export function requireRunnerSecret(deps: AppDeps): MiddlewareHandler {
  return async (c, next) => {
    if (!deps.runnerSecret) {
      return c.json({ error: "runner endpoints disabled (no BROKK_RUNNER_SECRET)" }, 503);
    }
    const auth = c.req.header("authorization") ?? "";
    const token = auth.replace(/^Bearer\s+/i, "");
    if (token !== deps.runnerSecret) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  };
}

const RegisterBody = z.object({
  host: z.string().min(1),
  capabilities: z.array(z.string()).default([]),
  runnerId: z.string().uuid().optional(),
});

export function runnerRoutes(deps: AppDeps): Hono {
  const r = new Hono();

  r.use("*", requireRunnerSecret(deps));

  r.post("/register", async (c) => {
    const parsed = RegisterBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    // TODO(P1): upsert into `agents` (store helper not yet exposed). For the
    // scaffold we echo a synthetic id so the runner loop can proceed.
    return c.json({ runnerId: parsed.data.runnerId ?? crypto.randomUUID() }, 201);
  });

  r.post("/heartbeat", async (c) => {
    // TODO(P1): bump agents.lastSeenAt / status.
    return c.json({ ok: true });
  });

  // Returns the next queued task + a fresh run, or 204 when the queue is empty.
  r.post("/claim", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const runnerId = typeof body?.runnerId === "string" ? body.runnerId : crypto.randomUUID();
    const claimed = await deps.store.claimNext(runnerId);
    if (!claimed) return c.body(null, 204);
    return c.json(claimed);
  });

  return r;
}
