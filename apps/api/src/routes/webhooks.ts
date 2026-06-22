import { createHmac, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import type { AppDeps } from "../app.js";

/**
 * GitHub webhooks (ARCHITECTURE.md §10). Closes the loop:
 *  - pull_request `closed` + merged → plan `done` (shared PR) or task `done`
 *  - pull_request_review_comment → optional follow-up run (P3)
 */
export function webhooksRoutes(deps: AppDeps): Hono {
  const r = new Hono();

  r.post("/github", async (c) => {
    const rawBody = await c.req.text();
    const sig = c.req.header("x-hub-signature-256");
    if (deps.githubWebhookSecret) {
      if (!sig || !verifyGithubSignature(rawBody, sig, deps.githubWebhookSecret)) {
        return c.json({ error: "invalid signature" }, 401);
      }
    }

    const event = c.req.header("x-github-event") ?? "unknown";
    let payload: GithubPayload;
    try {
      payload = JSON.parse(rawBody) as GithubPayload;
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }

    if (event === "pull_request" && payload.action === "closed") {
      const pr = payload.pull_request;
      if (pr?.merged && pr.html_url && pr.number) {
        // A plan's shared feature PR closes the whole plan + all its cards.
        const plan = await deps.store.findPlanForMergedPr(pr.html_url, pr.number);
        if (plan) {
          if (plan.status !== "done") {
            await deps.store.markPlanDone(plan.id, pr.html_url, pr.number);
          }
          return c.json({ ok: true, event, planId: plan.id, status: "done" });
        }
        const task = await deps.store.findTaskForMergedPr(pr.html_url, pr.number);
        if (task && task.status !== "done") {
          await deps.store.updateTask(task.id, {
            status: "done",
            prUrl: pr.html_url,
            prNumber: pr.number,
          });
          return c.json({ ok: true, event, taskId: task.id, status: "done" });
        }
        return c.json({ ok: true, event, taskId: task?.id ?? null, status: task?.status ?? "not_found" });
      }
    }

    return c.json({ ok: true, received: event });
  });

  return r;
}

function verifyGithubSignature(body: string, header: string, secret: string): boolean {
  const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  if (expected.length !== header.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(header));
  } catch {
    return false;
  }
}

type GithubPayload = {
  action?: string;
  pull_request?: {
    merged?: boolean;
    html_url?: string;
    number?: number;
  };
};
