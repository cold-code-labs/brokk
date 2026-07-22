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

export type AgentEvent =
  | { type: "status"; phase: string; detail?: unknown }
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; toolUseId: string; ok: boolean; preview: string }
  | { type: "message"; seq: number; role: Role; blocks: Block[] }
  | { type: "usage"; usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number } }
  | { type: "title"; title: string }
  | { type: "done" }
  | { type: "error"; message: string }
  | { type: "ping" };

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

/** Parse an SSE response body, invoking onEvent per frame. Used by both the
 *  message POST and the reattach GET. Returns when the stream ends. */
async function consumeSSE(res: Response, onEvent: (e: AgentEvent) => void, signal?: AbortSignal): Promise<void> {
  if (!res.body) throw new Error("no stream body");
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    if (signal?.aborted) {
      reader.cancel().catch(() => {});
      return;
    }
    const { done, value } = await reader.read();
    if (done) return;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, nl);
      buf = buf.slice(nl + 2);
      const dataLines: string[] = [];
      for (const line of frame.split("\n")) if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
      const data = dataLines.join("\n");
      if (!data) continue;
      try {
        onEvent(JSON.parse(data) as AgentEvent);
      } catch {
        /* ignore malformed frame */
      }
    }
  }
}

/** Send a message and stream the turn. The turn keeps running server-side even if
 *  this stream is dropped (overnight) — reattach with attach(). */
export async function sendMessage(
  sessionId: string,
  text: string,
  onEvent: (e: AgentEvent) => void,
  signal?: AbortSignal,
  skill?: string | null,
  opts?: {
    /** Paths already written under `.brokk/inbox/` via fs/write. */
    attachments?: string[];
    /** Inline bytes when the checkout was not ready for fs/write. */
    attachmentUploads?: { name: string; dataBase64: string }[];
  },
): Promise<void> {
  const res = await fetch(`${BASE}/sessions/${sessionId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      text,
      ...(skill ? { skill } : {}),
      ...(opts?.attachments?.length ? { attachments: opts.attachments } : {}),
      ...(opts?.attachmentUploads?.length ? { attachmentUploads: opts.attachmentUploads } : {}),
    }),
    signal,
  });
  if (!res.ok) {
    const raw = await res.text().catch(() => "");
    let msg = `send → ${res.status} ${raw}`;
    try {
      const j = JSON.parse(raw) as { error?: unknown };
      if (typeof j.error === "string" && j.error.trim()) msg = j.error;
    } catch {
      /* keep raw */
    }
    throw new ApiError(msg, res.status);
  }
  await consumeSSE(res, onEvent, signal);
}

/** Reattach to an in-flight turn's live stream (replays the recent tail). */
export async function attach(sessionId: string, onEvent: (e: AgentEvent) => void, signal?: AbortSignal): Promise<void> {
  const res = await fetch(`${BASE}/sessions/${sessionId}/stream`, { signal });
  if (!res.ok) throw new ApiError(`attach → ${res.status}`, res.status);
  await consumeSSE(res, onEvent, signal);
}
