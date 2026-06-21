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

    // Atomically ensure an active preview exists for this (project, branch) pair.
    // ensureActivePreview uses the DB-level partial unique index to prevent
    // duplicate rows even under concurrent requests — no TOCTOU window.
    const token = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    const subdomain = token;
    const url = `https://${subdomain}.preview.brokk.dev`;
    const hauldrProject = `preview-${subdomain}`;

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
