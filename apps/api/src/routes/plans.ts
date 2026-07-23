/**
 * Plans / Stories (ADR 0069): list + open the single Story PR + trigger Eitri.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Hono } from "hono";
import { z } from "zod";
import type { AppDeps } from "../app.js";
import { canSeeProject, requestActor } from "../actor.js";

const run = promisify(execFile);
const GH_BIN = process.env.BROKK_GH_BIN ?? "gh";
const GH_OPTS = { maxBuffer: 8 * 1024 * 1024, timeout: 60_000, killSignal: "SIGKILL" as const };

const OpenPrBody = z.object({
  /** Open PR even if Targeted re-QA did not pass. */
  override: z.boolean().optional().default(false),
  /** Skip POST /eitri/review after open. */
  skipEitri: z.boolean().optional().default(false),
});

const PatchPlanBody = z.object({
  /** Reset a failed Story so forge can claim cards again. */
  status: z.enum(["planning", "forging", "review", "done", "failed"]).optional(),
  validationStatus: z.enum(["pending", "running", "pass", "fail"]).nullable().optional(),
  validationRunId: z.string().uuid().nullable().optional(),
});

const RetryBody = z.object({
  /** Also requeue cards in failed (default true). */
  enqueueFailed: z.boolean().optional().default(true),
});

export function plansRoutes(deps: AppDeps): Hono {
  const r = new Hono();

  r.get("/", async (c) => {
    const projectId = c.req.query("projectId");
    const actor = requestActor(c, deps.runnerSecret);
    if (projectId) {
      const project = await deps.store.getProject(projectId);
      if (!project || !canSeeProject(actor, project.logtoOrgId)) {
        return c.json({ error: "not found" }, 404);
      }
    }
    const plans = await deps.store.listPlans(projectId ? { projectId } : undefined);
    // Soft filter: when listing fleet-wide, only return plans the actor can see.
    if (!projectId && actor.email) {
      const projects = await deps.store.listProjects();
      const ok = new Set(
        projects.filter((p) => canSeeProject(actor, p.logtoOrgId)).map((p) => p.id),
      );
      return c.json({ plans: plans.filter((p) => ok.has(p.projectId)) });
    }
    return c.json({ plans });
  });

  r.get("/:id", async (c) => {
    const plan = await deps.store.getPlan(c.req.param("id"));
    if (!plan) return c.json({ error: "not found" }, 404);
    const project = await deps.store.getProject(plan.projectId);
    const actor = requestActor(c, deps.runnerSecret);
    if (!project || !canSeeProject(actor, project.logtoOrgId)) {
      return c.json({ error: "not found" }, 404);
    }
    const tasks = await deps.store.getPlanTasks(plan.id);
    return c.json({ plan, tasks });
  });

  /** Story observability: milestones from plan + tasks + runs + reviews (no new tables). */
  r.get("/:id/timeline", async (c) => {
    const plan = await deps.store.getPlan(c.req.param("id"));
    if (!plan) return c.json({ error: "not found" }, 404);
    const project = await deps.store.getProject(plan.projectId);
    const actor = requestActor(c, deps.runnerSecret);
    if (!project || !canSeeProject(actor, project.logtoOrgId)) {
      return c.json({ error: "not found" }, 404);
    }
    const tasks = await deps.store.getPlanTasks(plan.id);
    const taskRows = await Promise.all(
      tasks.map(async (task) => {
        const [events, runs] = await Promise.all([
          deps.store.listTaskEvents(task.id),
          deps.store.listRunsByTask(task.id),
        ]);
        return { task, events, runs };
      }),
    );
    const validation = plan.validationRunId
      ? await deps.store.getQaRun(plan.validationRunId).catch(() => null)
      : null;
    const repo = await deps.store.getRepository(project.repositoryId).catch(() => null);
    const reviews =
      repo && plan.prNumber != null
        ? (await deps.store.listReviews(repo.fullName)).filter((x) => x.prNumber === plan.prNumber)
        : [];

    type Milestone = { at: string; kind: string; ref?: string; detail?: string };
    const milestones: Milestone[] = [];
    milestones.push({
      at: plan.createdAt,
      kind: "story_created",
      detail: plan.storyModule ? `module=${plan.storyModule}` : undefined,
    });
    for (const row of taskRows) {
      for (const ev of row.events) {
        milestones.push({
          at: ev.at,
          kind: ev.type === "status" ? `task_${ev.to ?? "status"}` : `task_${ev.type}`,
          ref: row.task.id,
          detail: (row.task.title || "").slice(0, 120),
        });
      }
      for (const runRow of row.runs) {
        milestones.push({
          at: runRow.startedAt ?? runRow.createdAt,
          kind: `forge_${runRow.status}`,
          ref: runRow.id,
          detail: (runRow.error || "").slice(0, 200) || undefined,
        });
      }
    }
    if (plan.validationStatus) {
      milestones.push({
        at: plan.updatedAt,
        kind: `reqa_${plan.validationStatus}`,
        ref: plan.validationRunId ?? undefined,
      });
    }
    if (plan.prUrl) {
      milestones.push({
        at: plan.updatedAt,
        kind: "pr_opened",
        ref: plan.prUrl,
        detail: plan.prNumber != null ? `#${plan.prNumber}` : undefined,
      });
    }
    for (const rev of reviews) {
      milestones.push({
        at: rev.createdAt,
        kind: `eitri_${rev.verdict}`,
        ref: String(rev.prNumber),
      });
    }
    if (plan.status === "done") {
      milestones.push({ at: plan.updatedAt, kind: "merged", ref: plan.prUrl ?? undefined });
    }
    milestones.sort((a, b) => a.at.localeCompare(b.at));

    return c.json({ plan, tasks: taskRows, validation, reviews, milestones });
  });

  /** Staff: patch plan fields (reset failed Story → forging). */
  r.patch("/:id", async (c) => {
    const parsed = PatchPlanBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const plan = await deps.store.getPlan(c.req.param("id"));
    if (!plan) return c.json({ error: "not found" }, 404);
    const project = await deps.store.getProject(plan.projectId);
    const actor = requestActor(c, deps.runnerSecret);
    if (!project || !canSeeProject(actor, project.logtoOrgId)) {
      return c.json({ error: "not found" }, 404);
    }
    const patch: Record<string, unknown> = { ...parsed.data };
    if (parsed.data.status === "forging") {
      if (parsed.data.validationStatus === undefined) patch.validationStatus = null;
      if (parsed.data.validationRunId === undefined) patch.validationRunId = null;
    }
    const updated = await deps.store.updatePlan(plan.id, patch as never);
    return c.json(updated);
  });

  /** Reset failed Story to forging and requeue failed cards. */
  r.post("/:id/retry", async (c) => {
    const parsed = RetryBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const plan = await deps.store.getPlan(c.req.param("id"));
    if (!plan) return c.json({ error: "not found" }, 404);
    const project = await deps.store.getProject(plan.projectId);
    const actor = requestActor(c, deps.runnerSecret);
    if (!project || !canSeeProject(actor, project.logtoOrgId)) {
      return c.json({ error: "not found" }, 404);
    }
    if (plan.status === "done" && plan.prUrl) {
      return c.json({ error: "plan already done with PR — nothing to retry" }, 409);
    }
    const updated = await deps.store.updatePlan(plan.id, {
      status: "forging",
      validationStatus: null,
      validationRunId: null,
    });
    const tasks = await deps.store.getPlanTasks(plan.id);
    const enqueued: string[] = [];
    if (parsed.data.enqueueFailed) {
      for (const t of tasks) {
        if (t.status !== "failed" && t.status !== "cancelled") continue;
        await deps.store.transitionTask(t.id, "queued", {
          actor: actor.email || "story-retry",
          reason: "story plan retry",
        });
        enqueued.push(t.id);
      }
    }
    return c.json({ plan: updated, enqueued }, 200);
  });

  /** Open the Story's single PR (featureBranch → base) and optionally call Eitri. */
  r.post("/:id/open-pr", async (c) => {
    const parsed = OpenPrBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const plan = await deps.store.getPlan(c.req.param("id"));
    if (!plan) return c.json({ error: "not found" }, 404);
    const project = await deps.store.getProject(plan.projectId);
    const actor = requestActor(c, deps.runnerSecret);
    if (!project || !canSeeProject(actor, project.logtoOrgId)) {
      return c.json({ error: "not found" }, 404);
    }
    if (plan.prUrl) {
      return c.json({ plan, reused: true, eitri: null });
    }
    if (!plan.storyModule) {
      return c.json({ error: "not a QA Story plan (no storyModule) — forge opens PR on first card" }, 400);
    }
    if (plan.validationStatus !== "pass" && !parsed.data.override) {
      return c.json(
        {
          error: `re-QA not pass (status=${plan.validationStatus ?? "null"}) — pass override=true to open anyway`,
        },
        409,
      );
    }
    if (!deps.githubToken) {
      return c.json({ error: "GITHUB_TOKEN unset on API — cannot open PR" }, 503);
    }

    const repo = await deps.store.getRepository(project.repositoryId);
    if (!repo) return c.json({ error: "repository not found" }, 404);

    const title = plan.summary;
    const body = [
      `## Story QA · \`${plan.storyModule}\``,
      "",
      plan.rationale ?? plan.prompt,
      "",
      plan.validationRunId
        ? `Re-QA: **${plan.validationStatus}** · run \`${plan.validationRunId}\``
        : `Re-QA: **${plan.validationStatus ?? "—"}**`,
      "",
      `planId=\`${plan.id}\``,
      "",
      "— aberto via Brokk Story open-pr (ADR 0069).",
    ].join("\n");

    let prUrl: string;
    let prNumber: number | null;
    try {
      const { stdout } = await run(
        GH_BIN,
        [
          "pr",
          "create",
          "--repo",
          repo.fullName,
          "--head",
          plan.featureBranch,
          "--base",
          plan.baseBranch,
          "--title",
          title,
          "--body",
          body,
        ],
        {
          ...GH_OPTS,
          env: { ...process.env, GH_TOKEN: deps.githubToken, GITHUB_TOKEN: deps.githubToken },
        },
      );
      prUrl = stdout.trim().split("\n").filter(Boolean).pop() ?? "";
      const m = prUrl.match(/\/pull\/(\d+)/);
      prNumber = m ? Number(m[1]) : null;
      if (!prUrl) throw new Error("gh pr create returned empty URL");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ error: `gh pr create failed: ${msg}` }, 502);
    }

    const updated = await deps.store.updatePlan(plan.id, {
      prUrl,
      prNumber,
    });

    let eitri: { ok: boolean; detail?: string } | null = null;
    if (!parsed.data.skipEitri && prNumber != null) {
      eitri = await triggerEitri(deps, repo.fullName, prNumber);
    }

    return c.json({ plan: updated, reused: false, eitri }, 201);
  });

  return r;
}

async function triggerEitri(
  deps: AppDeps,
  repo: string,
  prNumber: number,
): Promise<{ ok: boolean; detail?: string }> {
  const base = (deps.eitriUrl ?? "").replace(/\/$/, "");
  if (!base) {
    return { ok: false, detail: "EITRI_URL unset" };
  }
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (deps.runnerSecret) headers.authorization = `Bearer ${deps.runnerSecret}`;
  try {
    const res = await fetch(`${base}/eitri/review`, {
      method: "POST",
      headers,
      body: JSON.stringify({ repo, prNumber }),
    });
    const text = await res.text().catch(() => "");
    if (!res.ok) return { ok: false, detail: `${res.status} ${text.slice(0, 200)}` };
    return { ok: true, detail: text.slice(0, 200) || undefined };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}
