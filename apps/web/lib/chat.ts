// ─────────────────────────────────────────────────────────────────────────────
// Browser client for Sindri (the chat agent), through the same-origin /api/chat
// proxy. CRUD is plain fetch; the turn stream is a POST that returns SSE, so we
// parse the byte stream ourselves (EventSource can't POST).
// ─────────────────────────────────────────────────────────────────────────────

import type { AnalysisQuestion, Preview, TaskAnalysis } from "@brokk/sdk";

const BASE = (process.env.NEXT_PUBLIC_BROKK_API_URL || "/api") + "/chat";

export type Role = "user" | "assistant";

export type Block =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

export interface ChatSession {
  id: string;
  projectId: string;
  title: string;
  status: "active" | "archived";
  branch: string | null;
  model: string;
  effort: string | null;
  /** afl / cli / cursor-* engines. Chosen freely until the first message; then locked. */
  engine?: string;
  /** Optional Brokk Skill id pinned at creation (skills/<id>/SKILL.md). */
  skill?: string | null;
  turnState: "idle" | "running";
  lastTurnAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Aggregate counters for a session (from the ?stats=1 list view). */
export interface ChatSessionStats {
  messages: number;
  tokensIn: number;
  tokensOut: number;
  lastMessageAt: string | null;
}

export type ChatSessionWithStats = ChatSession & { stats: ChatSessionStats };

export interface ChatMessage {
  id: string;
  sessionId: string;
  seq: number;
  role: Role;
  blocks: Block[];
  meta: Record<string, unknown> | null;
  createdAt: string;
}

/** An answer we actually heard back from the server. The status travels with it
 *  so callers can tell a verdict (404: the session is gone) from the fleet
 *  blinking (502 mid-redeploy) — one is worth surfacing, the other retrying. */
export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function j<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok)
    throw new ApiError(`${method} ${path} → ${res.status} ${await res.text().catch(() => "")}`, res.status);
  return (await res.json()) as T;
}

export const chat = {
  listSessions: (projectId: string) =>
    j<{ sessions: ChatSessionWithStats[] }>(
      "GET",
      `/sessions?stats=1&projectId=${encodeURIComponent(projectId)}`,
    ).then((r) => r.sessions),
  createSession: (input: {
    projectId: string;
    model?: string;
    effort?: string;
    engine?: string;
    skill?: string | null;
  }) => j<{ session: ChatSession }>("POST", "/sessions", input).then((r) => r.session),
  listSkills: () =>
    j<{ skills: { name: string; description: string; kind: string }[] }>("GET", "/skills").then(
      (r) => r.skills,
    ),
  listEngines: () =>
    j<{
      engines: { id: string; available: boolean; reason?: string }[];
    }>("GET", "/engines").then((r) => r.engines),
  getSession: (id: string) =>
    j<{ session: ChatSession; messages: ChatMessage[]; running: boolean }>("GET", `/sessions/${id}`),
  patchSession: (
    id: string,
    patch: {
      title?: string;
      status?: string;
      model?: string;
      effort?: string | null;
      /** Only while the session has zero messages. */
      engine?: string;
    },
  ) => j<{ session: ChatSession }>("PATCH", `/sessions/${id}`, patch).then((r) => r.session),
  deleteSession: (id: string) => j<{ ok: true }>("DELETE", `/sessions/${id}`),
  stop: (id: string) => j<{ stopped: boolean }>("POST", `/sessions/${id}/stop`),
  devtreeStatus: (projectId: string, sessionId?: string | null) =>
    j<{
      dirty: boolean;
      branch: string;
      files: string[];
      path: string | null;
      ahead: number | null;
      missing?: boolean;
    }>(
      "GET",
      `/projects/${encodeURIComponent(projectId)}/devtree${
        sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ""
      }`,
    ),
  devtreeCommit: (
    projectId: string,
    opts?: { message?: string; sessionId?: string | null },
  ) =>
    j<{ ok: true; sha: string; pushed: boolean; branch: string }>(
      "POST",
      `/projects/${encodeURIComponent(projectId)}/devtree/commit`,
      {
        message: opts?.message,
        sessionId: opts?.sessionId || undefined,
      },
    ),
};

export type { Preview };

// ── Huginn: project discovery brief ──────────────────────────────────────────

export type BriefStatus = "pending" | "ready" | "failed";

export interface ProjectBrief {
  projectId: string;
  status: BriefStatus;
  mission: string | null;
  summary: string | null;
  built: string[];
  missing: string[];
  stack: string[];
  model: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export const discovery = {
  /** The project's brief (+ whether a scout is running). brief is null if never scouted. */
  get: (projectId: string) =>
    j<{ brief: ProjectBrief | null; running: boolean }>("GET", `/discover/${projectId}`),
  /** (Re)scout the project — kicks a detached Huginn run; returns immediately. */
  scout: (projectId: string) =>
    j<{ status: string; running: boolean }>("POST", `/discover/${projectId}`),
};

// ── Full QA: scenario catalog ────────────────────────────────────────────────

export type QaCatalogStatus = "pending" | "ready" | "failed";
export type QaScenarioPriority = "p0" | "p1" | "p2";

export interface QaScenario {
  id: string;
  title: string;
  module: string;
  priority: QaScenarioPriority;
  role: string;
  tags: string[];
  preconditions: string[];
  steps: string[];
  expects: string[];
}

export interface QaCatalog {
  projectId: string;
  status: QaCatalogStatus;
  summary: string | null;
  fingerprint: string | null;
  scenarios: QaScenario[];
  model: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export const qa = {
  /** Catalog + stale flag (fingerprint drift vs current checkout sources). */
  get: (projectId: string) =>
    j<{
      catalog: QaCatalog | null;
      running: boolean;
      stale: boolean;
      currentFingerprint: string | null;
    }>("GET", `/qa/${encodeURIComponent(projectId)}`),
  /** Kick detached QA Discovery scout. */
  discover: (projectId: string) =>
    j<{ status: string; running: boolean }>(
      "POST",
      `/qa/${encodeURIComponent(projectId)}/discover`,
    ),
};

// ── Resolve: per-card analysis ────────────────────────────────────────────────

export type { TaskAnalysis, AnalysisQuestion };

export const analysis = {
  /** The card's analysis (+ whether a scout is running). null if never analysed. */
  get: (taskId: string) =>
    j<{ analysis: TaskAnalysis | null; running: boolean }>("GET", `/analyze/${taskId}`),
  /** Kick a detached Resolve scout for the card — moves it into `analysis`. */
  scout: (taskId: string) =>
    j<{ status: string; running: boolean }>("POST", `/analyze/${taskId}`),
  /** Re-run after answering Resolve's questions — refines the plan with `answers`. */
  answer: (taskId: string, answers: string) =>
    j<{ status: string; running: boolean }>("POST", `/analyze/${taskId}`, { answers }),
  /** "Adicionar Detalhes" — inject NEW authoritative info; regenerates a full v+1
   *  (title, citations, details, plan) and snapshots the prior version. */
  addDetails: (taskId: string, details: string) =>
    j<{ status: string; running: boolean }>("POST", `/analyze/${taskId}`, { details }),
};
