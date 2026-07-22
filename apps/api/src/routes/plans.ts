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
