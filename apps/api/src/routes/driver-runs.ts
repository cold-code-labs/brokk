// ─────────────────────────────────────────────────────────────────────────────
// Driver runs (ADR 0054) — a bg task where the agent DRIVES a live preview via
// the Playwright MCP. Two identities manage them, same posture as previews: the
// forge runner (claim + status, BROKK_RUNNER_SECRET) and the human UI / chat
// (create + cancel, BROKK_API_SECRET). Accept either.
// ─────────────────────────────────────────────────────────────────────────────
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { z } from "zod";
import type { AppDeps } from "../app.js";
import { secretEquals } from "../secrets.js";

function requireRunnerOrApiSecret(deps: AppDeps): MiddlewareHandler {
  return async (c, next) => {
    if (!deps.runnerSecret) {
      return c.json({ error: "runner endpoints disabled (no BROKK_RUNNER_SECRET)" }, 503);
    }
    const token = (c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (
      secretEquals(token, deps.runnerSecret) ||
      (deps.apiSecret && secretEquals(token, deps.apiSecret))
    ) {
      return next();
    }
    return c.json({ error: "unauthorized" }, 401);
  };
}

const CreateBody = z.object({
  previewId: z.string().uuid(),
  instruction: z.string().min(1),
});

const StatusBody = z.object({
  status: z.enum(["running", "done", "failed", "cancelled"]).optional(),
  result: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
  finished: z.boolean().optional(),
});

export function driverRunsRoutes(deps: AppDeps): Hono {
  const r = new Hono();
  r.use("*", requireRunnerOrApiSecret(deps));

  /** POST /driver-runs — enqueue a driver run against a live preview. */
  r.post("/", async (c) => {
    const parsed = CreateBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const preview = await deps.store.getPreview(parsed.data.previewId);
    if (!preview) return c.json({ error: "preview not found" }, 404);
    const run = await deps.store.createDriverRun(parsed.data);
    return c.json(run, 201);
  });

  /** POST /driver-runs/claim — the forge claims the oldest queued run and gets
   *  the live preview's port + worktree name so it can drive it. 204 = empty. */
  r.post("/claim", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { runnerId?: string };
    const run = await deps.store.claimDriverRun(String(body.runnerId || "unknown"));
    if (!run) return c.body(null, 204);
    const preview = await deps.store.getPreview(run.previewId);
    return c.json({
      run,
      preview: preview
        ? { port: preview.port, hauldrProject: preview.hauldrProject, status: preview.status }
        : null,
    });
  });

  /** GET /driver-runs/:id — status + result. The chat polls this; the forge
   *  polls it to notice a cancel. */
  r.get("/:id", async (c) => {
    const run = await deps.store.getDriverRun(c.req.param("id"));
    if (!run) return c.json({ error: "not found" }, 404);
    return c.json(run);
  });

  /** POST /driver-runs/:id/status — the forge reports progress / final outcome. */
  r.post("/:id/status", async (c) => {
    const parsed = StatusBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const run = await deps.store.updateDriverRun(c.req.param("id"), parsed.data);
    return c.json(run);
  });

  /** POST /driver-runs/:id/cancel — the kill switch. Queued → cancelled at once;
   *  running → cancelling (the forge tears the turn down and finalizes). */
  r.post("/:id/cancel", async (c) => {
    const run = await deps.store.requestCancelDriverRun(c.req.param("id"));
    if (!run) {
      const existing = await deps.store.getDriverRun(c.req.param("id"));
      if (!existing) return c.json({ error: "not found" }, 404);
      return c.json({ error: `already ${existing.status}` }, 409);
    }
    return c.json(run);
  });

  return r;
}
