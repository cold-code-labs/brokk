import type {
  MimirMode,
  MimirPrompt,
  MimirRevision,
  Project,
  Run,
  RunEvent,
  Subscription,
  Task,
  User,
} from "@brokk/core";

// Re-export the domain types so consumers (web) depend only on the SDK.
export type {
  Agent, Project, Run, RunEvent, Subscription, Task, TaskStatus, RunStatus, User,
  ForcaLevel, MimirMode, MimirPrompt, MimirRevision, RefinoLevel,
} from "@brokk/core";

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
}

/** Minimal typed client over the Brokk control-plane API. Shared by the web UI
 *  and external callers (Heimdall, Asgard). */
export interface BrokkClient {
  listProjects(): Promise<Project[]>;
  listTasks(projectId?: string): Promise<Task[]>;
  getTask(id: string): Promise<Task>;
  createTask(input: CreateTaskInput): Promise<Task>;
  patchTask(id: string, patch: Partial<Task>): Promise<Task>;
  enqueueTask(id: string): Promise<Task>;
  listTaskRuns(id: string): Promise<Run[]>;
  getRun(id: string): Promise<Run>;
  /** Subscribe to a run's live event stream (SSE). Returns an unsubscribe fn. */
  streamRunEvents(id: string, onEvent: (e: RunEvent) => void): () => void;

  // users + Max seats
  listUsers(): Promise<User[]>;
  createUser(input: { name: string; email: string; githubLogin?: string }): Promise<User>;
  listSubscriptions(userId?: string): Promise<Subscription[]>;
  /** Step 1 of connecting a Max seat: returns the authorize URL to open. */
  connectStart(): Promise<{ sessionId: string; url: string }>;
  /** Step 2: exchange the pasted code → seals & stores the seat. */
  connectComplete(input: { sessionId: string; code: string; userId: string; label?: string }): Promise<Subscription>;

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
}

export function createBrokkClient(opts: BrokkClientOptions): BrokkClient {
  const baseUrl = opts.baseUrl.replace(/\/$/, "");
  const fetchImpl = opts.fetch ?? fetch;

  async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers: {
        ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`brokk ${method} ${path} → ${res.status} ${detail}`.trim());
    }
    return (await res.json()) as T;
  }

  return {
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
  };
}
