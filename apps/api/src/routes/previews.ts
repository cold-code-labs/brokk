import { Hono } from "hono";
import { z } from "zod";
import type { AppDeps } from "../app.js";
import { requireRunnerSecret } from "./runner.js";

const CreatePreviewBody = z.object({
  projectId: z.string().uuid(),
  branch: z.string().default("dev"),
});

export function previewsRoutes(deps: AppDeps): Hono {
  const r = new Hono();

  r.use("*", requireRunnerSecret(deps));

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

    // The ".preview." zone already implies a dev environment, so the default/dev
    // branch gets the bare app name → <app>.preview.coldcodelabs.com. Non-default
    // branches keep an "<app>-<branch>" slug so feature-branch previews don't collide.
    // The Hauldr DB is ALWAYS a distinct "<app>-dev" project — never the app's prod
    // Hauldr project — so a preview can never touch production data.
    const app = repo.name;
    const branchSlug = branch.replace(/[^a-z0-9]+/gi, "-").replace(/(^-|-$)/g, "").toLowerCase() || "dev";
    const isDevBranch = branchSlug === "dev" || branch === project.baseBranch;
    const subdomain = isDevBranch ? app : `${app}-${branchSlug}`;
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

  /** PATCH /previews/:id — runner updates status, pid, port, expiresAt.
   *  This is the machine-facing counterpart of DELETE (stop); it lets the
   *  preview supervisor mark a preview 'live' and set the runner-defined TTL. */
  r.patch("/:id", async (c) => {
    const PatchBody = z.object({
      status: z.enum(["starting", "live", "stopped", "failed"]).optional(),
      pid: z.number().int().nullable().optional(),
      port: z.number().int().nullable().optional(),
      expiresAt: z.string().datetime().nullable().optional(),
      lastSeenAt: z.string().datetime().nullable().optional(),
    });
    const parsed = PatchBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

    const { status, pid, port, expiresAt, lastSeenAt } = parsed.data;
    const patch = {
      ...(status !== undefined ? { status } : {}),
      ...(pid !== undefined ? { pid } : {}),
      ...(port !== undefined ? { port } : {}),
      ...(expiresAt !== undefined
        ? { expiresAt: expiresAt ? new Date(expiresAt) : null }
        : {}),
      ...(lastSeenAt !== undefined
        ? { lastSeenAt: lastSeenAt ? new Date(lastSeenAt) : null }
        : {}),
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
