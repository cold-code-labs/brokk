import type {
  MimirMode,
  MimirPrompt,
  MimirRevision,
  Preview,
  Project,
  Repository,
  Run,
  RunEvent,
  Subscription,
  Task,
  User,
} from "@brokk/core";

// Re-export the domain types so consumers (web) depend only on the SDK.
export type {
  Agent, Preview, PreviewStatus, Project, Repository, Run, RunEvent, Subscription, Task, TaskStatus, RunStatus, User,
  TaskOwner, TaskSource, TaskEvent, TaskEventType,
  ForcaLevel, MimirMode, MimirPrompt, MimirRevision, RefinoLevel,
  Plan, PlanDraft, PlannedCard, PlanMode, PlanStatus, ClarifyQuestion,
  TaskAnalysis, AnalysisStatus, AnalysisStep, AnalysisEvidence, AnalysisRevision, AnalysisQuestion,
  RunLogEntry, RunLogTool, RunLogToolResult,
} from "@brokk/core";
export { TASK_STATUSES, TASK_OWNERS, TASK_SOURCES, foldRunLogEvents } from "@brokk/core";

/** What POST /tasks/:id/analysis/approve returns — atomic enqueues the card,
 *  feature spawns the sub-cards under a new plan. */
export interface ApproveAnalysisResult {
  mode: "atomic" | "feature";
  /** The sub-cards created (feature mode); empty for atomic. */
  cards: import("@brokk/core").Task[];
  /** The enriched+enqueued card (atomic mode only). */
  task?: import("@brokk/core").Task;
  /** The feature plan the sub-cards compose into (feature mode only). */
  planId?: string;
}

/** A repo the gh importer found in the org but that isn't connected yet. */
export interface RepoCandidate {
  fullName: string;
  owner: string;
  name: string;
  defaultBranch: string;
  description: string;
  isArchived: boolean;
}

/** What POST /mimir/triage returns — the two-axis recommendation. */
export interface MimirTriageResult {
  refino: import("@brokk/core").RefinoLevel;
  refinoConf: number;
  forca: import("@brokk/core").ForcaLevel;
  forcaConf: number;
  rationale: string;
  model: string;
}

/** What POST /mimir/enhance returns — the refined prompt + the recorded ids. */
export interface MimirEnhanceResult {
  enhanced: string;
  rationale: string;
  model: string;
  mode: MimirMode;
  revisionId: string;
  triageId?: string;
}

export interface MimirAuthor {
  authorId?: string;
  authorName?: string;
  authorEmail?: string;
}

/** One row of the calibration loop: a triage decision vs the task's real outcome. */
export interface MimirCalibrationRow {
  triageId: string;
  refino: import("@brokk/core").RefinoLevel;
  forca: import("@brokk/core").ForcaLevel;
  taskId: string;
  taskStatus: import("@brokk/core").TaskStatus | null;
  runStatus: import("@brokk/core").RunStatus | null;
  eitriVerdict: string | null;
  createdAt: string;
}

export interface BrokkClientOptions {
  baseUrl: string;
  /** Bearer token for the control-plane API (board auth). */
  token?: string;
  fetch?: typeof fetch;
}

export interface CreateTaskInput {
  projectId: string;
  title: string;
  body?: string;
  priority?: number;
  labels?: string[];
  baseBranch?: string;
  createdBy?: string;
  /** 'brokk' (default — flows to the forge) or 'human' (you'll resolve it). */
  owner?: import("@brokk/core").TaskOwner;
}

/** Minimal typed client over the Brokk control-plane API. Shared by the web UI
 *  and external callers (Heimdall, Asgard). */
export interface BrokkClient {
  // repositories (the forge's GitHub repos)
  listRepositories(): Promise<Repository[]>;
  /** Repos in the org not yet connected — the gh-backed import picker. */
  importCandidates(org?: string): Promise<{ org: string; candidates: RepoCandidate[] }>;
  /** Connect the chosen repos (and, by default, a default project each). */
  importRepositories(input: {
    repos: { fullName: string; defaultBranch?: string }[];
    createProject?: boolean;
  }): Promise<Repository[]>;

  listProjects(): Promise<Project[]>;
  listTasks(projectId?: string): Promise<Task[]>;
  getTask(id: string): Promise<Task>;
  createTask(input: CreateTaskInput): Promise<Task>;
  patchTask(id: string, patch: Partial<Task>): Promise<Task>;
  enqueueTask(id: string): Promise<Task>;
  /** Hand a card to a person (owner='human' → the forge skips it) or back to the
   *  forge ('brokk'). The board's "pegar" / "devolver". */
  setTaskOwner(id: string, owner: import("@brokk/core").TaskOwner, reason?: string): Promise<Task>;
  /** Mark a card resolved by hand (outside the forge): moves it to done + claims it
   *  for the human. The board's "resolver por fora". */
  resolveTask(id: string, reason?: string): Promise<Task>;
  /** The card's append-only lifecycle trail (created/status/owner/resolved/note). */
  listTaskEvents(id: string): Promise<import("@brokk/core").TaskEvent[]>;
  /** The card's Resolve analysis (null if never analysed). Read-only mirror. */
  getAnalysis(taskId: string): Promise<import("@brokk/core").TaskAnalysis | null>;
  /** Approve a ready analysis: atomic enqueues the card, feature spawns sub-cards. */
  approveAnalysis(taskId: string): Promise<ApproveAnalysisResult>;
  /** Huginn Phase 2: create proposed backlog cards from a project's discovery
   *  brief (one per "missing" item). Idempotent — re-running skips carded items. */
  backlogFromBrief(projectId: string): Promise<{ created: Task[]; skipped: number }>;
  /** ADR 0070 / H1: Enhance insumos → Prototype Pack, or validate a gated pack. */
  prototypePack(
    projectId: string,
    body:
      | { mode: "enhance"; insumos: import("@brokk/core").PrototypePackInsumos }
      | { mode: "pack"; pack: import("@brokk/core").PrototypePack },
  ): Promise<{
    pack: import("@brokk/core").PrototypePack;
    enhanced: boolean;
    model?: string;
    projectId: string;
  }>;
  /** Full QA → proposed backlog cards (catalog scenarios and/or fail|blocked findings). */
  backlogFromQa(
    projectId: string,
    input?: { source?: "findings" | "catalog" | "both"; runId?: string },
  ): Promise<{
    created: Task[];
    skipped: number;
    source: "findings" | "catalog" | "both";
    runId: string | null;
    catalogCount: number;
  }>;
  /** Huginn Phase 3: enqueue every proposed (discovery/plan/qa-fail) backlog card at once. */
  approveProposed(projectId: string): Promise<{ enqueued: number }>;
  /** ADR 0069: group qa-fail by module → Story Plans + enqueue (no per-card PR). */
  approveQaStories(
    projectId: string,
    input?: { includeQueued?: boolean },
  ): Promise<{
    stories: { planId: string; module: string; featureBranch: string; cardIds: string[] }[];
    enqueued: number;
    modules: number;
  }>;
  listPlans(projectId?: string): Promise<{ plans: import("@brokk/core").Plan[] }>;
  getPlan(id: string): Promise<{ plan: import("@brokk/core").Plan; tasks: Task[] }>;
  openPlanPr(
    id: string,
    input?: { override?: boolean; skipEitri?: boolean },
  ): Promise<{
    plan: import("@brokk/core").Plan;
    reused: boolean;
    eitri: { ok: boolean; detail?: string } | null;
  }>;
  listTaskRuns(id: string): Promise<Run[]>;
  getRun(id: string): Promise<Run>;
  /** Subscribe to a run's live event stream (SSE). Returns an unsubscribe fn. */
  streamRunEvents(id: string, onEvent: (e: RunEvent) => void): () => void;

  // users + Max seats
  listUsers(): Promise<User[]>;
  createUser(input: { name: string; email: string; githubLogin?: string }): Promise<User>;
  listSubscriptions(userId?: string): Promise<Subscription[]>;
  /** Step 1 of the legacy in-browser connect: returns the authorize URL to open. */
  connectStart(): Promise<{ sessionId: string; url: string }>;
  /** Step 2 of the legacy flow: exchange the pasted code → seals & stores the seat. */
  connectComplete(input: { sessionId: string; code: string; userId: string; label?: string }): Promise<Subscription>;
  /** Simplest path: the member ran `claude setup-token` on their own machine and
   *  pastes the resulting sk-ant-oat token; we just seal & store it. No server-side
   *  CLI needed. */
  connectToken(input: { userId: string; token: string; label?: string }): Promise<Subscription>;

  // mímir — the counselor (prompt bank + triador + enhancer)
  listMimirPrompts(authorId?: string): Promise<MimirPrompt[]>;
  searchMimirPrompts(query: string): Promise<MimirPrompt[]>;
  createMimirPrompt(input: { title: string; body: string; tags?: string[] } & MimirAuthor): Promise<MimirPrompt>;
  updateMimirPrompt(id: string, patch: { title?: string; body?: string; tags?: string[] }): Promise<MimirPrompt>;
  deleteMimirPrompt(id: string): Promise<{ ok: true }>;
  listMimirRevisions(authorId?: string): Promise<MimirRevision[]>;
  /** Advisory: size the request on both axes (refino + força). */
  triagePrompt(input: string): Promise<MimirTriageResult>;
  /** Refine at the chosen mode; records an immutable revision (+ triage if given). */
  enhancePrompt(input: { input: string; mode: MimirMode; triage?: MimirTriageResult & { source?: "auto" | "override" } } & MimirAuthor): Promise<MimirEnhanceResult>;
  /** Link a triage to the Brokk task its refined prompt became. */
  linkTriage(triageId: string, taskId: string): Promise<import("@brokk/core").MimirTriage>;
  /** The calibration view: triage decisions against their real outcomes. */
  getCalibration(): Promise<MimirCalibrationRow[]>;

  // previews — ephemeral dev-preview environments per branch
  /** Ensure+start: returns an existing starting/live preview or creates a fresh one. */
  createPreview(input: { projectId: string; branch?: string }): Promise<Preview>;
  getPreview(id: string): Promise<Preview>;
  listPreviews(projectId?: string): Promise<Preview[]>;
  /** Idle-reaper heartbeat: bump the preview's activity so it isn't rested. */
  pingPreview(id: string): Promise<Preview>;
  /** Stop a running preview (marks it stopped). */
  stopPreview(id: string): Promise<Preview>;
}

export function createBrokkClient(opts: BrokkClientOptions): BrokkClient {
  const baseUrl = opts.baseUrl.replace(/\/$/, "");
  const fetchImpl = opts.fetch ?? fetch;

  // Transient upstream states seen while the API container is mid-restart
  // (Traefik/Cloudflare answer 502/503/504 or the socket refuses). GETs are
  // idempotent, so retry a few times with backoff before surfacing the error.
  const TRANSIENT = new Set([502, 503, 504]);

  async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const idempotent = method === "GET";
    const attempts = idempotent ? 4 : 1;
    let res!: Awaited<ReturnType<typeof fetchImpl>>;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        res = await fetchImpl(`${baseUrl}${path}`, {
          method,
          headers: {
            ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
            ...(body ? { "Content-Type": "application/json" } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
        });
      } catch (err) {
        // Network-level failure (refused/reset) — same restart window.
        if (idempotent && attempt < attempts - 1) {
          await new Promise((r) => setTimeout(r, 300 * 2 ** attempt));
          continue;
        }
        throw err;
      }
      if (idempotent && TRANSIENT.has(res.status) && attempt < attempts - 1) {
        await new Promise((r) => setTimeout(r, 300 * 2 ** attempt));
        continue;
      }
      break;
    }
    if (!res.ok) {
      let detail = await res.text().catch(() => "");
      // A reverse-proxy/CDN (Cloudflare, Traefik) answers an unreachable origin
      // with a full HTML error page. Don't spew the whole document into the error
      // string — collapse it to a legible one-liner and cap the rest.
      if (/^\s*<(?:!doctype|html)\b/i.test(detail)) {
        detail = `${res.statusText || "upstream error"} (the API is unreachable — likely restarting)`;
      } else if (detail.length > 300) {
        detail = `${detail.slice(0, 300)}…`;
      }
      throw new Error(`brokk ${method} ${path} → ${res.status} ${detail}`.trim());
    }
    return (await res.json()) as T;
  }

  return {
    listRepositories() {
      return req<Repository[]>("GET", "/repositories");
    },
    importCandidates(org) {
      const q = org ? `?org=${encodeURIComponent(org)}` : "";
      return req<{ org: string; candidates: RepoCandidate[] }>(
        "GET",
        `/repositories/import/candidates${q}`,
      );
    },
    importRepositories(input) {
      return req<Repository[]>("POST", "/repositories/import", input);
    },
    listProjects() {
      return req<Project[]>("GET", "/projects");
    },
    listTasks(projectId) {
      const q = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
      return req<Task[]>("GET", `/tasks${q}`);
    },
    listTaskRuns(id) {
      return req<Run[]>("GET", `/tasks/${encodeURIComponent(id)}/runs`);
    },
    getTask(id) {
      return req<Task>("GET", `/tasks/${encodeURIComponent(id)}`);
    },
    createTask(input) {
      return req<Task>("POST", "/tasks", input);
    },
    patchTask(id, patch) {
      return req<Task>("PATCH", `/tasks/${encodeURIComponent(id)}`, patch);
    },
    enqueueTask(id) {
      return req<Task>("POST", `/tasks/${encodeURIComponent(id)}/enqueue`);
    },
    setTaskOwner(id, owner, reason) {
      return req<Task>("PATCH", `/tasks/${encodeURIComponent(id)}/owner`, { owner, reason });
    },
    resolveTask(id, reason) {
      return req<Task>("POST", `/tasks/${encodeURIComponent(id)}/resolve`, { reason });
    },
    listTaskEvents(id) {
      return req<import("@brokk/core").TaskEvent[]>(
        "GET",
        `/tasks/${encodeURIComponent(id)}/events`,
      );
    },
    getAnalysis(taskId) {
      return req<import("@brokk/core").TaskAnalysis | null>(
        "GET",
        `/tasks/${encodeURIComponent(taskId)}/analysis`,
      );
    },
    approveAnalysis(taskId) {
      return req<ApproveAnalysisResult>(
        "POST",
        `/tasks/${encodeURIComponent(taskId)}/analysis/approve`,
      );
    },
    backlogFromBrief(projectId) {
      return req<{ created: Task[]; skipped: number }>(
        "POST",
        `/projects/${encodeURIComponent(projectId)}/backlog-from-brief`,
      );
    },
    prototypePack(projectId, body) {
      return req<{
        pack: import("@brokk/core").PrototypePack;
        enhanced: boolean;
        model?: string;
        projectId: string;
      }>("POST", `/projects/${encodeURIComponent(projectId)}/prototype-pack`, body);
    },
    backlogFromQa(projectId, input) {
      return req<{
        created: Task[];
        skipped: number;
        source: "findings" | "catalog" | "both";
        runId: string | null;
        catalogCount: number;
      }>("POST", `/projects/${encodeURIComponent(projectId)}/backlog-from-qa`, input ?? {});
    },
    approveProposed(projectId) {
      return req<{ enqueued: number }>(
        "POST",
        `/projects/${encodeURIComponent(projectId)}/approve-proposed`,
      );
    },
    approveQaStories(projectId, input) {
      return req<{
        stories: { planId: string; module: string; featureBranch: string; cardIds: string[] }[];
        enqueued: number;
        modules: number;
      }>("POST", `/projects/${encodeURIComponent(projectId)}/approve-qa-stories`, input ?? {});
    },
    listPlans(projectId) {
      const q = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
      return req<{ plans: import("@brokk/core").Plan[] }>("GET", `/plans${q}`);
    },
    getPlan(id) {
      return req<{ plan: import("@brokk/core").Plan; tasks: Task[] }>(
        "GET",
        `/plans/${encodeURIComponent(id)}`,
      );
    },
    openPlanPr(id, input) {
      return req<{
        plan: import("@brokk/core").Plan;
        reused: boolean;
        eitri: { ok: boolean; detail?: string } | null;
      }>("POST", `/plans/${encodeURIComponent(id)}/open-pr`, input ?? {});
    },
    getRun(id) {
      return req<Run>("GET", `/runs/${encodeURIComponent(id)}`);
    },
    listUsers() {
      return req<User[]>("GET", "/users");
    },
    createUser(input) {
      return req<User>("POST", "/users", input);
    },
    listSubscriptions(userId) {
      const q = userId ? `/users/${encodeURIComponent(userId)}/subscriptions` : "/subscriptions";
      return req<Subscription[]>("GET", q);
    },
    connectStart() {
      return req<{ sessionId: string; url: string }>("POST", "/subscriptions/connect/start");
    },
    connectComplete(input) {
      return req<Subscription>("POST", "/subscriptions/connect/complete", input);
    },
    connectToken(input) {
      return req<Subscription>("POST", "/subscriptions/connect/token", input);
    },
    listMimirPrompts(authorId) {
      const q = authorId ? `?authorId=${encodeURIComponent(authorId)}` : "";
      return req<MimirPrompt[]>("GET", `/mimir/prompts${q}`);
    },
    searchMimirPrompts(query) {
      return req<MimirPrompt[]>("GET", `/mimir/prompts/search?q=${encodeURIComponent(query)}`);
    },
    createMimirPrompt(input) {
      return req<MimirPrompt>("POST", "/mimir/prompts", input);
    },
    updateMimirPrompt(id, patch) {
      return req<MimirPrompt>("PATCH", `/mimir/prompts/${encodeURIComponent(id)}`, patch);
    },
    deleteMimirPrompt(id) {
      return req<{ ok: true }>("DELETE", `/mimir/prompts/${encodeURIComponent(id)}`);
    },
    listMimirRevisions(authorId) {
      const q = authorId ? `?authorId=${encodeURIComponent(authorId)}` : "";
      return req<MimirRevision[]>("GET", `/mimir/revisions${q}`);
    },
    triagePrompt(input) {
      return req<MimirTriageResult>("POST", "/mimir/triage", { input });
    },
    enhancePrompt(input) {
      return req<MimirEnhanceResult>("POST", "/mimir/enhance", input);
    },
    linkTriage(triageId, taskId) {
      return req<import("@brokk/core").MimirTriage>(
        "POST",
        `/mimir/triage/${encodeURIComponent(triageId)}/link`,
        { taskId },
      );
    },
    getCalibration() {
      return req<MimirCalibrationRow[]>("GET", "/mimir/calibration");
    },
    streamRunEvents(id, onEvent) {
      // Browser EventSource; in Node, pass a polyfilled global or poll /runs/:id.
      const es = new EventSource(`${baseUrl}/runs/${encodeURIComponent(id)}/events`);
      const handler = (ev: MessageEvent) => {
        try {
          onEvent(JSON.parse(ev.data) as RunEvent);
        } catch {
          /* ignore malformed frames */
        }
      };
      es.onmessage = handler;
      return () => es.close();
    },
    createPreview(input) {
      return req<Preview>("POST", "/previews", input);
    },
    getPreview(id) {
      return req<Preview>("GET", `/previews/${encodeURIComponent(id)}`);
    },
    listPreviews(projectId) {
      const q = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
      return req<Preview[]>("GET", `/previews${q}`);
    },
    pingPreview(id) {
      return req<Preview>("POST", `/previews/${encodeURIComponent(id)}/ping`);
    },
    stopPreview(id) {
      return req<Preview>("DELETE", `/previews/${encodeURIComponent(id)}`);
    },
  };
}
