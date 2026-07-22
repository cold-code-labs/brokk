import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Hono } from "hono";
import { z } from "zod";
import { actorFrom, canSeeProject, listScope, orgTenancyEnabled } from "../actor.js";
import type { AppDeps } from "../app.js";

const run = promisify(execFile);

const GH_BIN = process.env.BROKK_GH_BIN ?? "gh";
const GH_ORG = process.env.BROKK_GH_ORG ?? "cold-code-labs";
const DEFAULT_MODEL = process.env.BROKK_DEFAULT_MODEL ?? "sonnet";

/** A repo offered by the gh importer (not yet connected). */
interface Candidate {
  fullName: string;
  owner: string;
  name: string;
  defaultBranch: string;
  description: string;
  isArchived: boolean;
}

async function ghList(org: string): Promise<Candidate[]> {
  const { stdout } = await run(
    GH_BIN,
    [
      "repo",
      "list",
      org,
      "--limit",
      "300",
      "--json",
      "nameWithOwner,owner,name,defaultBranchRef,description,isArchived",
    ],
    // Bound the call: a hung `gh` (no auth, slow network) must fail FAST with a
    // clean JSON 502 — never hang long enough for the edge to serve its own HTML
    // 502/504 page (which then lands, verbatim, in the importer UI).
    { maxBuffer: 8 * 1024 * 1024, timeout: 25_000, killSignal: "SIGKILL" },
  );
  const raw = JSON.parse(stdout) as Array<{
    nameWithOwner: string;
    owner: { login: string };
    name: string;
    defaultBranchRef: { name: string } | null;
    description: string | null;
    isArchived: boolean;
  }>;
  return raw.map((r) => ({
    fullName: r.nameWithOwner,
    owner: r.owner?.login ?? r.nameWithOwner.split("/")[0]!,
    name: r.name,
    defaultBranch: r.defaultBranchRef?.name ?? "main",
    description: r.description ?? "",
    isArchived: r.isArchived,
  }));
}

const ImportBody = z.object({
  repos: z
    .array(
      z.object({
        fullName: z.string().min(3),
        defaultBranch: z.string().default("main"),
      }),
    )
    .min(1),
  /** Create a default project per repo so it's forge-ready immediately. */
  createProject: z.boolean().default(true),
});

const ConnectBody = z.object({
  fullName: z.string().min(3),
  defaultBranch: z.string().default("main"),
  createProject: z.boolean().default(true),
  logtoOrgId: z.string().min(1).nullable().optional(),
});

export function repositoriesRoutes(deps: AppDeps): Hono {
  const r = new Hono();

  r.get("/", async (c) => {
    const actor = actorFrom(c);
    return c.json(await deps.store.listRepositories(listScope(actor)));
  });

  // Candidates from the org, minus the ones already connected. Powers the
  // "auto-import via gh" picker in the UI. Staff-only when tenancy is on —
  // the GH org is the CCL fleet surface (ADR 0064).
  r.get("/import/candidates", async (c) => {
    const actor = actorFrom(c);
    if (orgTenancyEnabled() && !actor.isStaff) {
      return c.json({ error: "forbidden" }, 403);
    }
    const org = c.req.query("org") ?? GH_ORG;
    let candidates: Candidate[];
    try {
      candidates = await ghList(org);
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { killed?: boolean };
      const msg = e?.killed
        ? `timed out after 25s listing ${org} via gh`
        : err instanceof Error
          ? err.message
          : String(err);
      return c.json({ error: `gh repo list failed: ${msg}` }, 502);
    }
    const connected = new Set(
      (await deps.store.listRepositories(listScope(actor))).map((x) => x.fullName),
    );
    return c.json({
      org,
      candidates: candidates.filter((x) => !connected.has(x.fullName)),
    });
  });

  // Single repo by id — the preview supervisor resolves a project's repo here.
  // Registered after the static "/import/candidates" route so it doesn't shadow it.
  r.get("/:id", async (c) => {
    const actor = actorFrom(c);
    const repo = await deps.store.getRepository(c.req.param("id"));
    if (!repo || !canSeeProject(actor, repo.logtoOrgId)) {
      return c.json({ error: "not found" }, 404);
    }
    return c.json(repo);
  });

  // Bulk-connect selected repos (and, by default, a project each).
  r.post("/import", async (c) => {
    const actor = actorFrom(c);
    if (orgTenancyEnabled() && !actor.isStaff) {
      return c.json({ error: "forbidden" }, 403);
    }
    const parsed = ImportBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const out = [];
    for (const repo of parsed.data.repos) {
      const connected = await connectOne(deps, repo, parsed.data.createProject);
      out.push(connected.repo);
    }
    return c.json(out, 201);
  });

  // Connect a single repo by full name (manual fallback to the importer).
  r.post("/", async (c) => {
    const actor = actorFrom(c);
    const parsed = ConnectBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    let logtoOrgId = parsed.data.logtoOrgId ?? null;
    if (orgTenancyEnabled() && !actor.isStaff) {
      if (!actor.orgIds.length) return c.json({ error: "no organization on session" }, 403);
      logtoOrgId = actor.orgIds[0]!;
    }
    const connected = await connectOne(deps, parsed.data, parsed.data.createProject, {
      logtoOrgId,
    });
    return c.json(connected.repo, 201);
  });

  return r;
}

export async function connectOne(
  deps: AppDeps,
  input: { fullName: string; defaultBranch: string },
  createProject: boolean,
  opts?: {
    devFirst?: boolean;
    baseBranch?: string;
    heimdallAppId?: string;
    logtoOrgId?: string | null;
  },
) {
  const existing = await deps.store.getRepositoryByFullName(input.fullName);
  const repo =
    existing ??
    (await deps.store.insertRepository({
      fullName: input.fullName,
      owner: input.fullName.split("/")[0]!,
      name: input.fullName.split("/").slice(1).join("/"),
      defaultBranch: input.defaultBranch,
      cloneUrl: `https://github.com/${input.fullName}.git`,
      logtoOrgId: opts?.logtoOrgId ?? null,
    }));

  let project = (await deps.store.listProjects()).find((p) => p.repositoryId === repo.id) ?? null;
  if (createProject && !project) {
    project = await deps.store.insertProject({
      name: repo.name,
      repositoryId: repo.id,
      model: DEFAULT_MODEL,
      authMode: "subscription",
      // Dev-first (ADR 0038) forges on `dev`; classic connect tracks the repo default.
      baseBranch: opts?.baseBranch ?? repo.defaultBranch,
      devFirst: opts?.devFirst ?? false,
      heimdallAppId: opts?.heimdallAppId ?? null,
      logtoOrgId: opts?.logtoOrgId ?? repo.logtoOrgId ?? null,
    });
    // Huginn scouts the freshly-connected project (async, best-effort) so a
    // brief is waiting by the time the user opens it. Never blocks the import.
    fireDiscovery(deps, project.id);
  }
  return { repo, project };
}

/** Fire-and-forget: ask Sindri to scout a project. Failures are swallowed (the
 *  brief just stays absent; the user can re-scout from the UI). */
function fireDiscovery(deps: AppDeps, projectId: string): void {
  const base = (deps.sindriUrl ?? "").replace(/\/$/, "");
  if (!base) return;
  void fetch(`${base}/discover/${projectId}`, {
    method: "POST",
    headers: deps.runnerSecret ? { authorization: `Bearer ${deps.runnerSecret}` } : {},
  }).catch(() => {});
}
