import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import { z } from "zod";
import { actorFrom, canSeeProject } from "../actor.js";
import type { AppDeps } from "../app.js";
import { redactEnv, redactPreviewEnv, secretEquals } from "../secrets.js";

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

    return c.json(redactPreviewEnv(preview), created ? 201 : 200);
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
      const rows = await deps.store.listPreviews({ projectId });
      return c.json(rows.map(redactPreviewEnv));
    }
    if (isRunnerCall(c, deps) || canSeeProject(actorFrom(c), null)) {
      const rows = await deps.store.listPreviews({});
      return c.json(rows.map(redactPreviewEnv));
    }
    // Client: union of previews for their org projects.
    const actor = actorFrom(c);
    const projects = await deps.store.listProjects({ isStaff: false, orgIds: actor.orgIds });
    const out = [];
    for (const proj of projects) {
      out.push(...(await deps.store.listPreviews({ projectId: proj.id })));
    }
    return c.json(out.map(redactPreviewEnv));
  });

  /** GET /previews/by-subdomain/:sub — used by the web preview-gate (ADR 0064). */
  r.get("/by-subdomain/:sub", async (c) => {
    const preview = await deps.store.getPreviewBySubdomain(c.req.param("sub"));
    if (!(await previewVisible(deps, c, preview))) {
      return c.json({ error: "not found" }, 404);
    }
    const project = await deps.store.getProject(preview!.projectId);
    return c.json({ preview: redactPreviewEnv(preview!), project });
  });

  /** GET /previews/:id — fetch a single preview by id. */
  r.get("/:id", async (c) => {
    const preview = await deps.store.getPreview(c.req.param("id"));
    if (!(await previewVisible(deps, c, preview))) {
      return c.json({ error: "not found" }, 404);
    }
    return c.json(redactPreviewEnv(preview!));
  });

  /** GET /previews/:id/bootstrap — everything the supervisor needs to boot this
   *  preview, in one authenticated read: the project (repo id, base branch,
   *  runtime) and the repository (clone url, installation).
   *
   *  WHY THIS EXISTS. The supervisor used to read `GET /projects/:id` +
   *  `GET /repositories/:id` directly with the runner secret. Commit 1a66b69
   *  ("require bearer on GETs") closed the open control-plane reads — correctly —
   *  and those two calls started 401'ing, which froze the preview lane fleet-wide:
   *  boot dies on the first read, so every preview lands in `failed` and none ever
   *  goes live.
   *
   *  The fix is NOT to exempt `/projects` and `/repositories` from the api-secret
   *  guard. That guard is prefix-based, so exempting a prefix opens every route
   *  under it — including mutations, and including routes added later, which would
   *  ship unauthenticated by default. Fail-open is the wrong default at an auth
   *  boundary.
   *
   *  So: one narrow, read-only endpoint under `/previews`, which already
   *  self-authenticates (requireRunnerOrApiSecret above). No existing route
   *  changes who may call it, the runner gets exactly the two objects it needs,
   *  and it stays scoped to a preview the caller can already see. */
  r.get("/:id/bootstrap", async (c) => {
    const preview = await deps.store.getPreview(c.req.param("id"));
    if (!(await previewVisible(deps, c, preview))) {
      return c.json({ error: "not found" }, 404);
    }
    const project = await deps.store.getProject(preview!.projectId);
    if (!project) return c.json({ error: "project not found" }, 404);
    const repository = await deps.store.getRepository(project.repositoryId);
    if (!repository) return c.json({ error: "repository not found" }, 404);
    return c.json({ project, repository });
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
    return c.json(redactPreviewEnv(preview));
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
      ...(loadedEnv !== undefined ? { loadedEnv: loadedEnv ? redactEnv(loadedEnv) : null } : {}),
      ...(rssMb !== undefined ? { rssMb } : {}),
    };

    try {
      const updated = await deps.store.patchPreview(c.req.param("id"), patch);
      return c.json(redactPreviewEnv(updated));
    } catch (err) {
      if (err instanceof Error && err.message.includes("not found")) {
        return c.json({ error: "not found" }, 404);
      }
      throw err;
    }
  });

  // As rotas /heal e /runtime-error morreram com o Sindri (ADR 0100): as duas
  // existiam para jogar um erro de preview na sessão de chat mais recente do
  // projeto e pedir conserto. Quem conserta agora é o agente que já está na
  // bancada, olhando o mesmo dev server que quebrou.

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
