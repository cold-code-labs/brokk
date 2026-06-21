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

/** Lifecycle status of a dev-preview environment. */
export type PreviewStatus = "starting" | "live" | "stopped" | "failed";

export const PREVIEW_STATUSES: readonly PreviewStatus[] = [
  "starting",
  "live",
  "stopped",
  "failed",
] as const;

/** Whether a card is fresh work or a revision of an existing PR (the Eitri loop). */
export type TaskKind = "implement" | "revise";

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
  kind: TaskKind;
  priority: number;
  labels: string[];
  baseBranch: string | null;
  createdBy: string | null;
  prUrl: string | null;
  /** revise tasks only: the PR number + head branch to update, and the round. */
  prNumber: number | null;
  branch: string | null;
  iteration: number;
  createdAt: string;
  updatedAt: string;
}

/** One execution attempt of a task. */
export interface Run {
  id: string;
  taskId: string;
  status: RunStatus;
  runnerId: string | null;
  /** The Max seat (subscription) that powered this run, if any. */
  subscriptionId: string | null;
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

/** A team member who can lend a Max seat to the forge. */
export interface User {
  id: string;
  name: string;
  email: string;
  githubLogin: string | null;
  role: string;
  createdAt: string;
  updatedAt: string;
}

/** A Max subscription (seat) a user lends to Brokk. The token itself is sealed
 *  at rest and never leaves the server — only a masked preview is exposed. */
export interface Subscription {
  id: string;
  userId: string;
  kind: string;
  label: string;
  tokenPreview: string;
  status: "active" | "revoked";
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A review Eitri posted on a pull request (one per PR head sha). */
export interface Review {
  id: string;
  repo: string;
  prNumber: number;
  sha: string;
  verdict: string;
  summary: string;
  createdAt: string;
}

/** An ephemeral Supabase/Hauldr dev-preview environment spun up for a branch. */
export interface Preview {
  id: string;
  projectId: string;
  /** The git branch this preview tracks. */
  branch: string;
  /** DNS subdomain for the preview (e.g. "abc123.preview.brokk.dev"). */
  subdomain: string;
  /** Full public URL of the preview. */
  url: string;
  /** Local port the preview listens on (on the runner host). */
  port: number | null;
  /** Name of the Hauldr project backing this preview. */
  hauldrProject: string;
  status: PreviewStatus;
  lastSeenAt: string | null;
  expiresAt: string | null;
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
  /** Per-run Max OAuth token (a seat). Overrides the runner's ambient token. */
  authToken?: string;
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

  /** Check out an EXISTING remote branch (a PR head) into a worktree, to revise
   *  it in place. */
  checkoutBranch(opts: { repo: Repository; branch: string }): Promise<{ path: string; branch: string }>;

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

/** The shape the Hauldr control-plane returns for GET /v1/projects/:name. */
export interface HauldrProject {
  database: string;
  gotrueUrl: string;
  jwtSecret: string;
  postgrestUrl: string;
  dbUrl: string;
}

/** Port for the Hauldr control-plane. Concrete implementation lives in
 *  @brokk/runner. No implementation here — types + interface only. */
export interface Hauldr {
  /** Create the Hauldr project if it does not exist, then return its details. */
  ensureProject(name: string): Promise<HauldrProject>;
  /** Fetch an existing project by name. */
  getProject(name: string): Promise<HauldrProject>;
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

// ── Mímir (the counselor) ─────────────────────────────────────────────────────
// The prompt intake of the forge: the bank of reusable prompts, the immutable
// refinement history, and the triador's two-axis decision. Trio: Mímir advises
// → Brokkr forges → Eitri reviews. Migrated from Heimdall's PocketBase.

/** How much structure the enhancer injects over the raw prompt. The axis is
 *  *amount of structure*, not quality. Mirrors the original Mímir modes. */
export type MimirMode = "polish" | "structure" | "engineer";

export const MIMIR_MODES: readonly MimirMode[] = ["polish", "structure", "engineer"] as const;

/** Axis 1 — specification gap → how much to refine. "none" skips the enhancer
 *  (the prompt is already clear); the rest map 1:1 onto MimirMode, where
 *  "engineer" is the full archetype. */
export type RefinoLevel = "none" | MimirMode;

export const REFINO_LEVELS: readonly RefinoLevel[] = [
  "none",
  "polish",
  "structure",
  "engineer",
] as const;

/** Axis 2 — task complexity/risk → how hard the forge runs. Mapped to a concrete
 *  model + reasoning effort downstream (via the gateway / Bifröst). */
export type ForcaLevel = "low" | "medium" | "high" | "extra";

export const FORCA_LEVELS: readonly ForcaLevel[] = ["low", "medium", "high", "extra"] as const;

/** Whether a triage decision came from the auto router or a human override. */
export type TriageSource = "auto" | "override";

/** A reusable, refined prompt in the collective bank. */
export interface MimirPrompt {
  id: string;
  title: string;
  body: string;
  tags: string[];
  authorId: string | null;
  authorName: string | null;
  authorEmail: string | null;
  refineCount: number;
  createdAt: string;
  updatedAt: string;
}

/** One refinement, recorded immutably (input → output → rationale). */
export interface MimirRevision {
  id: string;
  input: string;
  output: string | null;
  rationale: string | null;
  /** Model the enhancer used. */
  model: string | null;
  mode: MimirMode | null;
  /** If the author saved the result to the bank, the prompt it became. */
  savedPromptId: string | null;
  authorId: string | null;
  authorName: string | null;
  authorEmail: string | null;
  createdAt: string;
}

/** The triador's two-axis decision for a revision: how much to refine + how hard
 *  to forge. Confidences feed the calibration loop (Eitri's verdict vs the
 *  levels the router chose). */
export interface MimirTriage {
  id: string;
  revisionId: string | null;
  refinoLevel: RefinoLevel;
  refinoConf: number | null;
  forcaLevel: ForcaLevel;
  forcaConf: number | null;
  rationale: string | null;
  source: TriageSource;
  /** Model the triador (router) ran with — the cheap one. */
  triageModel: string | null;
  createdAt: string;
}
