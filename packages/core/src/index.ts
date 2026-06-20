/**
 * @brokk/core — the domain language of Brokk. Pure TypeScript types and the two
 * ports (AgentEngine, GitProvider) the runner implements. Zero dependencies so
 * every other package can speak it without pulling anything in.
 *
 * Mirrors ARCHITECTURE.md §5 (domain model) and §8 (agent engine).
 */

// ── Enums ───────────────────────────────────────────────────────────────────

/** Board columns + side states. See ARCHITECTURE.md §5 "Card lifecycle". */
export type TaskStatus =
  | "backlog"
  | "queued"
  | "running"
  | "review"
  | "done"
  | "failed"
  | "cancelled";

export const TASK_STATUSES: readonly TaskStatus[] = [
  "backlog",
  "queued",
  "running",
  "review",
  "done",
  "failed",
  "cancelled",
] as const;

/** One execution attempt of a task. */
export type RunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export const RUN_STATUSES: readonly RunStatus[] = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
] as const;

/** The append-only event stream that powers the live run log (SSE). */
export type RunEventType =
  | "status"
  | "message"
  | "tool_use"
  | "tool_result"
  | "log"
  | "usage";

export const RUN_EVENT_TYPES: readonly RunEventType[] = [
  "status",
  "message",
  "tool_use",
  "tool_result",
  "log",
  "usage",
] as const;

/** How the runner authenticates to Claude. Default: api_key (via the gateway). */
export type AuthMode = "api_key" | "subscription";

export const AUTH_MODES: readonly AuthMode[] = ["api_key", "subscription"] as const;

// ── Entities ─────────────────────────────────────────────────────────────────

/** A unit of work scoped to one repo + agent config. */
export interface Project {
  id: string;
  name: string;
  repositoryId: string;
  /** Claude model id the agent runs with (e.g. "claude-sonnet-4-...). */
  model: string;
  authMode: AuthMode;
  /** Allowlist passed to the Agent SDK; empty/undefined = engine default. */
  allowedTools: string[];
  /** Branch new worktrees fork from. */
  baseBranch: string;
  createdAt: string;
  updatedAt: string;
}

export interface Repository {
  id: string;
  /** "owner/name" on GitHub. */
  fullName: string;
  owner: string;
  name: string;
  defaultBranch: string;
  cloneUrl: string;
  /** GitHub App installation id, if installed. */
  installationId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** The card on the board. */
export interface Task {
  id: string;
  projectId: string;
  title: string;
  body: string;
  status: TaskStatus;
  priority: number;
  labels: string[];
  baseBranch: string | null;
  createdBy: string | null;
  prUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One execution attempt of a task. */
export interface Run {
  id: string;
  taskId: string;
  status: RunStatus;
  runnerId: string | null;
  /** Absolute path of the git worktree the run executed in. */
  worktree: string | null;
  branch: string | null;
  model: string | null;
  authMode: AuthMode | null;
  startedAt: string | null;
  endedAt: string | null;
  tokensIn: number;
  tokensOut: number;
  /** Tokens saved by headroom compression, reported by the proxy. */
  headroomSaved: number;
  prUrl: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Append-only stream entry. Ordered within a run by (runId, seq). */
export interface RunEvent {
  id: string;
  runId: string;
  seq: number;
  type: RunEventType;
  payload: unknown;
  at: string;
}

/** A runner/agent host that pulls from the queue. */
export interface Agent {
  id: string;
  host: string;
  capabilities: string[];
  status: "online" | "offline" | "busy";
  lastSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Pull request opened by a run. */
export interface PullRequest {
  id: string;
  taskId: string;
  runId: string;
  repositoryId: string;
  number: number | null;
  url: string;
  branch: string;
  state: "open" | "merged" | "closed";
  createdAt: string;
  updatedAt: string;
}

// ── Ports (implemented by the runner) ────────────────────────────────────────

/** Token usage reported back at the end of a run. */
export interface RunUsage {
  tokensIn: number;
  tokensOut: number;
  headroomSaved: number;
}

/** What the runner needs to execute one task. */
export interface AgentRunContext {
  task: Pick<Task, "id" | "title" | "body" | "labels">;
  run: Pick<Run, "id" | "branch" | "model" | "authMode">;
  /** Working directory the agent operates in (the worktree). */
  cwd: string;
  model: string;
  authMode: AuthMode;
  allowedTools: string[];
  /** Emit one event into the run stream (forwarded to the control plane). */
  emit: (event: Omit<RunEvent, "id" | "runId" | "seq" | "at">) => void;
}

/** The brain: a headless agent that forges code for a task and emits events.
 *  Concrete impl lives in @brokk/runner over the Claude Agent SDK. */
export interface AgentEngine {
  /** Run the agent to completion, returning the usage it consumed. */
  run(ctx: AgentRunContext): Promise<RunUsage>;
}

/** Git/GitHub operations the runner performs around a run. Concrete impl in
 *  @brokk/runner over `git` + `gh` via child_process. */
export interface GitProvider {
  /** Create an isolated worktree off `baseBranch` on `branch`; returns its path. */
  worktree(opts: {
    repo: Repository;
    baseBranch: string;
    branch: string;
  }): Promise<{ path: string; branch: string }>;

  /** Commit all changes and push the branch. */
  push(opts: { cwd: string; branch: string; message: string }): Promise<void>;

  /** Open a PR from `branch` into `baseBranch`; returns the PR url. */
  openPr(opts: {
    cwd: string;
    repo: Repository;
    branch: string;
    baseBranch: string;
    title: string;
    body: string;
  }): Promise<{ url: string; number: number | null }>;

  /** Remove the worktree (kept on failure for debugging). */
  cleanup(opts: { path: string }): Promise<void>;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Slugify a task title into a branch-safe fragment. */
export function taskSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

/** Branch name for a run: `brokk/<task-slug>-<short-run-id>`. */
export function runBranch(title: string, runId: string): string {
  return `brokk/${taskSlug(title)}-${runId.slice(0, 8)}`;
}
