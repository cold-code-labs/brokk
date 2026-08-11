import { Hono } from "hono";
import { requestActor, listScope } from "../actor.js";
import type { AppDeps } from "../app.js";
import { isProductHeimdallApp } from "../fleet-product.js";
import { connectOne } from "./repositories.js";

type HeimdallListApp = {
  id: string;
  name: string;
  slug: string;
  status: string;
  lifecycle: string;
  laneStage: string;
  repoFullName: string | null;
};

/** Sync Brokk projects from Heimdall Agent registry (product apps only). */
export function fleetRoutes(deps: AppDeps): Hono {
  const r = new Hono();

  r.post("/sync", async (c) => {
    const actor = requestActor(c, deps.runnerSecret);
    if (!deps.heimdallUrl || !deps.heimdallToken) {
      return c.json({ error: "provisioning disabled (no HEIMDALL_AGENT_URL/TOKEN)" }, 503);
    }

    const res = await fetch(`${deps.heimdallUrl.replace(/\/$/, "")}/api/agent/apps`, {
      method: "GET",
      headers: { authorization: `Bearer ${deps.heimdallToken}` },
      signal: AbortSignal.timeout(60_000),
    });
    const payload = (await res.json().catch(() => ({}))) as {
      apps?: HeimdallListApp[];
      error?: string;
    };
    if (!res.ok) {
      return c.json(
        { error: payload.error ?? `heimdall list apps → ${res.status}` },
        502,
      );
    }

    const apps = (payload.apps ?? []).filter(isProductHeimdallApp);
    const existing = await deps.store.listProjects(listScope(actor));
    const byHeimdall = new Map(
      existing.filter((p) => p.heimdallAppId).map((p) => [p.heimdallAppId!, p]),
    );
    const repos = await deps.store.listRepositories();
    const repoByFullName = new Map(repos.map((x) => [x.fullName.toLowerCase(), x]));
    const projectByRepoId = new Map(
      existing.filter((p) => p.repositoryId).map((p) => [p.repositoryId!, p]),
    );

    let created = 0;
    let linked = 0;
    let skipped = 0;
    const errors: { slug: string; error: string }[] = [];

    for (const app of apps) {
      const fullName = app.repoFullName!.trim();
      try {
        if (byHeimdall.has(app.id)) {
          skipped += 1;
          continue;
        }
        const repo = repoByFullName.get(fullName.toLowerCase());
        const existingProj = repo ? (projectByRepoId.get(repo.id) ?? null) : null;
        if (existingProj) {
          if (!existingProj.heimdallAppId) {
            await deps.store.setProjectHeimdallAppId(existingProj.id, app.id);
            linked += 1;
          } else {
            skipped += 1;
          }
          continue;
        }

        const devFirst = app.laneStage === "dev";
        const result = await connectOne(
          deps,
          { fullName, defaultBranch: "main" },
          true,
          {
            heimdallAppId: app.id,
            devFirst,
            baseBranch: devFirst ? "dev" : undefined,
          },
        );
        if (result.project) {
          created += 1;
          if (result.project.heimdallAppId) {
            byHeimdall.set(result.project.heimdallAppId, result.project);
          }
          if (result.repo) {
            repoByFullName.set(result.repo.fullName.toLowerCase(), result.repo);
            projectByRepoId.set(result.repo.id, result.project);
          }
        } else {
          skipped += 1;
        }
      } catch (e) {
        errors.push({
          slug: app.slug,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    return c.json({
      ok: true,
      scanned: apps.length,
      created,
      linked,
      skipped,
      errors,
    });
  });

  return r;
}
