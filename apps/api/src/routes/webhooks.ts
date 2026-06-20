import { Hono } from "hono";
import type { AppDeps } from "../app.js";

/**
 * GitHub webhooks (ARCHITECTURE.md §10). Closes the loop:
 *  - pull_request `closed` + merged → task `done`
 *  - pull_request_review_comment → optional follow-up run (P3)
 *
 * STUB for P0: parses the event and acknowledges. Signature verification
 * (X-Hub-Signature-256) and the merge→done / comment→follow-up wiring land in P3.
 */
export function webhooksRoutes(_deps: AppDeps): Hono {
  const r = new Hono();

  r.post("/github", async (c) => {
    const event = c.req.header("x-github-event") ?? "unknown";
    // TODO(P3): verify X-Hub-Signature-256 against the webhook secret.
    // TODO(P3): on merged PR → find task by pr_url → updateTask(status:"done").
    // TODO(P3): on review comment → enqueue a follow-up run.
    await c.req.json().catch(() => ({}));
    return c.json({ ok: true, received: event });
  });

  return r;
}
