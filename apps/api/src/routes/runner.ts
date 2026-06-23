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

    const { task, run, repository, project, plan, sealedToken } = claimed;
    // claimNext returns weight-ordered memory; re-rank it semantically by the
    // card's intent (#2), best-effort — falls back to the weight order on any miss.
    let memory = claimed.memory;
    const sem = await deps.store
      .searchRepoMemories(repository.id, `${task.title}\n${task.body}`)
      .catch(() => [] as typeof memory);
    if (sem.length) memory = sem;
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
    // repository/project resolve the footgun (no more BROKK_DEFAULT_REPO); plan
    // (if any) carries the shared feature branch the card composes into; memory
    // is the per-repo learned context the forge prompt injects (#2).
    return c.json({ task, run, repository, project, plan, auth, memory });
  });

  // Refresh a repo's warm map (#4). The runner POSTs this after a forge so the
  // planner reads the current tree without a checkout of its own.
  r.post("/repos/:id/map", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const map = typeof body?.map === "string" ? body.map : "";
    if (!map) return c.json({ error: "map required" }, 400);
    await deps.store.setRepoMap(c.req.param("id"), map);
    return c.json({ ok: true });
  });

  // Set a plan's PR the first time one of its cards pushes (idempotent — later
  // cards get the same PR back). The runner calls this before opening a PR.
  r.post("/plans/:id/pr", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const url = typeof body?.url === "string" ? body.url : "";
    if (!url) return c.json({ error: "url required" }, 400);
    const number = typeof body?.number === "number" ? body.number : null;
    const plan = await deps.store.setPlanPrIfUnset(c.req.param("id"), url, number);
    return c.json(plan);
  });

  return r;
}
