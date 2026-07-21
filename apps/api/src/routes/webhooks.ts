import { createHmac, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import type { AppDeps } from "../app.js";
import { applyMergedPr } from "../apply-merged-pr.js";

/**
 * GitHub webhooks (ARCHITECTURE.md §10). Closes the loop:
 *  - pull_request `closed` + merged → plan `done` (shared PR) or task `done`
 *  - pull_request_review_comment → optional follow-up run (P3)
 *
 * BROKK-45: matching prefers the forge stamp in the PR body, then URL / repo-scoped
 * pr_number — so a re-forge (#5→#6) still closes the card when #6 merges. Missed
 * deliveries are healed by the review reconciler (poll + boot backfill).
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
      if (pr?.html_url && pr.number) {
        const repoFullName = payload.repository?.full_name ?? null;
        const result = await applyMergedPr(
          deps.store,
          {
            html_url: pr.html_url,
            number: pr.number,
            merged: pr.merged,
            body: pr.body,
          },
          { repoFullName, actor: "github" },
        );
        console.log(
          `[webhook] pull_request closed #${pr.number}` +
            (repoFullName ? ` ${repoFullName}` : "") +
            ` merged=${Boolean(pr.merged)} → ${result.kind}:${result.status}` +
            (result.id ? ` ${result.id.slice(0, 8)}` : ""),
        );
        if (result.kind === "plan") {
          return c.json({ ok: true, event, planId: result.id, status: result.status });
        }
        if (result.kind === "task") {
          return c.json({ ok: true, event, taskId: result.id, status: result.status });
        }
        return c.json({
          ok: true,
          event,
          taskId: null,
          status: pr.merged ? result.status : "closed_unmerged",
        });
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
  repository?: { full_name?: string };
  pull_request?: {
    merged?: boolean;
    html_url?: string;
    number?: number;
    body?: string | null;
  };
};
