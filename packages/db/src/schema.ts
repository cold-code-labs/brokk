import { sql } from "drizzle-orm";
import {
  bigint,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
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
]);

export const authMode = pgEnum("auth_mode", ["api_key", "subscription"]);

export const taskKind = pgEnum("task_kind", ["implement", "revise"]);

// ── Tables ───────────────────────────────────────────────────────────────────

export const repositories = pgTable("repositories", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  fullName: text("full_name").notNull().unique(),
  owner: text("owner").notNull(),
  name: text("name").notNull(),
  defaultBranch: text("default_branch").notNull().default("main"),
  cloneUrl: text("clone_url").notNull(),
  installationId: text("installation_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  repositoryId: uuid("repository_id")
    .notNull()
    .references(() => repositories.id, { onDelete: "cascade" }),
  model: text("model").notNull(),
  authMode: authMode("auth_mode").notNull().default("api_key"),
  allowedTools: jsonb("allowed_tools").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  baseBranch: text("base_branch").notNull().default("main"),
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
  priority: integer("priority").notNull().default(0),
  labels: jsonb("labels").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  baseBranch: text("base_branch"),
  createdBy: text("created_by"),
  prUrl: text("pr_url"),
  /** For revise tasks: the PR + head branch to update, and the round number. */
  prNumber: integer("pr_number"),
  branch: text("branch"),
  iteration: integer("iteration").notNull().default(0),
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
