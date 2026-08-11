import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Hono } from "hono";
import { z } from "zod";
import { requestActor, canSeeProject, listScope, orgTenancyEnabled } from "../actor.js";
import type { AppDeps } from "../app.js";
import { fireHuginnDiscovery } from "../huginn-fire.js";
import { loadAppAuth, listInstallationRepositories } from "../github.js";

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
    const actor = requestActor(c, deps.runnerSecret);
    return c.json(await deps.store.listRepositories(listScope(actor)));
  });

  // Candidates to connect, minus the ones already connected. Two sources:
  //  • per-org (ADR 0064): if the org connected its own GitHub, list the repos its
  //    installation(s) authorize — GET /installation/repositories. No staff gate.
  //  • fleet: `gh repo list <CCL org>` — staff-only when tenancy is on (the GH org
  //    is the fleet surface). An org with no installation is told to connect first.
  r.get("/import/candidates", async (c) => {
    const actor = requestActor(c, deps.runnerSecret);
    const auth = loadAppAuth();
    const orgIds = actor.isStaff ? [] : actor.orgIds;
    const insts =
      auth && orgIds.length ? await deps.store.listInstallationsForOrgs(orgIds) : [];

    if (auth && insts.length) {
      const seen = new Set<string>();
      const candidates: Candidate[] = [];
      const errors: string[] = [];
      for (const inst of insts) {
        try {
          const repos = await listInstallationRepositories(auth, inst.installationId);
          for (const repo of repos) {
            if (seen.has(repo.fullName) || repo.isArchived) continue;
            seen.add(repo.fullName);
            candidates.push({
              fullName: repo.fullName,
              owner: repo.owner,
              name: repo.name,
              defaultBranch: repo.defaultBranch,
              description: repo.description,
              isArchived: repo.isArchived,
            });
          }
        } catch (err) {
          errors.push(err instanceof Error ? err.message : String(err));
        }
      }
      const connected = new Set(
        (await deps.store.listRepositories(listScope(actor))).map((x) => x.fullName),
      );
      return c.json({
        source: "installation",
        candidates: candidates.filter((x) => !connected.has(x.fullName)),
        ...(errors.length ? { errors } : {}),
      });
    }

    // No installation for this org → tell the UI to run the connect flow first
    // (instead of leaking the fleet org's repos).
    if (orgTenancyEnabled() && !actor.isStaff) {
      return c.json({ error: "conecte o GitHub da organização primeiro", needsConnect: true }, 409);
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
      source: "fleet",
      org,
      candidates: candidates.filter((x) => !connected.has(x.fullName)),
    });
  });

  // Single repo by id — the preview supervisor resolves a project's repo here.
  // Registered after the static "/import/candidates" route so it doesn't shadow it.
  r.get("/:id", async (c) => {
    const actor = requestActor(c, deps.runnerSecret);
    const repo = await deps.store.getRepository(c.req.param("id"));
    if (!repo || !canSeeProject(actor, repo.logtoOrgId)) {
      return c.json({ error: "not found" }, 404);
    }
    return c.json(repo);
  });

  // Bulk-connect selected repos (and, by default, a project each). Org-aware:
  // a non-staff admin imports into their own org, stamping the org's installation.
  r.post("/import", async (c) => {
    const actor = requestActor(c, deps.runnerSecret);
    const parsed = ImportBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    let logtoOrgId: string | null = null;
    if (orgTenancyEnabled() && !actor.isStaff) {
      if (!actor.orgIds.length) return c.json({ error: "no organization on session" }, 403);
      logtoOrgId = actor.orgIds[0]!;
    }
    const out = [];
    for (const repo of parsed.data.repos) {
      const installationId = await resolveInstallationId(deps, logtoOrgId, repo.fullName);
      const connected = await connectOne(deps, repo, parsed.data.createProject, {
        logtoOrgId,
        installationId,
      });
      out.push(connected.repo);
    }
    return c.json(out, 201);
  });

  // Connect a single repo by full name (manual fallback to the importer).
  r.post("/", async (c) => {
    const actor = requestActor(c, deps.runnerSecret);
    const parsed = ConnectBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    let logtoOrgId = parsed.data.logtoOrgId ?? null;
    if (orgTenancyEnabled() && !actor.isStaff) {
      if (!actor.orgIds.length) return c.json({ error: "no organization on session" }, 403);
      logtoOrgId = actor.orgIds[0]!;
    }
    const installationId = await resolveInstallationId(deps, logtoOrgId, parsed.data.fullName);
    const connected = await connectOne(deps, parsed.data, parsed.data.createProject, {
      logtoOrgId,
      installationId,
    });
    return c.json(connected.repo, 201);
  });

  return r;
}

/** The org's installation that owns a repo — matched by account login (the repo
 *  owner), falling back to the org's sole installation. Null when the org hasn't
 *  connected GitHub (repo stays on the ambient fleet token). */
export async function resolveInstallationId(
  deps: AppDeps,
  logtoOrgId: string | null,
  fullName: string,
): Promise<string | null> {
  if (!logtoOrgId) return null;
  const insts = await deps.store.listInstallationsForOrgs([logtoOrgId]);
  if (!insts.length) return null;
  const owner = fullName.split("/")[0]!.toLowerCase();
  const match = insts.find((i) => (i.accountLogin ?? "").toLowerCase() === owner);
  return (match ?? insts[0]!).installationId;
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
    installationId?: string | null;
  },
) {
  // Attribution (ADR 0064). An explicit org (from the actor, via the connect
  // routes) always wins. When none is given — ingress/from-brief have no actor —
  // derive it from the repo's GitHub OWNER: the installation on that account
  // carries its org. So a card first touched via Svalinn/ingress still forges with
  // the org's fuel + its own installation token, and never grabs a random seat.
  // A repo under the fleet's own GH org (no tenant installation) stays null =
  // fleet default, which is correct for CCL.
  let logtoOrgId = opts?.logtoOrgId ?? null;
  let installationId = opts?.installationId ?? null;
  if (!logtoOrgId || !installationId) {
    const owner = input.fullName.split("/")[0]!;
    const inst = await deps.store.getInstallationByAccount(owner).catch(() => null);
    if (inst) {
      logtoOrgId ??= inst.logtoOrgId;
      installationId ??= inst.installationId;
    }
  }

  const existing = await deps.store.getRepositoryByFullName(input.fullName);
  const repo =
    existing ??
    (await deps.store.insertRepository({
      fullName: input.fullName,
      owner: input.fullName.split("/")[0]!,
      name: input.fullName.split("/").slice(1).join("/"),
      defaultBranch: input.defaultBranch,
      cloneUrl: `https://github.com/${input.fullName}.git`,
      logtoOrgId,
      installationId,
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
      logtoOrgId: logtoOrgId ?? repo.logtoOrgId ?? null,
    });
    // Huginn Discovery (ADR 0067): brief always; QA only after Hero on prototypes
    // (devFirst) — cataloguing the empty template wastes the board.
    fireHuginnDiscovery(deps, project.id, { skipQa: opts?.devFirst ?? false });
  } else if (project && opts?.heimdallAppId && !project.heimdallAppId) {
    project = await deps.store.setProjectHeimdallAppId(project.id, opts.heimdallAppId);
  }
  return { repo, project };
}
