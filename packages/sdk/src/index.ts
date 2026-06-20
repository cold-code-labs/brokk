import type { Project, Run, RunEvent, Task } from "@brokk/core";

// Re-export the domain types so consumers (web) depend only on the SDK.
export type { Agent, Project, Run, RunEvent, Task, TaskStatus, RunStatus } from "@brokk/core";

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
