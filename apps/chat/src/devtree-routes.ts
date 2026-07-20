// Dev-tree status + explicit commit for the preview / live worktree.
// The agent no longer auto-pushes; the operator lands dirty edits via Commit.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Store } from "@brokk/db";
import { Hono } from "hono";
import { z } from "zod";
import type { CheckoutManager } from "./checkout.js";

const exec = promisify(execFile);

const RUNNER_WORKDIR = process.env.BROKK_RUNNER_WORKDIR ?? "/home/brokk/work";
const GIT_NAME = process.env.BROKK_GIT_NAME ?? "Brokk";
const GIT_EMAIL = process.env.BROKK_GIT_EMAIL ?? "brokk@coldcodelabs.com";

type Deps = { store: Store; checkouts: CheckoutManager };

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, {
    cwd,
    maxBuffer: 4 * 1024 * 1024,
    env: process.env,
  });
  return stdout;
}

/** Resolve the on-disk worktree to commit for a project (and optional session). */
async function resolveDevtree(
  deps: Deps,
  projectId: string,
  sessionId?: string | null,
): Promise<{ path: string; branch: string } | null> {
  // Prefer the persistent preview worktree (live HMR target).
  try {
    const previews = await deps.store.listPreviews({ projectId });
    const p =
      previews.find((x) => x.status === "live") ??
      previews.find((x) => !!x.hauldrProject);
    if (p?.hauldrProject) {
      const path = join(RUNNER_WORKDIR, "preview-worktrees", p.hauldrProject);
      if (existsSync(path)) return { path, branch: p.branch || "dev" };
    }
  } catch {
    /* fall through */
  }

  // Isolated session checkout (non-live).
  if (sessionId) {
    try {
      const s = await deps.store.getChatSession(sessionId);
      if (!s || s.projectId !== projectId) return null;
      const path = deps.checkouts.existing(sessionId);
      if (path) return { path, branch: s.branch || "dev" };
    } catch {
      /* fall through */
    }
  }

  return null;
}

async function statusOf(cwd: string, branch: string) {
  // Match preview dirty-guard: tracked changes only.
  const porcelain = await git(cwd, ["status", "--porcelain", "--untracked-files=no"]);
  const files = porcelain
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.replace(/^..\s+/, ""));
  let ahead: number | null = null;
  try {
    const counts = await git(cwd, [
      "rev-list",
      "--left-right",
      "--count",
      `origin/${branch}...HEAD`,
    ]);
    const parts = counts.trim().split(/\s+/);
    ahead = parts.length >= 2 ? Number(parts[1]) || 0 : null;
  } catch {
    ahead = null;
  }
  return {
    dirty: files.length > 0,
    branch,
    files: files.slice(0, 40),
    path: cwd,
    ahead,
  };
}

async function commitAndPush(cwd: string, branch: string, message: string) {
  const ident = ["-c", `user.name=${GIT_NAME}`, "-c", `user.email=${GIT_EMAIL}`];
  await git(cwd, ["add", "-A"]);
  const staged = await git(cwd, ["diff", "--cached", "--name-only"]);
  if (!staged.trim()) {
    throw Object.assign(new Error("nothing to commit"), { status: 409 });
  }
  await git(cwd, [...ident, "commit", "-m", message]);
  await git(cwd, ["push", "origin", `HEAD:${branch}`]);
  const sha = (await git(cwd, ["rev-parse", "HEAD"])).trim();
  return { sha, pushed: true as const };
}

const CommitBody = z.object({
  message: z.string().min(1).max(500).optional(),
  sessionId: z.string().min(1).optional(),
});

export function devtreeRoutes(deps: Deps): Hono {
  const r = new Hono();

  r.get("/projects/:projectId/devtree", async (c) => {
    const projectId = c.req.param("projectId");
    const sessionId = c.req.query("sessionId") || null;
    const resolved = await resolveDevtree(deps, projectId, sessionId);
    if (!resolved) {
      return c.json({
        dirty: false,
        branch: "dev",
        files: [],
        path: null,
        ahead: null,
        missing: true,
      });
    }
    try {
      return c.json(await statusOf(resolved.path, resolved.branch));
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  r.post("/projects/:projectId/devtree/commit", async (c) => {
    const projectId = c.req.param("projectId");
    const body = CommitBody.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: body.error.message }, 400);
    const resolved = await resolveDevtree(deps, projectId, body.data.sessionId ?? null);
    if (!resolved) return c.json({ error: "dev worktree not found" }, 404);
    const message =
      body.data.message?.trim() ||
      `chore(dev): land chat edits ${new Date().toISOString().slice(0, 16)}`;
    try {
      const result = await commitAndPush(resolved.path, resolved.branch, message);
      return c.json({ ok: true, ...result, branch: resolved.branch });
    } catch (e) {
      const status = (e as { status?: number }).status === 409 ? 409 : 500;
      return c.json({ error: e instanceof Error ? e.message : String(e) }, status);
    }
  });

  return r;
}
