import { RUN_EVENT_TYPES, type RunEventType } from "@brokk/core";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { AppDeps } from "../app.js";
import { connectOne } from "./repositories.js";
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
  /** ADR 0017 dev-lane: the run pushed straight to `dev` (no PR). A succeeded
   *  landed run closes the card → `done` (not `review`, which awaits a PR merge). */
  landed: z.boolean().optional(),
});

// The orchestrator facade. Collapses the connect-repo → ensure-project →
// create-task → enqueue dance into one call, so a caller like Asgard can drive
// Brokk from a single natural-language brief. One of repoFullName / projectId.
const FromBriefBody = z
  .object({
    repoFullName: z.string().min(3).optional(),
    projectId: z.string().uuid().optional(),
    brief: z.string().min(1),
    title: z.string().min(1).max(200).optional(),
    defaultBranch: z.string().default("main"),
    baseBranch: z.string().optional(),
    createdBy: z.string().default("asgard"),
    // Idempotency (ADR 0005). If a non-terminal task in the project already carries
    // this key, its handle is returned instead of forging a duplicate. Caller owns
    // the namespace (e.g. "svalinn:<target>:<engine>:<rule>").
    dedupeKey: z.string().min(1).max(200).optional(),
  })
  .refine((d) => Boolean(d.repoFullName) || Boolean(d.projectId), {
    message: "repoFullName or projectId is required",
  });

export function runsRoutes(deps: AppDeps): Hono {
  const r = new Hono();

  // Facade: brief → a `queued` task (a runner claims it on its next poll). Returns
  // a handle whose `events` URL streams the run once it materializes — so the
  // caller drives the whole thing with one POST + one SSE, no polling for ids.
  r.post("/from-brief", async (c) => {
    const parsed = FromBriefBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const { repoFullName, projectId, brief, title, defaultBranch, baseBranch, createdBy, dedupeKey } =
      parsed.data;

    let project: Awaited<ReturnType<typeof deps.store.getProject>> = null;
    if (projectId) {
      project = await deps.store.getProject(projectId);
      if (!project) return c.json({ error: "project not found" }, 404);
    } else {
      // Ensure the repo is connected and has a project (creates both + scouts it).
      const connected = await connectOne(deps, { fullName: repoFullName!, defaultBranch }, true);
      project = connected.project;
    }
    if (!project) return c.json({ error: "could not resolve a project for the repo" }, 502);

    const handle = (t: { id: string; status: string }) => ({
      taskId: t.id,
      projectId: project!.id,
      repositoryId: project!.repositoryId,
      status: t.status,
      events: `/runs/by-task/${t.id}/events`,
      task: `/tasks/${t.id}`,
      runs: `/tasks/${t.id}/runs`,
    });

    // Idempotency: an active task with this key already exists → return it, don't
    // forge a second (racing) PR for the same work.
    if (dedupeKey) {
      const existing = await deps.store.findActiveTaskByDedupeKey(project.id, dedupeKey);
      if (existing) return c.json({ ...handle(existing), deduped: true }, 200);
    }

    const task = await deps.store.insertTask({
      projectId: project.id,
      title: (title ?? firstLine(brief)).slice(0, 200),
      body: brief,
      status: "queued",
      createdBy,
      ...(baseBranch ? { baseBranch } : {}),
      ...(dedupeKey ? { dedupeKey } : {}),
    });

    return c.json(handle(task), 201);
  });

  // Task-keyed live stream: wait for the runner to materialize a run for this
  // task, announce it via a `run` event, then proxy the run's log to completion.
  // Mirrors `/runs/:id/events` once the (lazy) run exists.
  r.get("/by-task/:taskId/events", (c) => {
    const taskId = c.req.param("taskId");
    return streamSSE(c, async (stream) => {
      let runId: string | null = null;
      while (!stream.closed && !runId) {
        const runs = await deps.store.listRunsByTask(taskId);
        if (runs.length) {
          runId = runs[0]!.id; // newest first
          await stream.writeSSE({ event: "run", data: JSON.stringify({ taskId, runId }) });
          break;
        }
        await stream.writeSSE({ event: "waiting", data: JSON.stringify({ taskId }) });
        await stream.sleep(1000);
      }
      if (!runId) return;

      let lastSeq = -1;
      while (!stream.closed) {
        const events = await deps.store.listEvents(runId, lastSeq);
        for (const e of events) {
          lastSeq = e.seq;
          await stream.writeSSE({ id: String(e.seq), event: e.type, data: JSON.stringify(e) });
        }
        const run = await deps.store.getRun(runId);
        if (run && run.status !== "running" && run.status !== "queued") {
          await stream.writeSSE({
            event: "done",
            data: JSON.stringify({ status: run.status, prUrl: run.prUrl ?? null }),
          });
          break;
        }
        await stream.sleep(1000);
      }
    });
  });

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
    const { status, prUrl, prNumber, error, usage, landed } = parsed.data;

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

    // ADR 0017: free the app's dev-checkout lease this run held, so the next card
    // for that app can claim. Idempotent (no-op if already reassigned/expired).
    await deps.store.releaseLease(id).catch(() => {});

    // Map run outcome → task column. Dev-lane (landed) pushes straight to dev → the
    // card is done. PR flow: open → review; merge (webhook) → done.
    const taskStatus =
      status === "succeeded"
        ? landed
          ? "done"
          : "review"
        : status === "failed"
          ? "failed"
          : "cancelled";
    const resolvedPrNumber = prNumber ?? (prUrl ? prNumberFromUrl(prUrl) : null);
    const task = await deps.store.transitionTask(run.taskId, taskStatus, {
      actor: "forge",
      reason:
        status === "succeeded"
          ? landed
            ? "pushed to dev"
            : "PR opened"
          : status === "failed"
            ? error
              ? firstLine(error)
              : "forge failed"
            : "run cancelled",
      extra: {
        ...(prUrl ? { prUrl } : {}),
        ...(resolvedPrNumber ? { prNumber: resolvedPrNumber } : {}),
      },
    });

    // Plan bookkeeping. A failed card would otherwise stall its dependents in
    // `queued` forever (the DAG never sees it reach review/done), so surface the
    // stall by failing the plan. A succeeded card advances the plan once all its
    // siblings have landed (every card in review/done) → the feature PR is ready.
    if (task.planId) {
      if (status === "failed") {
        await deps.store
          .updatePlan(task.planId, { status: "failed" })
          .catch(() => {});
      } else {
        await deps.store.maybeAdvancePlan(task.planId).catch(() => {});
      }
    }

    return c.json(run);
  });

  return r;
}

function firstLine(s: string): string {
  return (
    s
      .split("\n")
      .map((x) => x.trim())
      .find(Boolean) ?? s.trim()
  );
}

function prNumberFromUrl(url: string): number | null {
  const m = url.match(/\/pull\/(\d+)/);
  return m ? Number(m[1]) : null;
}
