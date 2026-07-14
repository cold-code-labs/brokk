import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Brokk schema (ARCHITECTURE.md §6). UUID PKs via gen_random_uuid(),
 * created_at/updated_at timestamps, FKs with cascade. run_events is
 * append-only, ordered by (run_id, seq).
 */

// ── Enums ────────────────────────────────────────────────────────────────────

export const taskStatus = pgEnum("task_status", [
  "backlog",
  // Resolve (per-card scout) is working out how/where before the card is approved.
  "analysis",
  "queued",
  "running",
  "review",
  "done",
  "failed",
  "cancelled",
]);

export const runStatus = pgEnum("run_status", [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);

export const runEventType = pgEnum("run_event_type", [
  "status",
  "message",
  "tool_use",
  "tool_result",
  "log",
  "usage",
  "acceptance",
]);

export const authMode = pgEnum("auth_mode", ["api_key", "subscription"]);

export const taskKind = pgEnum("task_kind", ["implement", "revise"]);

// Mímir planner — one human intent → one atomic card or a feature DAG → one PR.
export const planMode = pgEnum("plan_mode", ["atomic", "feature"]);
export const planStatus = pgEnum("plan_status", [
  "planning",
  "forging",
  "review",
  "done",
  "failed",
]);

// Mímir (the counselor) — see §"Mímir" in ARCHITECTURE.md.
export const mimirMode = pgEnum("mimir_mode", ["polish", "structure", "engineer"]);
export const refinoLevel = pgEnum("refino_level", ["none", "polish", "structure", "engineer"]);
export const forcaLevel = pgEnum("forca_level", ["low", "medium", "high", "extra"]);
export const triageSource = pgEnum("triage_source", ["auto", "override"]);

export const previewStatus = pgEnum("preview_status", [
  "starting",
  "live",
  "stopped",
  "failed",
  // The resolver knew up front there's no supported runtime to boot (or the
  // detected spec failed validation) — a clean state, not a booted-then-crashed
  // 'failed'. See docs/RUNTIME.md.
  "unsupported",
]);

// ── Tables ───────────────────────────────────────────────────────────────────

export const repositories = pgTable("repositories", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  fullName: text("full_name").notNull().unique(),
  owner: text("owner").notNull(),
  name: text("name").notNull(),
  defaultBranch: text("default_branch").notNull().default("main"),
  cloneUrl: text("clone_url").notNull(),
  installationId: text("installation_id"),
  // The warm index (#4): a cheap repo map (tree + packages) the runner refreshes
  // after each forge, read by the planner so it plans WITHOUT a checkout.
  repoMap: text("repo_map"),
  repoMapAt: timestamp("repo_map_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Per-repo memory (#2): facts Brokk learned about a repo, persisted across runs.
 *  Eitri writes review failures here; the planner + forge read them so the agent
 *  stops forging cold. (repository_id, kind, content) is unique so a recurring
 *  fact bumps `weight` instead of duplicating. */
export const repoMemoryKind = pgEnum("repo_memory_kind", [
  "convention",
  "pitfall",
  "review_failure",
  "decision",
]);

export const repoMemories = pgTable(
  "repo_memories",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    kind: repoMemoryKind("kind").notNull().default("pitfall"),
    content: text("content").notNull(),
    source: text("source").notNull().default("eitri"),
    weight: integer("weight").notNull().default(1),
    prNumber: integer("pr_number"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    repo: index("repo_memories_repo_idx").on(t.repositoryId),
    uniq: unique("repo_memories_repo_kind_content_uniq").on(t.repositoryId, t.kind, t.content),
  }),
);

export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  repositoryId: uuid("repository_id")
    .notNull()
    .references(() => repositories.id, { onDelete: "cascade" }),
  model: text("model").notNull(),
  authMode: authMode("auth_mode").notNull().default("api_key"),
  allowedTools: jsonb("allowed_tools").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  // Forge PRs target `dev` so Eitri can auto-merge them (it refuses `main` — the
  // prod rail). Promotion dev→main stays a human merge. See docs/DEV-PREVIEW.md §7.
  baseBranch: text("base_branch").notNull().default("dev"),
  // ADR 0038 (v0 face): true when this app was born dev-first via Brokk's "Nova
  // Conversa" (Heimdall provisioned only the dev side; prod is born on the first
  // Publish). Drives the preview host — dev-first apps drop the "-dev" suffix
  // (<app>.preview…). Forward-only: legacy projects stay false and keep <app>-dev.
  devFirst: boolean("dev_first").notNull().default(false),
  // ADR 0038: the Heimdall AppRecord id this project was provisioned as — the
  // handle Publish/rollback call Heimdall with (POST /apps/:id/publish). Null for
  // legacy projects connected before the v0 face.
  heimdallAppId: text("heimdall_app_id"),
  // ADR 0038: true once prod has been born (the first "Publicar" graduated the
  // app). Flips the primary action from "Publicar" (first = provision prod) to
  // "Create PR" (subsequent = promotion PR dev→main that Eitri reviews).
  published: boolean("published").notNull().default(false),
  // Sleipnir: pinned RuntimeSpec — how the preview supervisor boots this project's
  // checkout. Decided once at connect (Huginn skill / fast-path), reused per boot.
  // Null = resolve each boot (legacy projects fall through to the Next fast-path).
  runtime: jsonb("runtime").$type<import("@brokk/core").RuntimeSpec>(),
  // ADR 0017 lane lease: the run currently holding this app's dev-checkout lease.
  // Serial per-app — claimNext skips a project whose lease is live, so one card at
  // a time mutates the shared dev checkout (different apps still run in parallel).
  // Renewed by the runner's heartbeat, cleared on run complete; lease_expires_at is
  // the crash backstop (a dead runner's lease lapses → the app is reclaimable).
  leaseRunId: uuid("lease_run_id"),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** A Mímir plan: groups the cards that compose into ONE feature PR. */
export const plans = pgTable("plans", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  prompt: text("prompt").notNull(),
  summary: text("summary").notNull(),
  rationale: text("rationale"),
  mode: planMode("mode").notNull().default("feature"),
  status: planStatus("status").notNull().default("planning"),
  featureBranch: text("feature_branch").notNull(),
  baseBranch: text("base_branch").notNull().default("dev"),
  prUrl: text("pr_url"),
  prNumber: integer("pr_number"),
  model: text("model"),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const tasks = pgTable("tasks", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  body: text("body").notNull().default(""),
  status: taskStatus("status").notNull().default("backlog"),
  kind: taskKind("kind").notNull().default("implement"),
  /** Who drives the card: 'brokk' (the forge may claim it) or 'human' (pulled out
   *  to be resolved by a person — the runner skips it). Plain text (not a pgEnum)
   *  so the boot-time self-heal DDL is a trivial ADD COLUMN. See @brokk/core TaskOwner. */
  owner: text("owner").$type<import("@brokk/core").TaskOwner>().notNull().default("brokk"),
  /** How the card was created: 'agent' (Huginn/Muninn/Resolve) or 'manual' (added
   *  by a human from the board). See @brokk/core TaskSource. */
  source: text("source").$type<import("@brokk/core").TaskSource>().notNull().default("agent"),
  priority: integer("priority").notNull().default(0),
  labels: jsonb("labels").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  baseBranch: text("base_branch"),
  createdBy: text("created_by"),
  /** Caller-supplied idempotency key (ADR 0005). from-brief returns the existing
   *  non-terminal task with this key instead of creating a racing duplicate —
   *  blinds fleet callers (Svalinn remediation) to double-click / re-scan / retry. */
  dedupeKey: text("dedupe_key"),
  prUrl: text("pr_url"),
  /** For revise tasks: the PR + head branch to update, and the round number. */
  prNumber: integer("pr_number"),
  branch: text("branch"),
  iteration: integer("iteration").notNull().default(0),
  // ── Plan composition (Mímir planner) ──
  planId: uuid("plan_id").references(() => plans.id, { onDelete: "set null" }),
  /** Stable local key within the plan; siblings reference it in dependsOn. */
  planKey: text("plan_key"),
  /** planKeys that must land before this card forges (the DAG). */
  dependsOn: jsonb("depends_on").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  /** Planner-assigned complexity (drove model/effort). */
  forca: forcaLevel("forca"),
  /** Files/areas this card is expected to touch — seed for the warm index (#5). */
  touches: jsonb("touches").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  /** The card's success condition (#3) — what the forge must make true + cover
   *  with a test. The verify loop runs it. */
  acceptance: text("acceptance"),
  /** Origin evidence: verbatim meeting excerpts Muninn stored when it created this
   *  card (AnalysisEvidence[]). The immutable source the analyst cites from. */
  evidence: jsonb("evidence").$type<import("@brokk/core").AnalysisEvidence[]>().notNull().default(sql`'[]'::jsonb`),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const agents = pgTable("agents", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  host: text("host").notNull(),
  capabilities: jsonb("capabilities").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  status: text("status").notNull().default("offline"),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const runs = pgTable("runs", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  taskId: uuid("task_id")
    .notNull()
    .references(() => tasks.id, { onDelete: "cascade" }),
  status: runStatus("status").notNull().default("queued"),
  runnerId: uuid("runner_id").references(() => agents.id, { onDelete: "set null" }),
  subscriptionId: uuid("subscription_id").references(() => subscriptions.id, { onDelete: "set null" }),
  worktree: text("worktree"),
  branch: text("branch"),
  model: text("model"),
  authMode: authMode("auth_mode"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  tokensIn: bigint("tokens_in", { mode: "number" }).notNull().default(0),
  tokensOut: bigint("tokens_out", { mode: "number" }).notNull().default(0),
  headroomSaved: bigint("headroom_saved", { mode: "number" }).notNull().default(0),
  prUrl: text("pr_url"),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Append-only. Unique (run_id, seq) keeps the stream strictly ordered. */
export const runEvents = pgTable(
  "run_events",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    type: runEventType("type").notNull(),
    payload: jsonb("payload"),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    runSeq: unique("run_events_run_id_seq_uniq").on(t.runId, t.seq),
  }),
);

/** Append-only lifecycle trail of a card (task) — one row per status/owner change,
 *  creation, or manual note. This is the "rastreio de ciclo de vida": who moved the
 *  card, when, from what to what, and why. `type` = created|status|owner|resolved|note
 *  and `from`/`to` are plain text (a status, an owner, or null) — no pgEnum so the
 *  boot-time self-heal DDL stays a trivial CREATE IF NOT EXISTS. Ordered by `at`. */
export const taskEvents = pgTable(
  "task_events",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    type: text("type").$type<import("@brokk/core").TaskEventType>().notNull(),
    from: text("from"),
    to: text("to"),
    actor: text("actor").notNull().default("system"),
    reason: text("reason"),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ task: index("task_events_task_idx").on(t.taskId) }),
);

export const users = pgTable("users", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  githubLogin: text("github_login"),
  role: text("role").notNull().default("member"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** A Max seat a user lends to the forge. `sealed_token` is AES-256-GCM at rest;
 *  only `token_preview` (last chars) is ever exposed to the UI. */
export const subscriptions = pgTable("subscriptions", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  kind: text("kind").notNull().default("max"),
  label: text("label").notNull().default("Max seat"),
  sealedToken: text("sealed_token").notNull(),
  tokenPreview: text("token_preview").notNull().default(""),
  status: text("status").notNull().default("active"),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Eitri's review ledger — one row per (repo, pr, head sha) so a PR isn't
 *  re-reviewed until it changes. */
export const reviews = pgTable(
  "reviews",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    repo: text("repo").notNull(),
    prNumber: integer("pr_number").notNull(),
    sha: text("sha").notNull(),
    verdict: text("verdict").notNull().default("comment"),
    summary: text("summary").notNull().default(""),
    /** Eitri security ward — vulnerability findings in the PR's changed files. */
    scanBlocking: integer("scan_blocking").notNull().default(0),
    scanTotal: integer("scan_total").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ uniq: unique("reviews_repo_pr_sha_uniq").on(t.repo, t.prNumber, t.sha) }),
);

export const pullRequests = pgTable("pull_requests", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  taskId: uuid("task_id")
    .notNull()
    .references(() => tasks.id, { onDelete: "cascade" }),
  runId: uuid("run_id")
    .notNull()
    .references(() => runs.id, { onDelete: "cascade" }),
  repositoryId: uuid("repository_id")
    .notNull()
    .references(() => repositories.id, { onDelete: "cascade" }),
  number: integer("number"),
  url: text("url").notNull(),
  branch: text("branch").notNull(),
  state: text("state").notNull().default("open"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── Dev previews ───────────────────────────────────────────────────────────────

/** Ephemeral dev-preview environments spun up per branch. */
export const previews = pgTable(
  "previews",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    branch: text("branch").notNull().default("dev"),
    subdomain: text("subdomain").notNull().unique(),
    url: text("url").notNull(),
    port: integer("port"),
    hauldrProject: text("hauldr_project").notNull(),
    status: previewStatus("status").notNull().default("starting"),
    /** When status='unsupported'/'failed': the human-readable reason (Huginn's
     *  explanation / the validation failure). Null otherwise. */
    detail: text("detail"),
    /** Sha the preview last checked out to build/serve (the branch tip at boot).
     *  This is what makes a preview row a *deploy* to the fleet view — Heimdall
     *  drops commitless previews as provisioning noise. Survives a slot
     *  reactivation (the row keeps its place in the feed while "Starting");
     *  the supervisor overwrites it right after the fresh checkout. */
    commitSha: text("commit_sha"),
    /** When the preview last checked out/built (stamped with commitSha) — the
     *  deploy's chronological anchor in the fleet feed. Without it a preview
     *  would sort by the SLOT's created_at (ancient) instead of the build. */
    builtAt: timestamp("built_at", { withTimezone: true }),
    pid: integer("pid"),
    /** Redacted snapshot of the env the supervisor actually loaded into this
     *  preview process (data-provider vars + app secrets + runtime env), with
     *  secret-looking values masked. Powers the "Env" inspector in the preview
     *  bar so an operator can see what a dev preview is wired to — e.g. that it
     *  points at the isolated <app>_dev Hauldr backend, never prod. */
    loadedEnv: jsonb("loaded_env").$type<Record<string, string>>(),
    /** Last time this preview saw activity — bumped on start, on a frontend
     *  heartbeat (interaction while the Brokk screen is open), and by a respin
     *  (a card's push rebuilds it). The supervisor rests a `live` preview idle
     *  past PREVIEW_IDLE_TTL_MS so a dev docker never runs unattended. */
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    /** Prevent duplicate active environments for the same (project, branch) pair.
     *  Only one row may be in 'starting' or 'live' status at a time; 'stopped'
     *  and 'failed' rows are excluded so historical records are kept intact. */
    activeUniq: uniqueIndex("previews_project_branch_active_uniq")
      .on(t.projectId, t.branch)
      .where(sql`${t.status} in ('starting', 'live')`),
  }),
);

// ── Sindri (the interactive chat agent) ─────────────────────────────────────────
// Brokkr's brother smith: where Brokkr forges a card to a PR autonomously, Sindri
// works the forge *with you* — a per-project, persistent chat that reads and writes
// the repo, runs commands, opens cards/PRs. One session = one working checkout on
// its own branch; messages are the Anthropic content blocks, replayed to resume
// the conversation. role/status/turn_state are plain text (not pgEnum) so the
// boot-time self-heal DDL — ensureChatSchema() — stays a trivial CREATE IF NOT
// EXISTS, the same pattern repo_memory_embeddings uses against the shared db_brokk.

export const chatSessions = pgTable(
  "chat_sessions",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    title: text("title").notNull().default("New chat"),
    /** active | archived */
    status: text("status").notNull().default("active"),
    /** The git branch this session's working checkout sits on. */
    branch: text("branch"),
    /** Model alias the turn runs with: haiku | sonnet | opus. */
    model: text("model").notNull().default("sonnet"),
    /** Reasoning effort: low | medium | high (null = provider default). */
    effort: text("effort"),
    /** Turn engine: claude-api | claude-cli | cursor-api | cursor-cli (legacy: afl/cli). */
    engine: text("engine").notNull().default("claude-api"),
    /** Optional Brokk Skill id pinned at session creation (skills/<id>/SKILL.md). */
    skill: text("skill"),
    /** The CLI's own session id (`--resume` continuity). engine=cli only. */
    cliSessionId: text("cli_session_id"),
    createdBy: text("created_by"),
    /** idle | running — whether a turn is live (so the UI knows to attach). */
    turnState: text("turn_state").notNull().default("idle"),
    lastTurnAt: timestamp("last_turn_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ proj: index("chat_sessions_project_idx").on(t.projectId) }),
);

/** One turn-step of a conversation, ordered by (session_id, seq). An assistant
 *  round (text + tool_use) and the following tool_result batch are separate rows,
 *  so the whole transcript replays straight back into the Messages API. */
export const chatMessages = pgTable(
  "chat_messages",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => chatSessions.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    /** user | assistant (Anthropic message role). */
    role: text("role").notNull(),
    /** Anthropic content blocks: text / tool_use / tool_result / thinking. */
    blocks: jsonb("blocks").$type<unknown[]>().notNull().default(sql`'[]'::jsonb`),
    /** Side metadata: { model, usage, stopReason }. */
    meta: jsonb("meta").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ sessionSeq: unique("chat_messages_session_seq_uniq").on(t.sessionId, t.seq) }),
);

// ── Mímir (the counselor) ──────────────────────────────────────────────────────
// Prompt intake of the forge. Migrated from Heimdall's PocketBase
// (mimir_prompts / mimir_revisoes). The history + triage are append-only — the
// app role gets INSERT/SELECT only (no UPDATE/DELETE) on those two.

/** The bank: collective, reusable refined prompts. */
export const mimirPrompts = pgTable(
  "mimir_prompts",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    title: text("title").notNull(),
    body: text("body").notNull(),
    // Was a CSV text field in PB; native array here.
    tags: jsonb("tags").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    // Author as a snapshot (not an FK) — same pattern as PB, simple to read.
    authorId: text("author_id"),
    authorName: text("author_name"),
    authorEmail: text("author_email"),
    refineCount: integer("refine_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ author: index("mimir_prompts_author_idx").on(t.authorId) }),
);

/** The history: one row per refinement (input → output → rationale). Immutable. */
export const mimirRevisions = pgTable(
  "mimir_revisions",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    input: text("input").notNull(),
    output: text("output"),
    rationale: text("rationale"),
    // Model the ENHANCER used.
    model: text("model"),
    mode: mimirMode("mode"),
    // If the author saved the result to the bank, the prompt it became.
    savedPromptId: uuid("saved_prompt_id").references(() => mimirPrompts.id, {
      onDelete: "set null",
    }),
    authorId: text("author_id"),
    authorName: text("author_name"),
    authorEmail: text("author_email"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ author: index("mimir_revisions_author_idx").on(t.authorId) }),
);

/** The triador's two-axis decision (refino + força), hung off a revision. */
export const mimirTriage = pgTable("mimir_triage", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  revisionId: uuid("revision_id").references(() => mimirRevisions.id, {
    onDelete: "cascade",
  }),
  // The Brokk task this triage's refined prompt became (set when forged). Closes
  // the loop: join the decision to its real outcome (run status + Eitri verdict).
  taskId: uuid("task_id").references(() => tasks.id, { onDelete: "set null" }),
  refinoLevel: refinoLevel("refino_level").notNull(),
  refinoConf: real("refino_conf"),
  forcaLevel: forcaLevel("forca_level").notNull(),
  forcaConf: real("forca_conf"),
  rationale: text("rationale"),
  source: triageSource("source").notNull().default("auto"),
  // Model the TRIADOR (router) used — the cheap one.
  triageModel: text("triage_model"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
