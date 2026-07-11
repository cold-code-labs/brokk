import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { z } from "zod";
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
    const repo = await deps.store.getRepository(project.repositoryId);
    if (!repo) return c.json({ error: "repository not found" }, 404);

    // ADR 0017: the dev-lane HMR singleton lives at <app>-dev.preview.coldcodelabs.com,
    // matching its sibling Coolify dev-build at <app>-dev.coldcodelabs.com (both on the
    // shared <app>_dev Hauldr project). The explicit "-dev" reads as an environment, not
    // a bare app clone. Non-default branches keep an "<app>-<branch>" slug so
    // feature-branch previews don't collide. The Hauldr DB is ALWAYS a distinct
    // "<app>-dev" project — never the app's prod Hauldr project — so a preview can
    // never touch production data.
    const app = repo.name;
    const branchSlug = branch.replace(/[^a-z0-9]+/gi, "-").replace(/(^-|-$)/g, "").toLowerCase() || "dev";
    const isDevBranch = branchSlug === "dev" || branch === project.baseBranch;
    const subdomain = isDevBranch ? `${app}-dev` : `${app}-${branchSlug}`;
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
    return c.json(await deps.store.listPreviews({ projectId }));
  });

  /** GET /previews/:id — fetch a single preview by id. */
  r.get("/:id", async (c) => {
    const preview = await deps.store.getPreview(c.req.param("id"));
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
    });
    const parsed = PatchBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

    const { status, detail, commitSha, builtAt, pid, port } = parsed.data;
    const patch = {
      ...(status !== undefined ? { status } : {}),
      ...(detail !== undefined ? { detail } : {}),
      ...(commitSha !== undefined ? { commitSha } : {}),
      ...(builtAt !== undefined ? { builtAt: builtAt ? new Date(builtAt) : null } : {}),
      ...(pid !== undefined ? { pid } : {}),
      ...(port !== undefined ? { port } : {}),
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
