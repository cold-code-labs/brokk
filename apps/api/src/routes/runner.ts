import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { z } from "zod";
import type { AppDeps } from "../app.js";
import { unseal } from "../secrets.js";

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
    const agent = await deps.store.registerAgent(parsed.data.host, parsed.data.capabilities);
    return c.json({ runnerId: agent.id }, 201);
  });

  r.post("/heartbeat", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (typeof body?.runnerId === "string") {
      await deps.store.touchAgent(body.runnerId).catch(() => {});
    }
    return c.json({ ok: true });
  });

  // Returns the next queued task + a fresh run + the auth to run it with, or 204.
  // The seat token is decrypted here (the control plane holds the key); the
  // runner just receives it. No seat → runner falls back to its ambient token.
  r.post("/claim", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const runnerId = typeof body?.runnerId === "string" ? body.runnerId : crypto.randomUUID();
    const claimed = await deps.store.claimNext(runnerId);
    if (!claimed) return c.body(null, 204);

    const { task, run, sealedToken } = claimed;
    let auth: { source: "seat" | "env"; token: string | null; subscriptionId: string | null } = {
      source: "env",
      token: null,
      subscriptionId: null,
    };
    if (sealedToken) {
      try {
        auth = { source: "seat", token: unseal(sealedToken), subscriptionId: run.subscriptionId };
      } catch {
        // Sealing key missing/rotated → leave the runner on its ambient token.
      }
    }
    return c.json({ task, run, auth });
  });

  return r;
}
