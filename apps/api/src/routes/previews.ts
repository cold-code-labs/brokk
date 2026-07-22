import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import { z } from "zod";
import { actorFrom, canSeeProject } from "../actor.js";
import type { AppDeps } from "../app.js";
import { secretEquals } from "../secrets.js";

const CreatePreviewBody = z.object({
  projectId: z.string().uuid(),
  branch: z.string().default("dev"),
});

/** Previews are managed by TWO identities: the forge runner (supervisor loop,
 *  BROKK_RUNNER_SECRET) and the human UI (the web proxy injects BROKK_API_SECRET,
 *  itself gated by a Logto session). Runner-only here 401'd every "Subir preview"
 *  click in Sindri/Fleet — accept either. Other runner routes (/register etc.)
 *  stay runner-only. */
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


/** Runner identity (forge supervisor) bypasses org filters — it must see every
 *  preview slot. Human callers (BFF + API secret) are scoped via actor headers. */
function isRunnerCall(c: Context, deps: AppDeps): boolean {
  const token = (c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, "");
  return Boolean(deps.runnerSecret && secretEquals(token, deps.runnerSecret));
}

async function previewVisible(
  deps: AppDeps,
  c: Context,
  preview: { projectId: string } | null,
): Promise<boolean> {
  if (!preview) return false;
  if (isRunnerCall(c, deps)) return true;
  const actor = actorFrom(c);
  const project = await deps.store.getProject(preview.projectId);
  return Boolean(project && canSeeProject(actor, project.logtoOrgId));
}

export function previewsRoutes(deps: AppDeps): Hono {
  const r = new Hono();

  r.use("*", requireRunnerOrApiSecret(deps));

  /** POST /previews — ensure+start: return an existing starting/live preview for
   *  the project+branch, or insert a fresh row with status 'starting' and signal
   *  the runner to provision it. */
  r.post("/", async (c) => {
    const parsed = CreatePreviewBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

    const { projectId, branch } = parsed.data;

    const project = await deps.store.getProject(projectId);
    if (!project) return c.json({ error: "project not found" }, 404);
    if (!isRunnerCall(c, deps)) {
      const actor = actorFrom(c);
      if (!canSeeProject(actor, project.logtoOrgId)) {
        return c.json({ error: "project not found" }, 404);
      }
    }
    const repo = await deps.store.getRepository(project.repositoryId);
    if (!repo) return c.json({ error: "repository not found" }, 404);

    // The dev-lane HMR singleton's preview host. ADR 0038 (v0 face) drops the
    // "-dev" suffix for dev-first apps — the ".preview" already implies dev, so
    // <app>.preview.coldcodelabs.com is the dev URL and <app>.coldcodelabs.com is
    // prod (born on Publish). Forward-only: legacy apps (devFirst=false) keep the
    // ADR-0017 "<app>-dev.preview" host so live previews don't change URL.
    // Non-default branches always keep an "<app>-<branch>" slug so feature-branch
    // previews don't collide. The Hauldr DB is ALWAYS a distinct "<app>_dev"
    // project — never the app's prod Hauldr project — so a preview can never touch
    // production data.
    const app = repo.name;
    const branchSlug = branch.replace(/[^a-z0-9]+/gi, "-").replace(/(^-|-$)/g, "").toLowerCase() || "dev";
    const isDevBranch = branchSlug === "dev" || branch === project.baseBranch;
    const subdomain = isDevBranch
      ? project.devFirst
        ? app
        : `${app}-dev`
      : `${app}-${branchSlug}`;
    const url = `https://${subdomain}.preview.coldcodelabs.com`;
    // Hauldr project names allow only [a-z0-9_] and must start with a letter, so
    // sanitize hyphens → underscores (the DNS subdomain keeps its hyphens).
    const hauldrProject = (isDevBranch ? `${app}_dev` : `${app}_${branchSlug}`)
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, "_");

    const { preview, created } = await deps.store.ensureActivePreview({
      projectId,
      branch,
      subdomain,
      url,
      hauldrProject,
      status: "starting",
    });

    return c.json(preview, created ? 201 : 200);
  });

  /** GET /previews?projectId= — list all previews, optionally filtered by project. */
  r.get("/", async (c) => {
    const projectId = c.req.query("projectId") ?? undefined;
    if (projectId) {
      const project = await deps.store.getProject(projectId);
      if (!project) return c.json({ error: "not found" }, 404);
      if (!isRunnerCall(c, deps) && !canSeeProject(actorFrom(c), project.logtoOrgId)) {
        return c.json({ error: "not found" }, 404);
      }
      return c.json(await deps.store.listPreviews({ projectId }));
    }
    if (isRunnerCall(c, deps) || canSeeProject(actorFrom(c), null)) {
      return c.json(await deps.store.listPreviews({}));
    }
    // Client: union of previews for their org projects.
    const actor = actorFrom(c);
    const projects = await deps.store.listProjects({ isStaff: false, orgIds: actor.orgIds });
    const out = [];
    for (const proj of projects) {
      out.push(...(await deps.store.listPreviews({ projectId: proj.id })));
    }
    return c.json(out);
  });

  /** GET /previews/by-subdomain/:sub — used by the web preview-gate (ADR 0064). */
  r.get("/by-subdomain/:sub", async (c) => {
    const preview = await deps.store.getPreviewBySubdomain(c.req.param("sub"));
    if (!(await previewVisible(deps, c, preview))) {
      return c.json({ error: "not found" }, 404);
    }
    const project = await deps.store.getProject(preview!.projectId);
    return c.json({ preview, project });
  });

  /** GET /previews/:id — fetch a single preview by id. */
  r.get("/:id", async (c) => {
    const preview = await deps.store.getPreview(c.req.param("id"));
    if (!(await previewVisible(deps, c, preview))) {
      return c.json({ error: "not found" }, 404);
    }
    return c.json(preview);
  });

  /** POST /previews/:id/ping — the idle-reaper heartbeat. The Brokk screen calls
   *  this on interaction while a preview is up; the supervisor rests it only after
   *  PREVIEW_IDLE_TTL_MS with no ping (and no respin). Cheap + idempotent. */
  r.post("/:id/ping", async (c) => {
    const existing = await deps.store.getPreview(c.req.param("id"));
    if (!(await previewVisible(deps, c, existing))) {
      return c.json({ error: "not found" }, 404);
    }
    const preview = await deps.store.touchPreview(c.req.param("id"));
    if (!preview) return c.json({ error: "not found" }, 404);
    return c.json(preview);
  });

  /** PATCH /previews/:id — runner updates status, pid, port.
   *  This is the machine-facing counterpart of DELETE (stop); it lets the
   *  preview supervisor mark a preview 'live'. */
  r.patch("/:id", async (c) => {
    const PatchBody = z.object({
      status: z.enum(["starting", "live", "stopped", "failed", "unsupported"]).optional(),
      detail: z.string().nullable().optional(),
      commitSha: z.string().nullable().optional(),
      builtAt: z.string().datetime().nullable().optional(),
      pid: z.number().int().nullable().optional(),
      port: z.number().int().nullable().optional(),
      loadedEnv: z.record(z.string()).nullable().optional(),
      rssMb: z.number().int().nonnegative().nullable().optional(),
    });
    const parsed = PatchBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

    const { status, detail, commitSha, builtAt, pid, port, loadedEnv, rssMb } = parsed.data;
    const patch = {
      ...(status !== undefined ? { status } : {}),
      ...(detail !== undefined ? { detail } : {}),
      ...(commitSha !== undefined ? { commitSha } : {}),
      ...(builtAt !== undefined ? { builtAt: builtAt ? new Date(builtAt) : null } : {}),
      ...(pid !== undefined ? { pid } : {}),
      ...(port !== undefined ? { port } : {}),
      ...(loadedEnv !== undefined ? { loadedEnv } : {}),
      ...(rssMb !== undefined ? { rssMb } : {}),
    };

    try {
      const updated = await deps.store.patchPreview(c.req.param("id"), patch);
      return c.json(updated);
    } catch (err) {
      if (err instanceof Error && err.message.includes("not found")) {
        return c.json({ error: "not found" }, 404);
      }
      throw err;
    }
  });

  /** POST /previews/:id/heal — the supervisor detected a bundle that won't
   *  compile even after a clean-cache restart (a real code error). Hand the Metro
   *  error to the app's newest ACTIVE, IDLE Sindri session so the agent fixes it
   *  and republishes. Best-effort + heavily guarded: no session / a running turn /
   *  no Sindri URL → a clean no-op ({healed:false}). The supervisor already
   *  dedupes per broken commit, so this fires at most once per breakage. */
  r.post("/:id/heal", async (c) => {
    const HealBody = z.object({ error: z.string().min(1).max(4000) });
    const parsed = HealBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

    const preview = await deps.store.getPreview(c.req.param("id"));
    if (!preview) return c.json({ error: "not found" }, 404);

    const base = (deps.sindriUrl ?? "").replace(/\/$/, "");
    if (!base) return c.json({ healed: false, reason: "no sindri url" });

    // Newest active session for the app that isn't mid-turn. We fix on a REAL
    // chat so the human sees the diagnosis + fix land in their thread.
    const sessions = await deps.store.listChatSessions({
      projectId: preview.projectId,
      status: "active",
    });
    const target = sessions
      .filter((s) => s.turnState !== "running")
      .sort((a, b) => +new Date(b.updatedAt) - +new Date(a.updatedAt))[0];
    if (!target) return c.json({ healed: false, reason: "no idle active session" });

    const text = [
      `⚠️ O preview \`${preview.subdomain}\` parou de compilar depois do último push — o app está numa tela de erro.`,
      "",
      "Erro do Metro:",
      "```",
      parsed.data.error,
      "```",
      "",
      "Descubra o que quebrou, corrija no código e publique como você normalmente faz para atualizar o preview.",
    ].join("\n");

    // Fire-and-forget: starting the turn is enough; we don't hold the SSE.
    void fetch(`${base}/sessions/${target.id}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(deps.runnerSecret ? { authorization: `Bearer ${deps.runnerSecret}` } : {}),
      },
      body: JSON.stringify({ text }),
    }).catch(() => {});

    return c.json({ healed: true, sessionId: target.id });
  });

  /** POST /previews/runtime-error — a preview app hit a RUNTIME error on the
   *  device (crash/unhandled rejection), which the bundle self-heal can't see (it
   *  only checks that the bundle compiles, not that it runs). The app reports it
   *  here; we hand it to the project's newest active+idle Sindri session to fix +
   *  republish. Same guards as /heal: no session / running turn / no Sindri → no-op.
   *  Reachable by the mobile bearer (mutation) via the web proxy. */
  r.post("/runtime-error", async (c) => {
    const Body = z.object({
      projectId: z.string().uuid(),
      message: z.string().min(1).max(2000),
      stack: z.string().max(6000).optional(),
      componentStack: z.string().max(4000).optional(),
      kind: z.string().max(40).optional(),
    });
    const parsed = Body.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const { projectId, message, stack, componentStack, kind } = parsed.data;

    if (!isRunnerCall(c, deps)) {
      const project = await deps.store.getProject(projectId);
      if (!project || !canSeeProject(actorFrom(c), project.logtoOrgId)) {
        return c.json({ error: "not found" }, 404);
      }
    }

    const base = (deps.sindriUrl ?? "").replace(/\/$/, "");
    if (!base) return c.json({ reported: false, reason: "no sindri url" });

    const sessions = await deps.store.listChatSessions({ projectId, status: "active" });
    const target = sessions
      .filter((s) => s.turnState !== "running")
      .sort((a, b) => +new Date(b.updatedAt) - +new Date(a.updatedAt))[0];
    if (!target) return c.json({ reported: false, reason: "no idle active session" });

    const detail = [stack, componentStack].filter(Boolean).join("\n\n").slice(0, 4000);
    const text = [
      `⚠️ Erro de runtime no app (${kind ?? "runtime"}) — o preview compila mas quebrou na execução, na mão do usuário.`,
      "",
      `Mensagem: ${message}`,
      detail ? "\nStack:\n```\n" + detail + "\n```" : "",
      "",
      "Encontre a causa no código, corrija e publique como você normalmente faz para atualizar o preview.",
    ].join("\n");

    void fetch(`${base}/sessions/${target.id}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(deps.runnerSecret ? { authorization: `Bearer ${deps.runnerSecret}` } : {}),
      },
      body: JSON.stringify({ text }),
    }).catch(() => {});

    return c.json({ reported: true, sessionId: target.id });
  });

  /** DELETE /previews/:id — stop a preview (mark stopped, clear pid). */
  r.delete("/:id", async (c) => {
    const existing = await deps.store.getPreview(c.req.param("id"));
    if (!(await previewVisible(deps, c, existing))) {
      return c.json({ error: "not found" }, 404);
    }
    try {
      const stopped = await deps.store.stopPreview(c.req.param("id"));
      return c.json(stopped);
    } catch (err) {
      if (err instanceof Error && err.message.includes("not found")) {
        return c.json({ error: "not found" }, 404);
      }
      throw err;
    }
  });

  return r;
}
