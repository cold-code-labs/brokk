/**
 * @brokk/core — the domain language of Brokk. Pure TypeScript types and the two
 * ports (AgentEngine, GitProvider) the runner implements. Zero dependencies so
 * every other package can speak it without pulling anything in.
 *
 * Mirrors ARCHITECTURE.md §5 (domain model) and §8 (agent engine).
 */

// Sleipnir runtime contract (RuntimeSpec, DetectCtx). See docs/RUNTIME.md.
export type { RuntimeSpec, DetectCtx } from "./runtime.js";
import type { RuntimeSpec } from "./runtime.js";


// ── Enums ───────────────────────────────────────────────────────────────────

/** Board columns + side states. See ARCHITECTURE.md §5 "Card lifecycle".
 *  `analysis` sits between backlog and queued: Resolve (the per-card scout) is
 *  working out HOW/WHERE to solve the card before it's approved into the forge. */
export type TaskStatus =
  | "backlog"
  | "analysis"
  | "queued"
  | "running"
  | "review"
  | "done"
  | "failed"
  | "cancelled";

export const TASK_STATUSES: readonly TaskStatus[] = [
  "backlog",
  "analysis",
  "queued",
  "running",
  "review",
  "done",
  "failed",
  "cancelled",
] as const;

/** Who is driving a card. `brokk` = the forge may claim it (the default); `human`
 *  = a person pulled it to resolve it themselves, so the runner leaves it alone.
 *  Plain strings (not a pg enum) so the boot-time self-heal DDL stays a trivial
 *  ADD COLUMN — the chat-tables precedent. */
export type TaskOwner = "brokk" | "human";
export const TASK_OWNERS: readonly TaskOwner[] = ["brokk", "human"] as const;

/** How the card entered the board. `agent` = Huginn/Muninn/Resolve created it;
 *  `manual` = a human added it from the board. */
export type TaskSource = "agent" | "manual";
export const TASK_SOURCES: readonly TaskSource[] = ["agent", "manual"] as const;

/** The kind of thing a {@link TaskEvent} records on a card's timeline. */
export type TaskEventType = "created" | "status" | "owner" | "resolved" | "note";

/** One append-only entry in a card's life. Together they are the card's full
 *  lifecycle trail — who moved it, when, from what to what, and why. `from`/`to`
 *  hold the status (type=status), the owner (type=owner), or are null (note). */
export interface TaskEvent {
  id: string;
  taskId: string;
  type: TaskEventType;
  from: string | null;
  to: string | null;
  /** brokk | resolve | huginn | forge | system | a user email. */
  actor: string;
  /** Optional human-readable note (e.g. why it was pulled or force-moved). */
  reason: string | null;
  at: string;
}

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
  | "usage"
  | "acceptance";

export const RUN_EVENT_TYPES: readonly RunEventType[] = [
  "status",
  "message",
  "tool_use",
  "tool_result",
  "log",
  "usage",
  "acceptance",
] as const;

/** Live-acceptance receipt (Nv2 QA): the forge booted the worktree app and ran
 *  the card's `.brokk/acceptance.mjs` check against it. `ran=false` means the
 *  card shipped no check (non-UI card) — nothing was asserted. The screenshot is
 *  a base64 PNG data URL for the board run-log; it is NOT committed to the repo. */
export interface AcceptanceReceipt {
  ran: boolean;
  ok: boolean;
  output: string;
  screenshot?: string;
}

/** Lifecycle status of a dev-preview environment. `unsupported` = the resolver
 *  knew up front there was no supported runtime to boot (distinct from `failed` =
 *  a supported runtime booted and crashed). */
export type PreviewStatus = "starting" | "live" | "stopped" | "failed" | "unsupported";

export const PREVIEW_STATUSES: readonly PreviewStatus[] = [
  "starting",
  "live",
  "stopped",
  "failed",
  "unsupported",
] as const;

/** Whether a card is fresh work or a revision of an existing PR (the Eitri loop). */
export type TaskKind = "implement" | "revise";

/** How the runner authenticates to Claude. Default: subscription (lent Max seat);
 *  api_key (via the gateway) is the deferred multi-tenant/public path. */
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
  /** ADR 0038 (v0 face): born dev-first via "Nova Conversa" — its preview host
   *  drops the "-dev" suffix (`<app>.preview…`). Legacy projects are false and
   *  keep `<app>-dev.preview…`. */
  devFirst: boolean;
  /** ADR 0038: the Heimdall AppRecord id this project was provisioned as — the
   *  handle Publish/rollback call Heimdall with. Null for legacy projects. */
  heimdallAppId: string | null;
  /** ADR 0038: true once prod exists (first "Publicar" done). Drives the primary
   *  action: false → "Publicar" (birth prod); true → "Create PR" (promotion PR
   *  dev→main, reviewed by Eitri). */
  published: boolean;
  /** Pinned runtime (Sleipnir) — how the preview supervisor boots this project's
   *  checkout. Decided once at connect (Huginn skill / fast-path) and reused
   *  deterministically. Null = resolve each boot (legacy / not yet scouted). */
  runtime: RuntimeSpec | null;
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
  /** The warm index (#4): a cheap, refreshed-after-each-forge map of the repo
   *  (tree + packages) the planner reads so it picks realistic keys/touches
   *  WITHOUT a checkout. Null until the runner has forged once. */
  repoMap: string | null;
  /** When repoMap was last refreshed by a runner. */
  repoMapAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** What kind of thing a per-repo memory captures. `review_failure` is the
 *  highest-signal one (Eitri's rejections, fed back so the same mistake isn't
 *  repeated); `convention`/`pitfall`/`decision` are learned facts about the repo. */
export type RepoMemoryKind = "convention" | "pitfall" | "review_failure" | "decision";

export const REPO_MEMORY_KINDS: readonly RepoMemoryKind[] = [
  "convention",
  "pitfall",
  "review_failure",
  "decision",
] as const;

/** One thing Brokk learned about a repo, persisted across runs (#2). The planner
 *  and the forge both read these so the agent stops forging cold every time. */
export interface RepoMemory {
  id: string;
  repositoryId: string;
  kind: RepoMemoryKind;
  /** The fact, in one or two sentences. */
  content: string;
  /** Who wrote it: the planner, the forge, Eitri (review), or a human. */
  source: string;
  /** Bumped each time the same fact recurs — higher = more load-bearing. */
  weight: number;
  /** The PR/task this memory came from, when applicable. */
  prNumber: number | null;
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
  /** Who drives the card: `brokk` (forge may claim it) or `human` (pulled out of
   *  the forge to be resolved by a person). Default `brokk`. */
  owner: TaskOwner;
  /** How the card entered the board: `agent` (Huginn/Muninn/Resolve) or `manual`
   *  (added by a human from the board). Default `agent`. */
  source: TaskSource;
  priority: number;
  labels: string[];
  baseBranch: string | null;
  createdBy: string | null;
  prUrl: string | null;
  /** revise tasks only: the PR number + head branch to update, and the round. */
  prNumber: number | null;
  branch: string | null;
  iteration: number;
  /** If this card belongs to a Mímir plan, the plan it composes into. The cards
   *  of one plan share a feature branch and compose into ONE PR. */
  planId: string | null;
  /** Stable local id within the plan (e.g. "db", "api") that siblings reference
   *  in `dependsOn`. Null for standalone cards. */
  planKey: string | null;
  /** planKeys of sibling cards that must land before this one forges (the DAG). */
  dependsOn: string[];
  /** Planner-assigned complexity → drove the model/effort for this card. */
  forca: ForcaLevel | null;
  /** Files/areas this card is expected to touch — seed for the warm index (#5). */
  touches: string[];
  /** The success condition for this card (#3): how the forge proves it's done —
   *  the behaviour a test must cover. The forge is required to make it pass; the
   *  verify loop runs it. Null for pre-acceptance cards. */
  acceptance: string | null;
  /** Origin evidence: verbatim excerpts Muninn extracted from the meeting when it
   *  created this card (the real quotes, incl. any live correction) — the immutable
   *  source the analyst curates citations from. Empty for non-meeting cards. */
  evidence: AnalysisEvidence[];
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
  /** Eitri security ward: vulnerability findings in the PR's changed files. */
  scanBlocking: number;
  scanTotal: number;
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
  /** When status='unsupported' (or 'failed'): the human-readable reason — Huginn's
   *  explanation of why there's no runtime to boot. Null otherwise. */
  detail: string | null;
  /** Sha of the commit this preview last built/served (the branch tip checked
   *  out at boot), else null. Stamped by the supervisor after checkout. */
  commitSha: string | null;
  /** When the preview last checked out/built (ISO, stamped with commitSha) —
   *  the deploy's chronological anchor in the fleet feed. Null = never built. */
  builtAt: string | null;
  /** OS PID of the preview process on the runner host, if running. */
  pid: number | null;
  /** Redacted snapshot of the env the supervisor loaded into this preview
   *  (secret values masked) — powers the "Env" inspector in the preview bar.
   *  Null until the supervisor stamps it on boot. */
  loadedEnv: Record<string, string> | null;
  /** ISO time this preview last saw activity (start / UI heartbeat / respin).
   *  The supervisor rests a live preview idle past PREVIEW_IDLE_TTL_MS. */
  lastActivityAt: string;
  createdAt: string;
  updatedAt: string;
}

/** How long a live preview may sit without activity before the supervisor rests
 *  it (15 min). Activity = a start, a UI heartbeat (interaction while the Brokk
 *  screen is open), or a respin (a card's push rebuild). */
export const PREVIEW_IDLE_TTL_MS = 15 * 60 * 1000;

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

/** The result of running the project's verify command in the worktree. */
export interface VerifyOutcome {
  ok: boolean;
  /** Combined stdout+stderr (trimmed/tailed by the caller for storage). */
  output: string;
}

/** Outcome of the deterministic pre-heal pass (ADR 0027 / the v0-autofixer
 *  lesson): cheap mechanical fixes applied to the worktree with NO model call. */
export interface AutofixResult {
  /** Whether any file was changed (→ the engine re-verifies before healing). */
  changed: boolean;
  /** Short human note for the event log, e.g. "3 tsc suggestions". */
  note?: string;
}

/** What an engine run produces: token usage, the FINAL verify outcome after any
 *  self-heal iterations, and how many heal rounds it took. */
export interface RunResult {
  usage: RunUsage;
  /** Final verification after self-heal, or null when no verify was configured. */
  verify: VerifyOutcome | null;
  /** Heal iterations the agent ran (0 = passed first try / no verify). */
  healAttempts: number;
  /** Tail of the verify failure that triggered the LAST heal, when any — the
   *  raw material for the runner's repo-memory lesson (ADR 0027 §5.3). */
  lastHealFailure?: string;
  /** Verify rounds turned green by the deterministic pre-heal alone, i.e. model
   *  heal passes AVOIDED (#2 measurement). 0 = autofix off or never resolved. */
  autofixResolved?: number;
}

/** What the runner needs to execute one task. */
export interface AgentRunContext {
  task: Pick<Task, "id" | "title" | "body" | "labels" | "acceptance">;
  run: Pick<Run, "id" | "branch" | "model" | "authMode">;
  /** Working directory the agent operates in (the worktree). */
  cwd: string;
  model: string;
  authMode: AuthMode;
  /** Per-run Max OAuth token (a seat). Overrides the runner's ambient token. */
  authToken?: string;
  allowedTools: string[];
  /** Per-repo memory (#2): facts Brokk learned about this repo (conventions,
   *  pitfalls, past review failures). Injected into the forge prompt so the agent
   *  doesn't repeat known mistakes. Pre-formatted lines, highest-weight first. */
  memory?: string[];
  /** Run the project's verify command in the worktree (#1). Provided by the
   *  runner so the engine can self-heal: forge → verify → (on fail) re-prompt →
   *  repeat. Undefined = no verification (the engine forges once and returns). */
  verify?: () => Promise<VerifyOutcome>;
  /** Max self-heal iterations after a failed verify (#1). 0 = verify once, no
   *  heal. Ignored when `verify` is undefined. */
  maxHealAttempts?: number;
  /** Deterministic pre-heal (#2, the v0-autofixer lesson): given the verify
   *  failure text, apply cheap mechanical fixes (compiler "Did you mean"
   *  suggestions, an optional project fixer) to the worktree WITHOUT a model
   *  call. The engine re-verifies after; a green result skips the expensive
   *  model heal (10–40× cheaper than re-running the model on an obvious typo).
   *  Undefined = straight to model heal (the prior behaviour). */
  autofix?: (verifyOutput: string) => Promise<AutofixResult>;
  /** Dev-lane schema capability (ADR 0017 §6b). Present only when the run has a
   *  `<app>_dev` database to migrate against (the dev lane), which unlocks the
   *  agent's `apply_migration` tool: write db/migrations/NNNN.sql AND apply it to
   *  this project's dev DB through the control-plane migrate endpoint — the same
   *  endpoint + name the deploy uses, so the schema never drifts from the files
   *  and the deploy skips what's already applied. Absent on the PR path (no dev
   *  DB, no tool). */
  migration?: {
    /** Hauldr control-plane base url (HAULDR_CONTROL_URL). */
    controlUrl: string;
    /** Bearer for POST /v1/projects/:name/migrate (fleet management key or a
     *  per-project migrate token). */
    token: string;
    /** The project whose dev DB receives the DDL, e.g. `logcheck_dev`. */
    project: string;
  };
  /** Emit one event into the run stream (forwarded to the control plane). */
  emit: (event: Omit<RunEvent, "id" | "runId" | "seq" | "at">) => void;
}

/** The brain: a headless agent that forges code for a task and emits events.
 *  Concrete impl: ForgeEngine in @brokk/forge (native afl loop, no SDK). */
export interface AgentEngine {
  /** Forge the task to completion (verifying + self-healing if configured),
   *  returning the usage it consumed and the final verify outcome. */
  run(ctx: AgentRunContext): Promise<RunResult>;
}

/** Git/GitHub operations the runner performs around a run. Concrete impl in
 *  apps/forge over `git` + `gh` via child_process. */
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
  /** Per-project, migrate-scoped token (authorizes POST /v1/projects/:name/migrate
   *  for THIS project only). Lets a preview apply db/migrations to its dev DB. */
  migrateToken: string;
}

/** Port for the Hauldr control-plane. Concrete implementation lives in
 *  apps/forge. No implementation here — types + interface only. */
export interface Hauldr {
  /** Create the Hauldr project if it does not exist, bringing up any missing
   *  compute sidecars (auth + rest), then return its details. */
  ensureProject(name: string): Promise<HauldrProject>;
  /** Fetch an existing project by name. */
  getProject(name: string): Promise<HauldrProject>;
  /** Drop the project's compute sidecars (auth + rest) while KEEPING the
   *  database, so an idle preview backend costs ~MB of DB and zero containers.
   *  Idempotent; re-provisioned on the next {@link ensureProject}. */
  deprovisionCompute(name: string): Promise<void>;
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

/** Shared feature branch for a plan's cards: `brokk/feat-<slug>-<short-plan-id>`.
 *  Every card of the plan commits here; ONE PR is opened feature→base. */
export function featureBranch(summary: string, planId: string): string {
  return `brokk/feat-${taskSlug(summary)}-${planId.slice(0, 8)}`;
}

/** Map a complexity level to a concrete forge model + reasoning effort. The
 *  planner assigns `forca` per card; this is the single place that resolves it.
 *  Cheap work runs cheap; only the hard cards pull a flagship. */
export function forcaToModel(forca: ForcaLevel): { model: string; effort: "low" | "medium" | "high" } {
  switch (forca) {
    case "low":
      return { model: "haiku", effort: "low" };
    case "medium":
      return { model: "sonnet", effort: "medium" };
    case "high":
      return { model: "sonnet", effort: "high" };
    case "extra":
      return { model: "opus", effort: "high" };
  }
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
  /** The Brokk task the refined prompt became — the loop's link to the outcome. */
  taskId: string | null;
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

// ── The planner (Mímir → many cards → one PR) ──────────────────────────────────
// Mímir's planner turns one human intent into a forge plan: a single atomic card,
// or a feature decomposed into an ordered DAG of cards that compose into ONE PR.

/** atomic = one card (today's behaviour); feature = N cards on a shared branch. */
export type PlanMode = "atomic" | "feature";

export const PLAN_MODES: readonly PlanMode[] = ["atomic", "feature"] as const;

/** Lifecycle of a plan: being drafted, forging its cards, ready for review, done. */
export type PlanStatus = "planning" | "forging" | "review" | "done" | "failed";

export const PLAN_STATUSES: readonly PlanStatus[] = [
  "planning",
  "forging",
  "review",
  "done",
  "failed",
] as const;

/** One card the planner proposes (pre-persistence). `key` is local to the plan;
 *  `dependsOn` references sibling keys; `touches` seeds the warm index (#5). */
export interface PlannedCard {
  key: string;
  title: string;
  body: string;
  forca: ForcaLevel;
  /** Resolved from `forca` via forcaToModel — the model this card will forge with. */
  model: string;
  effort: "low" | "medium" | "high";
  dependsOn: string[];
  touches: string[];
  /** The card's success condition (#3): the observable behaviour the forge must
   *  make true and cover with a test. Empty when the planner couldn't state one. */
  acceptance: string;
}

/** A clarifying question Mímir raises when the intent is ambiguous or missing
 *  critical info — the forge's equivalent of "let me check before I run". The
 *  planner still produces best-guess cards alongside; answering and re-planning
 *  replaces the guess with a grounded plan. */
export interface ClarifyQuestion {
  /** Stable local id so an answer can be threaded back to its question. */
  id: string;
  /** The question, in the prompt's language. */
  question: string;
  /** Why it matters — what the answer changes about the plan. */
  why: string;
}

/** The planner's output for one human prompt (advisory until applied). */
export interface PlanDraft {
  mode: PlanMode;
  summary: string;
  rationale: string;
  targetBranch: string;
  cards: PlannedCard[];
  /** Open questions Mímir wants answered before this plan is trustworthy. Empty
   *  when the intent was clear enough to plan confidently. */
  questions: ClarifyQuestion[];
  /** Model the planner itself ran with (the strong one). */
  model: string;
}

// ── Sindri (the interactive chat agent) ────────────────────────────────────────
// The conversational half of the forge: a per-project chat that works the repo
// with you (read/write/run/commit/PR/open-card) over the native Messages API.
// Sibling to Brokkr (autonomous card→PR), Mímir (prompt intake), Eitri (review).

/** Whether a chat session is in use or filed away. */
export type ChatSessionStatus = "active" | "archived";

/** Whether a turn is currently being forged (so the UI knows to attach a stream). */
export type ChatTurnState = "idle" | "running";

/** A persistent, per-project conversation with Sindri. One session owns one
 *  working checkout on its own branch; the transcript (chatMessages) replays into
 *  the Messages API to resume context. */
export interface ChatSession {
  id: string;
  projectId: string;
  title: string;
  status: ChatSessionStatus;
  /** Git branch the session's working checkout sits on. */
  branch: string | null;
  /** Model alias the turn runs with: "haiku" | "sonnet" | "opus". */
  model: string;
  /** Reasoning effort: "low" | "medium" | "high" (null = provider default). */
  effort: string | null;
  /** Turn engine: "afl" (native loop, default) | "cli" (Claude Code CLI lane). */
  engine: string;
  /** The CLI's own session id (`--resume` continuity). engine=cli only. */
  cliSessionId: string | null;
  createdBy: string | null;
  turnState: ChatTurnState;
  lastTurnAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Aggregate counters for one chat session, derived from its messages. Lets the
 *  session rail show real stats (volume + token spend) without loading every
 *  transcript. `lastMessageAt` is the freshest activity, used for recency sorting. */
export interface ChatSessionStats {
  messages: number;
  tokensIn: number;
  tokensOut: number;
  lastMessageAt: string | null;
}

/** A session decorated with its aggregate stats (the rail/list view). */
export type ChatSessionWithStats = ChatSession & { stats: ChatSessionStats };

/** One step of the transcript: a user prompt, an assistant round (text +
 *  tool_use), or a tool_result batch. `blocks` are Anthropic content blocks. */
export interface ChatMessage {
  id: string;
  sessionId: string;
  seq: number;
  role: "user" | "assistant";
  blocks: unknown[];
  meta: Record<string, unknown> | null;
  createdAt: string;
}

// ── Huginn: project discovery ────────────────────────────────────────────────

/** Lifecycle of a project's discovery brief. `pending` = Huginn is scouting (or
 *  queued to); `ready` = a brief is available; `failed` = the scout errored. */
export type BriefStatus = "pending" | "ready" | "failed";

/** The product brief Huginn (the discovery scout) produces by reading a repo:
 *  what the project IS, what's BUILT, and what's MISSING — the raw material for an
 *  auto-proposed backlog. One brief per project (latest scout wins). */
export interface ProjectBrief {
  projectId: string;
  status: BriefStatus;
  /** One–two sentences: the product's core purpose/mission. */
  mission: string | null;
  /** A short paragraph: what the project is and its current state. */
  summary: string | null;
  /** Implemented capabilities (each a concrete, cited bullet). */
  built: string[];
  /** Gaps / unfinished / likely-next work — each phrasable as a task. */
  missing: string[];
  /** Key technologies detected. */
  stack: string[];
  /** Model that produced the brief. */
  model: string | null;
  /** Failure reason when status = "failed". */
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

// ── Resolve: per-card analysis ───────────────────────────────────────────────

/** Lifecycle of a card's resolution analysis. `pending` = Resolve is analysing;
 *  `ready` = a plan is available; `failed` = the scout errored. */
export type AnalysisStatus = "pending" | "ready" | "failed";

/** One concrete implementation step Resolve pins for a card. Mirrors the scout's
 *  ResolveStep (packages/agents/scout resolve.ts). `touches` are REAL paths the
 *  scout saw in the checkout; `acceptance` becomes the sub-card's success cond. */
export interface AnalysisStep {
  title: string;
  touches: string[];
  detail: string;
  acceptance: string;
}

/** A verbatim excerpt grounding the card — a REAL quote from the meeting (Muninn's
 *  origin evidence) or from the human's added details, for traceability. Never
 *  invented: the analyst only curates from quotes it was given. */
export interface AnalysisEvidence {
  /** The verbatim words, as said/written. */
  quote: string;
  /** Who said it, when known (Muninn extracts this from the transcript). */
  speaker?: string | null;
  /** Why this excerpt matters to the card — one line. */
  note?: string | null;
}

/** An open question Resolve wants answered before the plan is trustworthy. Each
 *  ships TWO suggested answer paths so the human can pick one per question (or
 *  write a custom answer) instead of composing free-form prose. */
export interface AnalysisQuestion {
  question: string;
  /** Two concrete, mutually-distinct answer paths the human can choose from. */
  options: string[];
}

/** A prior version of a card's analysis, snapshotted when a refine produced a new
 *  one. Append-only history kept inline on the analysis (`revisions`) so the whole
 *  lineage travels in one payload — v1 → v2 → … stays traceable in the drawer. */
export interface AnalysisRevision {
  version: number;
  title: string | null;
  details: string | null;
  evidence: AnalysisEvidence[];
  approach: string | null;
  rationale: string | null;
  mode: PlanMode | null;
  steps: AnalysisStep[];
  questions: AnalysisQuestion[];
  /** The human "Adicionar Detalhes" text that produced THIS version (null for v1). */
  inputDetails: string | null;
  createdAt: string;
}

/** The card's living, versioned understanding — problem (revised title + cited
 *  evidence + details) AND plan (approach/steps/questions) — that Resolve produces
 *  from ONE card + a read-only checkout, and that a human refines with "Adicionar
 *  Detalhes" (each refine bumps `version` and snapshots the prior into `revisions`).
 *  `mode` drives approval — atomic enqueues the card, feature expands the steps into
 *  sub-cards. One analysis per task (the current head; history in `revisions`). */
export interface TaskAnalysis {
  taskId: string;
  status: AnalysisStatus;
  /** The current version number (1 = first analysis). */
  version: number;
  /** A corrected, faithful title the analyst proposes when the card's own title is
   *  misleading. Applied to the card on approval. Null = keep the card's title. */
  revisedTitle: string | null;
  /** Plain-language restatement of the PROBLEM — what's actually wrong, for anyone
   *  (incl. non-technical) to grasp. Distinct from `approach` (the fix). */
  details: string | null;
  /** Verbatim excerpts grounding the card (curated from Muninn's origin evidence +
   *  the human's added details) — real quotes, for traceability. */
  evidence: AnalysisEvidence[];
  /** 1–3 sentences: the strategy to solve the card. */
  approach: string | null;
  /** Why this approach — what in the code justifies it. */
  rationale: string | null;
  /** atomic = one card/one PR; feature = break the steps into sub-cards (DAG). */
  mode: PlanMode | null;
  /** Concrete implementation steps, in order. */
  steps: AnalysisStep[];
  /** Open questions for the human (the handoff), each with two suggested answer
   *  paths. Empty when the plan is confident. */
  questions: AnalysisQuestion[];
  /** The human "Adicionar Detalhes" text that produced the current head (null for v1). */
  inputDetails: string | null;
  /** Prior versions, newest last — the append-only lineage. */
  revisions: AnalysisRevision[];
  /** Model that produced the analysis. */
  model: string | null;
  /** Failure reason when status = "failed". */
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A persisted plan: groups the cards that compose into one feature PR. */
export interface Plan {
  id: string;
  projectId: string;
  /** The raw human intent that produced the plan. */
  prompt: string;
  summary: string;
  rationale: string | null;
  mode: PlanMode;
  status: PlanStatus;
  /** The shared branch all the plan's cards commit to. */
  featureBranch: string;
  baseBranch: string;
  /** The single PR the plan composes into (set by the first card to push). */
  prUrl: string | null;
  prNumber: number | null;
  model: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

// ── Regin: the mission coordinator (MultiDevin-lite, ADR 0027 §5.4) ──────────
// A mission is ONE goal handed to the coordinator persona: Regin plans it via
// Mímir, dispatches the cards to the forge, watches the board, reacts to
// failures (retry ≤2, replan ≤1, then escalate to a human) and synthesizes the
// outcome when everything lands. Pure domain here — the reconciler that drives
// it lives in apps/api (a process concern), per the dependency law (§10).


/** Lifecycle of a mission. `planning` = Mímir is decomposing (or the proposed
 *  cards await board approval); `running` = cards dispatched, Regin watching;
 *  `blocked` = escalated to a human (resume re-runs the tick); `done`/`failed`
 *  are terminal outcomes; `cancelled` = a human called it off. */
export type MissionStatus =
  | "planning"
  | "running"
  | "blocked"
  | "done"
  | "failed"
  | "cancelled";

export const MISSION_STATUSES: readonly MissionStatus[] = [
  "planning",
  "running",
  "blocked",
  "done",
  "failed",
  "cancelled",
] as const;

/** Regin's durable reaction counters, persisted on the mission row so a tick is
 *  crash-safe and idempotent (recomputed from db state, never from memory).
 *  Keyed by taskId. `taskIds` pins the cards the mission dispatched — covers the
 *  atomic path (no planId to load cards by). */
export interface MissionState {
  /** Retries issued per card (failed → queued). Capped at 2. */
  attempts: Record<string, number>;
  /** Replans issued per card (one-shot card revision). Capped at 1. */
  replans: Record<string, number>;
  /** The cards this mission created, stamped at planning time. */
  taskIds?: string[];
}

/** One goal under Regin's watch. */
export interface Mission {
  id: string;
  projectId: string;
  /** The human goal, verbatim — what Mímir plans and Regin shepherds. */
  goal: string;
  /** The feature plan the goal decomposed into (null for the atomic path). */
  planId: string | null;
  status: MissionStatus;
  /** Human-readable line: why blocked, the synthesis when done, etc. */
  detail: string | null;
  /** true = Regin enqueues the proposed cards himself; false = the board
   *  approves (mission rests in `planning` until a card leaves backlog). */
  autoApprove: boolean;
  /** The Sindri session that started the mission, when it came from chat. */
  chatSessionId: string | null;
  createdBy: string | null;
  state: MissionState;
  createdAt: string;
  updatedAt: string;
}

/** What a {@link MissionEvent} records on the mission's append-only trail. */
export type MissionEventType =
  | "created"
  | "status"
  | "note"
  | "retry"
  | "replan"
  | "escalation"
  | "synthesis";

/** One append-only entry in a mission's life — the task_events sibling. */
export interface MissionEvent {
  id: string;
  missionId: string;
  type: MissionEventType;
  detail: unknown;
  at: string;
}

/** Card-status counts for a mission's cards. `backlog` folds in `analysis`
 *  (both are pre-approval board states — the card hasn't been dispatched). */
export interface MissionProgress {
  total: number;
  done: number;
  failed: number;
  running: number;
  queued: number;
  review: number;
  backlog: number;
  cancelled: number;
}

/** Tally a mission's cards by status. Pure — feeds the reconciler's decisions. */
export function missionProgress(cards: Pick<Task, "status">[]): MissionProgress {
  const p: MissionProgress = {
    total: cards.length,
    done: 0,
    failed: 0,
    running: 0,
    queued: 0,
    review: 0,
    backlog: 0,
    cancelled: 0,
  };
  for (const c of cards) {
    switch (c.status) {
      case "done": p.done++; break;
      case "failed": p.failed++; break;
      case "running": p.running++; break;
      case "queued": p.queued++; break;
      case "review": p.review++; break;
      case "cancelled": p.cancelled++; break;
      // backlog + analysis are both "not yet dispatched" board states.
      default: p.backlog++; break;
    }
  }
  return p;
}

/** True when no card can still move on its own: nothing queued/running/backlog
 *  AND nothing in review — a card in `review` has an OPEN PR awaiting Eitri /
 *  merge, so the mission must keep watching, not settle. */
export function missionCardsSettled(progress: MissionProgress): boolean {
  return (
    progress.queued === 0 &&
    progress.running === 0 &&
    progress.review === 0 &&
    progress.backlog === 0
  );
}
