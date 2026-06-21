import { RUN_EVENT_TYPES, type RunEventType } from "@brokk/core";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { AppDeps } from "../app.js";
import { requireRunnerSecret } from "./runner.js";

const AppendEventsBody = z.object({
  events: z
    .array(
      z.object({
        type: z.enum(RUN_EVENT_TYPES as unknown as [string, ...string[]]),
        payload: z.unknown(),
      }),
    )
    .min(1),
});

const CompleteBody = z.object({
  status: z.enum(["succeeded", "failed", "cancelled"]),
  prUrl: z.string().nullable().optional(),
  prNumber: z.number().int().positive().nullable().optional(),
  error: z.string().nullable().optional(),
  usage: z
    .object({
      tokensIn: z.number().int().default(0),
      tokensOut: z.number().int().default(0),
      headroomSaved: z.number().int().default(0),
    })
    .optional(),
});

export function runsRoutes(deps: AppDeps): Hono {
  const r = new Hono();

  r.get("/:id", async (c) => {
    const run = await deps.store.getRun(c.req.param("id"));
    if (!run) return c.json({ error: "not found" }, 404);
    return c.json(run);
  });

  // Live log via SSE. Polls the append-only event table and pushes new rows.
  r.get("/:id/events", (c) => {
    const id = c.req.param("id");
    return streamSSE(c, async (stream) => {
      let lastSeq = -1;
      while (!stream.closed) {
        const events = await deps.store.listEvents(id, lastSeq);
        for (const e of events) {
          lastSeq = e.seq;
          await stream.writeSSE({ id: String(e.seq), event: e.type, data: JSON.stringify(e) });
        }
        const run = await deps.store.getRun(id);
        if (run && run.status !== "running" && run.status !== "queued") {
          await stream.writeSSE({ event: "done", data: JSON.stringify({ status: run.status }) });
          break;
        }
        await stream.sleep(1000);
      }
    });
  });

  // ── Runner-facing (shared-secret) ──────────────────────────────────────────

  // Batch-append events from the runner.
  r.post("/:id/events", requireRunnerSecret(deps), async (c) => {
    const parsed = AppendEventsBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    // zod validated `type ∈ RUN_EVENT_TYPES`; cast back to the domain shape the store expects.
    const events = parsed.data.events as { type: RunEventType; payload: unknown }[];
    const appended = await deps.store.appendEvents(c.req.param("id"), events);
    return c.json({ appended: appended.length }, 201);
  });

  // Runner reports terminal state for a run; moves the task accordingly.
  r.post("/:id/complete", requireRunnerSecret(deps), async (c) => {
    const id = c.req.param("id");
    const parsed = CompleteBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const { status, prUrl, prNumber, error, usage } = parsed.data;

    const run = await deps.store.updateRun(id, {
      status,
      prUrl: prUrl ?? null,
      error: error ?? null,
      endedAt: new Date(),
      ...(usage
        ? {
            tokensIn: usage.tokensIn,
            tokensOut: usage.tokensOut,
            headroomSaved: usage.headroomSaved,
          }
        : {}),
    });

    // Map run outcome → task column. PR open → review; merge (webhook) → done.
    const taskStatus =
      status === "succeeded" ? "review" : status === "failed" ? "failed" : "cancelled";
    const resolvedPrNumber = prNumber ?? (prUrl ? prNumberFromUrl(prUrl) : null);
    await deps.store.updateTask(run.taskId, {
      status: taskStatus,
      ...(prUrl ? { prUrl } : {}),
      ...(resolvedPrNumber ? { prNumber: resolvedPrNumber } : {}),
    });

    return c.json(run);
  });

  return r;
}

function prNumberFromUrl(url: string): number | null {
  const m = url.match(/\/pull\/(\d+)/);
  return m ? Number(m[1]) : null;
}
