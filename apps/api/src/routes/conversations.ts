import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import type { AppDeps } from "../app.js";
import { connectOne } from "./repositories.js";

const NewConversationBody = z.object({
  /** the app name the user typed, e.g. "MarkupLab". Heimdall slugifies it into
   *  the repo + subdomain. */
  name: z.string().min(1).max(64),
  /** template tier — "client" (light) or "internal". Defaults to client. */
  template: z.enum(["client", "internal"]).optional(),
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

/** Call the Heimdall control-plane. Returns { ok, status, body }. */
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
    signal: AbortSignal.timeout(180_000),
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
      return c.json({ error: "provisioning disabled (no HEIMDALL_API_URL/TOKEN)" }, 503);
    }
    const parsed = NewConversationBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const { name, template } = parsed.data;

    // 1. Heimdall births the dev side (repo + <slug>_dev Hauldr + dev branch).
    let app: HeimdallApp;
    try {
      const res = await fetch(`${deps.heimdallUrl.replace(/\/$/, "")}/apps`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${deps.heimdallToken}`,
        },
        body: JSON.stringify({ name, template: template ?? "client", mode: "dev" }),
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
      { devFirst: true, baseBranch: "dev", heimdallAppId: app.id },
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
      title: "New chat",
      model: project.model,
      engine: "afl",
    });
    const withBranch = await deps.store.updateChatSession(session.id, {
      branch: `sindri/${session.id.slice(0, 8)}`,
    });

    return c.json(
      { app, repository: repo, project, preview, session: withBranch ?? session },
      201,
    );
  });

  /** Resolve a Brokk project to its Heimdall app id (or a JSON error response). */
  async function resolveApp(c: Context): Promise<{ appId: string } | Response> {
    if (!deps.heimdallUrl || !deps.heimdallToken) {
      return c.json({ error: "provisioning disabled (no HEIMDALL_API_URL/TOKEN)" }, 503);
    }
    const projectId = c.req.param("projectId");
    if (!projectId) return c.json({ error: "projectId required" }, 400);
    const project = await deps.store.getProject(projectId);
    if (!project) return c.json({ error: "project not found" }, 404);
    if (!project.heimdallAppId) {
      return c.json({ error: "project has no Heimdall app (not born via Nova Conversa)" }, 400);
    }
    return { appId: project.heimdallAppId };
  }

  // B4 — Publicar: merge dev→main and, on the first Publish, give birth to prod.
  r.post("/:projectId/publish", async (c) => {
    const resolved = await resolveApp(c);
    if (resolved instanceof Response) return resolved;
    const out = await heimdall(deps, "POST", `/apps/${resolved.appId}/publish`);
    if (!out.ok) return c.json({ error: `heimdall: ${JSON.stringify(out.body?.error ?? out.body)}` }, 502);
    return c.json(out.body);
  });

  // B5 — Versões publicadas (commits da main, mais recente primeiro).
  r.get("/:projectId/versions", async (c) => {
    const resolved = await resolveApp(c);
    if (resolved instanceof Response) return resolved;
    const out = await heimdall(deps, "GET", `/apps/${resolved.appId}/versions`);
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
    const out = await heimdall(deps, "POST", `/apps/${resolved.appId}/rollback`, { sha });
    if (!out.ok) return c.json({ error: `heimdall: ${JSON.stringify(out.body?.error ?? out.body)}` }, 502);
    return c.json(out.body);
  });

  return r;
}
