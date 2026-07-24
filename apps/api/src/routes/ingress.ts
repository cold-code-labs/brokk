// ── /ingress — Devin-class facade (ADR 0074 Fase 3) ─────────────────────────
// Stable contract for external services (Svalinn, Huginn, Slack bots, …):
//   POST /ingress/cards  → brief → queued Forge card (+ optional dedupeKey)
// Internally aliases POST /runs/from-brief so callers don't learn two shapes.

import { Hono } from "hono";
import { z } from "zod";
import type { AppDeps } from "../app.js";
import { connectOne } from "./repositories.js";

const IngressCardBody = z
  .object({
    repoFullName: z.string().min(3).optional(),
    projectId: z.string().uuid().optional(),
    brief: z.string().min(1),
    title: z.string().min(1).max(200).optional(),
    defaultBranch: z.string().default("main"),
    baseBranch: z.string().optional(),
    createdBy: z.string().default("ingress"),
    /** Idempotency — caller namespace, e.g. "svalinn:<target>:<rule>". */
    dedupeKey: z.string().min(1).max(200).optional(),
    /** When true, leave card in `backlog` instead of `queued`. */
    proposedOnly: z.boolean().default(false),
  })
  .refine((d) => Boolean(d.repoFullName) || Boolean(d.projectId), {
    message: "repoFullName or projectId is required",
  });

function firstLine(s: string): string {
  return s.split(/\r?\n/).find((l) => l.trim())?.trim() || "Untitled";
}

export function ingressRoutes(deps: AppDeps): Hono {
  const r = new Hono();

  r.get("/", (c) =>
    c.json({
      service: "brokk-ingress",
      endpoints: [
        {
          method: "POST",
          path: "/ingress/cards",
          auth: "Bearer BROKK_API_SECRET",
          body: {
            brief: "string (required)",
            projectId: "uuid XOR repoFullName",
            repoFullName: "owner/repo",
            title: "optional",
            dedupeKey: "optional idempotency",
            createdBy: "optional actor label",
            proposedOnly: "optional bool — backlog instead of queue",
          },
        },
      ],
      aliasOf: "POST /runs/from-brief (queued path)",
    }),
  );

  r.post("/cards", async (c) => {
    const parsed = IngressCardBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const {
      repoFullName,
      projectId,
      brief,
      title,
      defaultBranch,
      baseBranch,
      createdBy,
      dedupeKey,
      proposedOnly,
    } = parsed.data;

    let project: Awaited<ReturnType<typeof deps.store.getProject>> = null;
    if (projectId) {
      project = await deps.store.getProject(projectId);
      if (!project) return c.json({ error: "project not found" }, 404);
    } else {
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
      source: "ingress",
    });

    if (dedupeKey) {
      const existing = await deps.store.findActiveTaskByDedupeKey(project.id, dedupeKey);
      if (existing) return c.json({ ...handle(existing), deduped: true }, 200);
    }

    const task = await deps.store.insertTask({
      projectId: project.id,
      title: (title ?? firstLine(brief)).slice(0, 200),
      body: brief,
      status: proposedOnly ? "backlog" : "queued",
      createdBy,
      ...(baseBranch ? { baseBranch } : {}),
      ...(dedupeKey ? { dedupeKey } : {}),
    });

    return c.json(handle(task), 201);
  });

  return r;
}
