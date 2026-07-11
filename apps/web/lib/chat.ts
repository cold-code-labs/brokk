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
  /** afl (native loop, default) | cli (Claude Code CLI lane). Fixed at creation. */
  engine?: string;
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

async function j<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${await res.text().catch(() => "")}`);
  return (await res.json()) as T;
}

export const chat = {
  listSessions: (projectId: string) =>
    j<{ sessions: ChatSessionWithStats[] }>(
      "GET",
      `/sessions?stats=1&projectId=${encodeURIComponent(projectId)}`,
    ).then((r) => r.sessions),
  createSession: (input: { projectId: string; model?: string; effort?: string; engine?: string }) =>
    j<{ session: ChatSession }>("POST", "/sessions", input).then((r) => r.session),
  getSession: (id: string) =>
    j<{ session: ChatSession; messages: ChatMessage[]; running: boolean }>("GET", `/sessions/${id}`),
  patchSession: (id: string, patch: { title?: string; status?: string; model?: string; effort?: string | null }) =>
    j<{ session: ChatSession }>("PATCH", `/sessions/${id}`, patch).then((r) => r.session),
  deleteSession: (id: string) => j<{ ok: true }>("DELETE", `/sessions/${id}`),
  stop: (id: string) => j<{ stopped: boolean }>("POST", `/sessions/${id}/stop`),
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
): Promise<void> {
  const res = await fetch(`${BASE}/sessions/${sessionId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
    signal,
  });
  if (!res.ok) throw new Error(`send → ${res.status} ${await res.text().catch(() => "")}`);
  await consumeSSE(res, onEvent, signal);
}

/** Reattach to an in-flight turn's live stream (replays the recent tail). */
export async function attach(sessionId: string, onEvent: (e: AgentEvent) => void, signal?: AbortSignal): Promise<void> {
  const res = await fetch(`${BASE}/sessions/${sessionId}/stream`, { signal });
  if (!res.ok) throw new Error(`attach → ${res.status}`);
  await consumeSSE(res, onEvent, signal);
}
