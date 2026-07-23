import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import { actorFrom, canSeeProject, resolveLogtoOrgId } from "../actor.js";
import type { AppDeps } from "../app.js";
import { connectOne } from "./repositories.js";

const run = promisify(execFile);
const GH_BIN = process.env.BROKK_GH_BIN ?? "gh";
const GH_OPTS = { maxBuffer: 8 * 1024 * 1024, timeout: 25_000, killSignal: "SIGKILL" as const };

/** Open (or reuse) the promotion PR dev→main. After the first Publicar births
 *  prod, further promotions go through this PR so Eitri reviews them (a `dev`
 *  head is never auto-merged) and the operator approves. Idempotent. ADR 0038. */
async function ensurePromotionPr(
  repoFullName: string,
): Promise<{ number: number; url: string; created: boolean }> {
  const owner = repoFullName.split("/")[0]!;
  const { stdout: found } = await run(
    GH_BIN,
    ["api", `repos/${repoFullName}/pulls?head=${owner}:dev&base=main&state=open`],
    GH_OPTS,
  );
  const open = JSON.parse(found) as Array<{ number: number; html_url: string }>;
  if (open.length > 0) return { number: open[0]!.number, url: open[0]!.html_url, created: false };
  const { stdout: created } = await run(
    GH_BIN,
    [
      "api",
      `repos/${repoFullName}/pulls`,
      "-f",
      "title=Publicar: dev → main",
      "-f",
      "head=dev",
      "-f",
      "base=main",
      "-f",
      "body=Promoção da dev para produção (ADR 0038). O Eitri revisa; aprove para publicar.",
    ],
    GH_OPTS,
  );
  const pr = JSON.parse(created) as { number: number; html_url: string };
  return { number: pr.number, url: pr.html_url, created: true };
}

const NewConversationBody = z.object({
  /** Optional display/friendly name. Absent → chat-first birth (ADR 0070 H5):
   *  technical slug `p-<hex>` sent to Heimdall; UI shows "Novo projeto". */
  name: z.string().min(1).max(64).optional(),
  /** template tier — "client" (light) or "internal". Defaults to client. */
  template: z.enum(["client", "internal"]).optional(),
});

const ClaimBody = z.object({
  /** Friendly prod slug (DNS). Technical slug / repo stay immutable. */
  slug: z.string().min(2).max(48),
});

/** Heimdall's AppRecord (the fields Nova Conversa needs). */
interface HeimdallApp {
  id: string;
  name: string;
  slug: string;
  repoFullName: string | null;
  dataProjectRef: string | null;
  laneStage: string;
  status: string;
}

/** Call Heimdall's SCOPED Agent API (`/api/agent/*` on its web app, NOT the
 *  control plane). Returns { ok, status, body }. A 403 here means the app wasn't
 *  created by this agent — Heimdall refuses lifecycle verbs outside that scope. */
async function heimdall(
  deps: AppDeps,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ ok: boolean; status: number; body: any }> {
  const res = await fetch(`${deps.heimdallUrl!.replace(/\/$/, "")}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${deps.heimdallToken}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    // Publish can wait on cold prod-Hauldr provisioning (up to ~300s in Heimdall)
    // before it even creates the Coolify app — give the proxy a wider ceiling.
    signal: AbortSignal.timeout(330_000),
  });
  const payload = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body: payload };
}

/**
 * Nova Conversa (ADR 0038 — the v0 face). Type a name → Heimdall provisions ONLY
 * the dev side (repo from the template + `<slug>_dev` Hauldr + `dev` branch, no
 * prod app), Brokk registers the project (dev-first, forges on `dev`), stands up
 * the dev preview singleton, and opens a Sindri session. Prod is born later on
 * the first Publish.
 *
 * This is the command half of the old Ice Breaker, moved out of Heimdall into
 * Brokk — Heimdall stays the provisioning engine, consumed over its API.
 */
export function conversationsRoutes(deps: AppDeps): Hono {
  const r = new Hono();

  r.post("/", async (c) => {
    if (!deps.heimdallUrl || !deps.heimdallToken) {
      return c.json({ error: "provisioning disabled (no HEIMDALL_AGENT_URL/TOKEN)" }, 503);
    }
    const actor = actorFrom(c);
    const parsed = NewConversationBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const { template } = parsed.data;
    const org = resolveLogtoOrgId(actor, null);
    if (!org.ok) return c.json({ error: org.error }, org.status);

    // ADR 0070 H5: named birth keeps slugify(name); chat-first uses provisional p-<hex>.
    const typed = parsed.data.name?.trim() ?? "";
    const provisional = !typed;
    const heimdallName = typed || `p-${randomBytes(5).toString("hex")}`;
    const displayName = typed || "Novo projeto";

    // 1. Heimdall births the dev side (repo + <slug>_dev Hauldr + dev branch).
    let app: HeimdallApp;
    try {
      const res = await fetch(`${deps.heimdallUrl.replace(/\/$/, "")}/api/agent/apps`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${deps.heimdallToken}`,
        },
        body: JSON.stringify({
          name: heimdallName,
          template: template ?? "client",
          ...(org.logtoOrgId ? { organizationId: org.logtoOrgId } : {}),
        }),
        signal: AbortSignal.timeout(120_000),
      });
      const payload = (await res.json().catch(() => ({}))) as HeimdallApp & { error?: unknown };
      if (!res.ok) {
        // Surface Heimdall's status (409 = subdomain taken, etc.) to the caller.
        const message = typeof payload?.error === "string" ? payload.error : JSON.stringify(payload?.error ?? payload);
        return c.json({ error: `heimdall: ${message}` }, res.status === 409 ? 409 : 502);
      }
      app = payload;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: `heimdall unreachable: ${message}` }, 502);
    }
    if (!app.repoFullName) {
      return c.json({ error: "heimdall returned no repo for the app" }, 502);
    }

    // 2. Register the repo + project in Brokk (dev-first → forges on `dev`),
    //    remembering the Heimdall app id so Publish/rollback can reach it.
    const { repo, project } = await connectOne(
      deps,
      { fullName: app.repoFullName, defaultBranch: "main" },
      true,
      {
        devFirst: true,
        baseBranch: "dev",
        heimdallAppId: app.id,
        logtoOrgId: org.logtoOrgId,
      },
    );
    if (!project) return c.json({ error: "failed to create Brokk project" }, 502);

    // 3. Stand up the dev preview singleton. Dev-first drops the "-dev" suffix:
    //    <slug>.preview.coldcodelabs.com against the <slug>_dev Hauldr project.
    const subdomain = repo.name;
    const hauldrProject = `${repo.name}_dev`.toLowerCase().replace(/[^a-z0-9_]/g, "_");
    const { preview } = await deps.store.ensureActivePreview({
      projectId: project.id,
      branch: "dev",
      subdomain,
      url: `https://${subdomain}.preview.coldcodelabs.com`,
      hauldrProject,
      status: "starting",
    });

    // 4. Open a Sindri session so the conversation is ready to enter.
    const session = await deps.store.insertChatSession({
      projectId: project.id,
      title: displayName,
      model: project.model,
      engine: "claude-api",
    });
    const withBranch = await deps.store.updateChatSession(session.id, {
      branch: `sindri/${session.id.slice(0, 8)}`,
    });

    return c.json(
      {
        app,
        repository: repo,
        project,
        preview,
        session: withBranch ?? session,
        provisional,
        displayName,
      },
      201,
    );
  });

  /** ADR 0070 / H6 — claim friendly prod slug (Heimdall). Technical slug untouched. */
  r.post("/:projectId/claim", async (c) => {
    const resolved = await resolveApp(c);
    if (resolved instanceof Response) return resolved;
    const parsed = ClaimBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const out = await heimdall(deps, "POST", `/api/agent/apps/${resolved.appId}/claim`, {
      slug: parsed.data.slug,
    });
    if (!out.ok) {
      const message =
        typeof out.body?.error === "string" ? out.body.error : JSON.stringify(out.body?.error ?? out.body);
      return c.json({ error: `heimdall: ${message}` }, out.status === 409 ? 409 : 502);
    }
    return c.json({ ok: true, app: out.body, claimedSlug: out.body?.friendlySlug ?? parsed.data.slug });
  });

  /** Resolve a Brokk project to its Heimdall app id (or a JSON error response). */
  async function resolveApp(
    c: Context,
  ): Promise<{ appId: string; projectId: string; repoFullName: string } | Response> {
    if (!deps.heimdallUrl || !deps.heimdallToken) {
      return c.json({ error: "provisioning disabled (no HEIMDALL_AGENT_URL/TOKEN)" }, 503);
    }
    const projectId = c.req.param("projectId");
    if (!projectId) return c.json({ error: "projectId required" }, 400);
    const actor = actorFrom(c);
    const project = await deps.store.getProject(projectId);
    if (!project || !canSeeProject(actor, project.logtoOrgId)) {
      return c.json({ error: "project not found" }, 404);
    }
    if (!project.heimdallAppId) {
      return c.json({ error: "project has no Heimdall app (not born via Nova Conversa)" }, 400);
    }
    const repo = await deps.store.getRepository(project.repositoryId);
    if (!repo) return c.json({ error: "repository not found" }, 404);
    return { appId: project.heimdallAppId, projectId, repoFullName: repo.fullName };
  }

  // B4 — Publicar (só a 1ª vez): merge dev→main + dá à luz o prod. Marca published
  // → o próximo gesto vira "Create PR" (promoção revisada pelo Eitri).
  r.post("/:projectId/publish", async (c) => {
    const resolved = await resolveApp(c);
    if (resolved instanceof Response) return resolved;
    const out = await heimdall(deps, "POST", `/api/agent/apps/${resolved.appId}/publish`);
    if (!out.ok) return c.json({ error: `heimdall: ${JSON.stringify(out.body?.error ?? out.body)}` }, 502);
    if (out.body?.laneStage && out.body.laneStage !== "dev") {
      await deps.store.setProjectPublished(resolved.projectId, true).catch(() => {});
    }
    return c.json(out.body);
  });

  // B4' — Create PR: após o 1º Publicar, promoções viram um PR dev→main que o
  // Eitri revisa (head=dev nunca é auto-mergeado) e o operador aprova. Idempotente.
  r.post("/:projectId/pr", async (c) => {
    const resolved = await resolveApp(c);
    if (resolved instanceof Response) return resolved;
    try {
      const pr = await ensurePromotionPr(resolved.repoFullName);
      return c.json(pr, pr.created ? 201 : 200);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
    }
  });

  // B5 — Versões publicadas (commits da main, mais recente primeiro).
  r.get("/:projectId/versions", async (c) => {
    const resolved = await resolveApp(c);
    if (resolved instanceof Response) return resolved;
    const out = await heimdall(deps, "GET", `/api/agent/apps/${resolved.appId}/versions`);
    if (!out.ok) return c.json({ error: `heimdall: ${JSON.stringify(out.body?.error ?? out.body)}` }, 502);
    return c.json(out.body);
  });

  // B5 — Rollback: volta o prod pra uma versão publicada (forward-only). dev intacta.
  r.post("/:projectId/rollback", async (c) => {
    const resolved = await resolveApp(c);
    if (resolved instanceof Response) return resolved;
    const body = await c.req.json().catch(() => ({}));
    const sha = typeof body?.sha === "string" ? body.sha : "";
    if (!sha) return c.json({ error: "sha is required" }, 400);
    const out = await heimdall(deps, "POST", `/api/agent/apps/${resolved.appId}/rollback`, { sha });
    if (!out.ok) return c.json({ error: `heimdall: ${JSON.stringify(out.body?.error ?? out.body)}` }, 502);
    return c.json(out.body);
  });

  return r;
}
