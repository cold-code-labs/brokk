import type {
  Agent,
  AnalysisEvidence,
  AnalysisQuestion,
  AnalysisRevision,
  AnalysisStatus,
  AnalysisStep,
  BriefStatus,
  ChatMessage,
  ChatSession,
  ChatSessionStats,
  ChatSessionStatus,
  ChatTurnState,
  ForcaLevel,
  ProjectBrief,
  MimirMode,
  MimirPrompt,
  MimirRevision,
  MimirTriage,
  Plan,
  PlanMode,
  PlanStatus,
  Preview,
  PreviewStatus,
  Project,
  RefinoLevel,
  RepoMemory,
  RepoMemoryKind,
  Repository,
  Review,
  Run,
  RunEvent,
  RunStatus,
  RuntimeSpec,
  Subscription,
  Task,
  TaskAnalysis,
  TaskEvent,
  TaskEventType,
  TaskKind,
  TaskOwner,
  TaskSource,
  TaskStatus,
  TriageSource,
  User,
} from "@brokk/core";
import { forcaToModel } from "@brokk/core";
import { and, asc, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import {
  agents,
  chatMessages,
  chatSessions,
  mimirPrompts,
  mimirRevisions,
  mimirTriage,
  plans,
  previews,
  projects,
  pullRequests,
  repoMemories,
  repositories,
  reviews,
  runEvents,
  runs,
  subscriptions,
  taskEvents,
  tasks,
  users,
} from "./schema.js";

export * from "./schema.js";

export function createDb(connectionString: string) {
  const client = postgres(connectionString);
  const db = drizzle(client, {
    schema: { repositories, repoMemories, projects, plans, tasks, taskEvents, agents, runs, runEvents, pullRequests, previews, users, subscriptions, reviews, mimirPrompts, mimirRevisions, mimirTriage, chatSessions, chatMessages },
  });
  return { db, client };
}

export type Db = ReturnType<typeof createDb>["db"];

/** A db handle OR an open transaction — both expose `.insert`. */
type DbOrTx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Append one entry to a card's lifecycle trail (task_events). The single place a
 *  lifecycle event is written — call it inside the same tx as the status/owner
 *  change so the trail can't silently diverge from the card. */
async function appendTaskEvent(
  exec: DbOrTx,
  v: {
    taskId: string;
    type: TaskEventType;
    from: string | null;
    to: string | null;
    actor: string;
    reason?: string | null;
  },
): Promise<void> {
  await exec.insert(taskEvents).values({
    taskId: v.taskId,
    type: v.type,
    from: v.from,
    to: v.to,
    actor: v.actor,
    reason: v.reason ?? null,
  });
}

// ── Row → domain mappers ──────────────────────────────────────────────────────

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

function rowToTask(row: typeof tasks.$inferSelect): Task {
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    body: row.body,
    status: row.status as TaskStatus,
    kind: row.kind as TaskKind,
    owner: (row.owner as TaskOwner) ?? "brokk",
    source: (row.source as TaskSource) ?? "agent",
    priority: row.priority,
    labels: row.labels,
    baseBranch: row.baseBranch,
    createdBy: row.createdBy,
    prUrl: row.prUrl,
    prNumber: row.prNumber,
    branch: row.branch,
    iteration: row.iteration,
    planId: row.planId,
    planKey: row.planKey,
    dependsOn: row.dependsOn,
    forca: row.forca as ForcaLevel | null,
    touches: row.touches,
    acceptance: row.acceptance,
    evidence: Array.isArray(row.evidence) ? row.evidence : [],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function rowToTaskEvent(row: typeof taskEvents.$inferSelect): TaskEvent {
  return {
    id: row.id,
    taskId: row.taskId,
    type: row.type as TaskEventType,
    from: row.from,
    to: row.to,
    actor: row.actor,
    reason: row.reason,
    at: row.at.toISOString(),
  };
}

function rowToProject(row: typeof projects.$inferSelect): Project {
  return {
    id: row.id,
    name: row.name,
    repositoryId: row.repositoryId,
    model: row.model,
    authMode: row.authMode,
    allowedTools: row.allowedTools,
    baseBranch: row.baseBranch,
    runtime: row.runtime ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function rowToPlan(row: typeof plans.$inferSelect): Plan {
  return {
    id: row.id,
    projectId: row.projectId,
    prompt: row.prompt,
    summary: row.summary,
    rationale: row.rationale,
    mode: row.mode as PlanMode,
    status: row.status as PlanStatus,
    featureBranch: row.featureBranch,
    baseBranch: row.baseBranch,
    prUrl: row.prUrl,
    prNumber: row.prNumber,
    model: row.model,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function rowToRun(row: typeof runs.$inferSelect): Run {
  return {
    id: row.id,
    taskId: row.taskId,
    status: row.status as RunStatus,
    runnerId: row.runnerId,
    subscriptionId: row.subscriptionId,
    worktree: row.worktree,
    branch: row.branch,
    model: row.model,
    authMode: row.authMode,
    startedAt: iso(row.startedAt),
    endedAt: iso(row.endedAt),
    tokensIn: row.tokensIn,
    tokensOut: row.tokensOut,
    headroomSaved: row.headroomSaved,
    prUrl: row.prUrl,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function rowToRepository(row: typeof repositories.$inferSelect): Repository {
  return {
    id: row.id,
    fullName: row.fullName,
    owner: row.owner,
    name: row.name,
    defaultBranch: row.defaultBranch,
    cloneUrl: row.cloneUrl,
    installationId: row.installationId,
    repoMap: row.repoMap,
    repoMapAt: iso(row.repoMapAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function rowToRepoMemory(row: typeof repoMemories.$inferSelect): RepoMemory {
  return {
    id: row.id,
    repositoryId: row.repositoryId,
    kind: row.kind as RepoMemoryKind,
    content: row.content,
    source: row.source,
    weight: row.weight,
    prNumber: row.prNumber,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function rowToAgent(row: typeof agents.$inferSelect): Agent {
  return {
    id: row.id,
    host: row.host,
    capabilities: row.capabilities,
    status: row.status as Agent["status"],
    lastSeenAt: iso(row.lastSeenAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function rowToUser(row: typeof users.$inferSelect): User {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    githubLogin: row.githubLogin,
    role: row.role,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Public projection — never includes the sealed token. */
function rowToSubscription(row: typeof subscriptions.$inferSelect): Subscription {
  return {
    id: row.id,
    userId: row.userId,
    kind: row.kind,
    label: row.label,
    tokenPreview: row.tokenPreview,
    status: row.status as Subscription["status"],
    lastUsedAt: iso(row.lastUsedAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function rowToEvent(row: typeof runEvents.$inferSelect): RunEvent {
  return {
    id: row.id,
    runId: row.runId,
    seq: row.seq,
    type: row.type,
    payload: row.payload,
    at: row.at.toISOString(),
  };
}

function rowToMimirPrompt(row: typeof mimirPrompts.$inferSelect): MimirPrompt {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    tags: row.tags,
    authorId: row.authorId,
    authorName: row.authorName,
    authorEmail: row.authorEmail,
    refineCount: row.refineCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function rowToMimirRevision(row: typeof mimirRevisions.$inferSelect): MimirRevision {
  return {
    id: row.id,
    input: row.input,
    output: row.output,
    rationale: row.rationale,
    model: row.model,
    mode: row.mode as MimirMode | null,
    savedPromptId: row.savedPromptId,
    authorId: row.authorId,
    authorName: row.authorName,
    authorEmail: row.authorEmail,
    createdAt: row.createdAt.toISOString(),
  };
}

export interface TriageCalibration {
  triageId: string;
  refino: RefinoLevel;
  forca: ForcaLevel;
  taskId: string;
  taskStatus: TaskStatus | null;
  runStatus: RunStatus | null;
  /** Eitri's latest verdict on the task's PR (approve/request_changes/comment). */
  eitriVerdict: string | null;
  createdAt: string;
}

function rowToMimirTriage(row: typeof mimirTriage.$inferSelect): MimirTriage {
  return {
    id: row.id,
    revisionId: row.revisionId,
    taskId: row.taskId,
    refinoLevel: row.refinoLevel as RefinoLevel,
    refinoConf: row.refinoConf,
    forcaLevel: row.forcaLevel as ForcaLevel,
    forcaConf: row.forcaConf,
    rationale: row.rationale,
    source: row.source as TriageSource,
    triageModel: row.triageModel,
    createdAt: row.createdAt.toISOString(),
  };
}

function rowToPreview(row: typeof previews.$inferSelect): Preview {
  return {
    id: row.id,
    projectId: row.projectId,
    branch: row.branch,
    subdomain: row.subdomain,
    url: row.url,
    port: row.port,
    hauldrProject: row.hauldrProject,
    mode: row.mode,
    sessionId: row.sessionId,
    workDir: row.workDir,
    status: row.status as PreviewStatus,
    detail: row.detail ?? null,
    commitSha: row.commitSha ?? null,
    builtAt: iso(row.builtAt),
    pid: row.pid,
    lastSeenAt: iso(row.lastSeenAt),
    expiresAt: iso(row.expiresAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function rowToChatSession(row: typeof chatSessions.$inferSelect): ChatSession {
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    status: row.status as ChatSessionStatus,
    branch: row.branch,
    model: row.model,
    effort: row.effort,
    createdBy: row.createdBy,
    turnState: row.turnState as ChatTurnState,
    lastTurnAt: iso(row.lastTurnAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function rowToChatMessage(row: typeof chatMessages.$inferSelect): ChatMessage {
  return {
    id: row.id,
    sessionId: row.sessionId,
    seq: row.seq,
    role: row.role as ChatMessage["role"],
    blocks: row.blocks,
    meta: row.meta ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

// ── Per-repo memory embeddings (#2 semantic recall) ──────────────────────────
// pgvector lives in db_brokk; embeddings ride in a side table `repo_memory_embeddings`
// (memory_id, embedding vector(1536), model) kept OUT of the drizzle schema so the
// fleet's `drizzle-kit push` never trips on the vector type. Embeddings come from
// the LiteLLM gateway. Everything here is best-effort: if the gateway or pgvector
// is unavailable, writes skip the embedding and reads fall back to weight order —
// the forge never breaks on a memory hiccup.

const EMBED_URL = (process.env.BROKK_EMBED_BASE_URL ?? "").replace(/\/$/, "");
const EMBED_KEY = process.env.BROKK_EMBED_API_KEY ?? "";
const EMBED_MODEL = process.env.BROKK_EMBED_MODEL ?? "text-embedding-3-small";

/** Embed text via the gateway; null on any failure (caller degrades gracefully). */
async function embedText(text: string): Promise<number[] | null> {
  if (!EMBED_URL || !EMBED_KEY) return null;
  try {
    const res = await fetch(`${EMBED_URL}/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${EMBED_KEY}` },
      body: JSON.stringify({ model: EMBED_MODEL, input: text.slice(0, 8000) }),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { data?: { embedding?: number[] }[] };
    const e = j.data?.[0]?.embedding;
    return Array.isArray(e) && e.length ? e : null;
  } catch {
    return null;
  }
}

/** pgvector literal for a float array: `[1,2,3]`. */
const toVec = (e: number[]): string => `[${e.join(",")}]`;

/** Rows from a raw `db.execute` (postgres-js returns the array directly; guard both). */
const execRows = (res: unknown): Record<string, unknown>[] =>
  Array.isArray(res) ? (res as Record<string, unknown>[]) : (((res as { rows?: unknown[] })?.rows ?? []) as Record<string, unknown>[]);

// ── Store ─────────────────────────────────────────────────────────────────────

/** What a runner gets when it claims a card: the task + its run + the resolved
 *  repository/project (the footgun fix — no more BROKK_DEFAULT_REPO), the plan it
 *  composes into (if any), and the seat's sealed token. */
export interface ClaimResult {
  task: Task;
  run: Run;
  repository: Repository;
  project: Project;
  plan: Plan | null;
  sealedToken: string | null;
  /** Per-repo memory (#2) for the forge prompt — highest-weight first. */
  memory: RepoMemory[];
}

export interface Store {
  // repositories (the GitHub repos the forge can work in)
  listRepositories(): Promise<Repository[]>;
  getRepository(id: string): Promise<Repository | null>;
  getRepositoryByFullName(fullName: string): Promise<Repository | null>;
  insertRepository(values: typeof repositories.$inferInsert): Promise<Repository>;
  /** Refresh the warm repo map (#4) — called by the runner after a forge. */
  setRepoMap(id: string, map: string): Promise<void>;

  // repo memory (#2): facts learned about a repo, persisted across runs
  /** Top memories for a repo, highest-weight first (for planner + forge context). */
  listRepoMemories(repositoryId: string, limit?: number): Promise<RepoMemory[]>;
  /** Memories for a repo most SEMANTICALLY relevant to `queryText` (pgvector cosine
   *  over the embedding side table). Falls back to {@link listRepoMemories} (weight
   *  order) when embeddings/pgvector are unavailable — never throws. */
  searchRepoMemories(repositoryId: string, queryText: string, limit?: number): Promise<RepoMemory[]>;
  /** Record a learned fact; if the exact (kind, content) already exists for the
   *  repo, bump its weight + timestamp instead of duplicating. */
  recordRepoMemory(values: {
    repositoryId: string;
    kind: RepoMemoryKind;
    content: string;
    source?: string;
    prNumber?: number | null;
  }): Promise<RepoMemory>;

  // projects
  listProjects(): Promise<(typeof projects.$inferSelect)[]>;
  getProject(id: string): Promise<typeof projects.$inferSelect | null>;
  /** Repos that at least one project forges into `dev` — Eitri's fleet watch set.
   *  Deduped by repo; each entry carries one projectId (for the revise enqueue). */
  listFleetDevRepos(): Promise<{ fullName: string; cloneUrl: string; projectId: string }[]>;
  insertProject(
    values: typeof projects.$inferInsert,
  ): Promise<typeof projects.$inferSelect>;
  /** Pin (or re-pin) a project's Sleipnir runtime — decided once at connect by
   *  Huginn / the fast-path, reused per preview boot. */
  setProjectRuntime(
    id: string,
    runtime: RuntimeSpec | null,
  ): Promise<typeof projects.$inferSelect | null>;

  // tasks
  listTasks(opts?: { projectId?: string; status?: TaskStatus }): Promise<Task[]>;
  getTask(id: string): Promise<Task | null>;
  insertTask(values: typeof tasks.$inferInsert): Promise<Task>;
  /** Idempotency lookup for from-brief (ADR 0005): a non-terminal task in this
   *  project carrying `dedupeKey`, if any. Returned instead of forging a dupe. */
  findActiveTaskByDedupeKey(projectId: string, dedupeKey: string): Promise<Task | null>;
  updateTask(id: string, patch: Partial<typeof tasks.$inferInsert>): Promise<Task>;
  /** Move a card to `to` AND record the move on its lifecycle trail (task_events).
   *  The single choke-point every status change should go through so the card's
   *  history is complete. `extra` patches other columns in the same write (e.g.
   *  prUrl on complete, acceptance on approve). A no-op move (already at `to`) is
   *  still logged. */
  transitionTask(
    id: string,
    to: TaskStatus,
    opts: { actor: string; reason?: string; extra?: Partial<typeof tasks.$inferInsert> },
  ): Promise<Task>;
  /** Hand a card to a person (owner='human' → the runner skips it) or back to the
   *  forge (owner='brokk'), logging the handoff. */
  setTaskOwner(
    id: string,
    owner: TaskOwner,
    opts: { actor: string; reason?: string },
  ): Promise<Task>;
  /** Resolve a card by hand (outside the forge): one transaction sets status=done +
   *  owner=human and records a `resolved` lifecycle event. */
  resolveByHand(id: string, opts: { actor: string; reason?: string }): Promise<Task>;
  /** The card's append-only lifecycle trail (task_events), oldest first. */
  listTaskEvents(taskId: string): Promise<TaskEvent[]>;
  /** Match a merged PR back to its forge card (by stored pr_url or pr_number). */
  findTaskForMergedPr(prUrl: string, prNumber: number): Promise<Task | null>;
  /** Is there already a revise task in flight for this PR? (dedup the loop) */
  openReviseExists(prNumber: number): Promise<boolean>;

  // users + subscriptions (Max seats)
  listUsers(): Promise<User[]>;
  getUser(id: string): Promise<User | null>;
  insertUser(values: typeof users.$inferInsert): Promise<User>;
  listSubscriptions(userId?: string): Promise<Subscription[]>;
  insertSubscription(values: typeof subscriptions.$inferInsert): Promise<Subscription>;
  /** Raw sealed token for one subscription (server-side decrypt only). */
  getSealedToken(id: string): Promise<string | null>;

  // reviews (Eitri)
  hasReview(repo: string, prNumber: number, sha: string): Promise<boolean>;
  insertReview(values: typeof reviews.$inferInsert): Promise<Review>;
  listReviews(repo?: string): Promise<Review[]>;

  // agents (runners)
  registerAgent(host: string, capabilities: string[]): Promise<Agent>;
  touchAgent(id: string): Promise<void>;

  // runs
  getRun(id: string): Promise<Run | null>;
  listRunsByTask(taskId: string): Promise<Run[]>;
  insertRun(values: typeof runs.$inferInsert): Promise<Run>;
  updateRun(id: string, patch: Partial<typeof runs.$inferInsert>): Promise<Run>;
  /** Atomically claim the next forge-ready queued task: skips cards whose plan
   *  dependencies haven't landed yet (the DAG), creates a run, flips task →
   *  running, resolves repo/project, and assigns the least-recently-used active
   *  seat (round-robin). Returns null when nothing is ready. */
  claimNext(runnerId: string): Promise<ClaimResult | null>;

  // plans (Mímir planner → cards → one PR)
  insertPlan(values: typeof plans.$inferInsert): Promise<Plan>;
  getPlan(id: string): Promise<Plan | null>;
  listPlans(opts?: { projectId?: string }): Promise<Plan[]>;
  updatePlan(id: string, patch: Partial<typeof plans.$inferInsert>): Promise<Plan>;
  getPlanTasks(planId: string): Promise<Task[]>;
  /** Set the plan's PR the first time a card pushes; returns the effective PR
   *  (idempotent — concurrent first cards converge on one). */
  setPlanPrIfUnset(planId: string, url: string, number: number | null): Promise<Plan>;
  /** If every card of the plan is in review/done, advance the plan → review. */
  maybeAdvancePlan(planId: string): Promise<Plan | null>;
  /** Match a merged PR back to its plan (the shared feature PR). */
  findPlanForMergedPr(prUrl: string, prNumber: number): Promise<Plan | null>;
  /** PR merged → mark the plan and every one of its cards done (one tx). */
  markPlanDone(planId: string, prUrl: string, prNumber: number | null): Promise<Plan>;

  // events (append-only)
  listEvents(runId: string, afterSeq?: number): Promise<RunEvent[]>;
  appendEvents(
    runId: string,
    events: { type: RunEvent["type"]; payload: unknown }[],
  ): Promise<RunEvent[]>;

  // mímir (the counselor): bank + immutable history + triage
  listMimirPrompts(opts?: { authorId?: string }): Promise<MimirPrompt[]>;
  /** Lexical search over title/body — feeds the "engineer" (archetype) retrieval. */
  searchMimirPrompts(query: string, limit?: number): Promise<MimirPrompt[]>;
  getMimirPrompt(id: string): Promise<MimirPrompt | null>;
  insertMimirPrompt(values: typeof mimirPrompts.$inferInsert): Promise<MimirPrompt>;
  updateMimirPrompt(
    id: string,
    patch: Partial<typeof mimirPrompts.$inferInsert>,
  ): Promise<MimirPrompt>;
  deleteMimirPrompt(id: string): Promise<void>;
  bumpMimirRefineCount(id: string): Promise<void>;
  listMimirRevisions(opts?: { authorId?: string; limit?: number }): Promise<MimirRevision[]>;
  insertMimirRevision(values: typeof mimirRevisions.$inferInsert): Promise<MimirRevision>;
  insertMimirTriage(values: typeof mimirTriage.$inferInsert): Promise<MimirTriage>;
  /** Link a triage decision to the Brokk task its refined prompt became. */
  linkTriageToTask(triageId: string, taskId: string): Promise<MimirTriage>;
  /** The calibration view: each linked triage with the task's real outcome
   *  (status + run + Eitri verdict) — closes the loop on the triador. */
  listTriageCalibration(): Promise<TriageCalibration[]>;

  // previews (ephemeral dev-preview environments)
  insertPreview(values: typeof previews.$inferInsert): Promise<Preview>;
  /** Atomically ensure exactly one active (starting/live) preview exists for the
   *  given (projectId, branch) pair. Relies on the partial unique index; on a
   *  conflict it returns the existing row. `created` is true on insert. */
  ensureActivePreview(
    values: typeof previews.$inferInsert,
  ): Promise<{ preview: Preview; created: boolean }>;
  getPreview(id: string): Promise<Preview | null>;
  listPreviews(opts?: { projectId?: string }): Promise<Preview[]>;
  getPreviewBySubdomain(subdomain: string): Promise<Preview | null>;
  setPreviewStatus(id: string, status: PreviewStatus, pid?: number | null): Promise<Preview>;
  /** Update arbitrary mutable fields on a preview row (used by the runner
   *  supervisor to set status, pid, port and expiresAt in one call). */
  patchPreview(
    id: string,
    patch: {
      status?: PreviewStatus;
      detail?: string | null;
      commitSha?: string | null;
      builtAt?: Date | null;
      pid?: number | null;
      port?: number | null;
      expiresAt?: Date | null;
      lastSeenAt?: Date | null;
    },
  ): Promise<Preview>;
  /** Bump last_seen_at to now and slide expires_at forward by 24 hours. */
  touchPreview(id: string): Promise<void>;
  /** Mark a preview stopped and clear its pid. */
  stopPreview(id: string): Promise<Preview>;

  // sindri (interactive chat): per-project sessions + transcript
  listChatSessions(opts?: { projectId?: string; status?: ChatSessionStatus }): Promise<ChatSession[]>;
  /** Aggregate stats (message count, token totals, last activity) keyed by
   *  session id, for the given sessions. One grouped query, no transcript load. */
  chatSessionStats(sessionIds: string[]): Promise<Map<string, ChatSessionStats>>;
  getChatSession(id: string): Promise<ChatSession | null>;
  insertChatSession(values: typeof chatSessions.$inferInsert): Promise<ChatSession>;
  updateChatSession(id: string, patch: Partial<typeof chatSessions.$inferInsert>): Promise<ChatSession>;
  deleteChatSession(id: string): Promise<void>;
  /** Clear stale `turn_state='running'` rows — the live turn registry is in-memory,
   *  so on boot any "running" session is an orphan from a crash/restart (its turn is
   *  gone). Returns how many were reset. Call once at startup. */
  resetRunningChatTurns(): Promise<number>;
  /** Full transcript for a session, ordered by seq (afterSeq for incremental). */
  listChatMessages(sessionId: string, afterSeq?: number): Promise<ChatMessage[]>;
  /** Append one transcript step at the next seq (atomic max+1). Returns the row. */
  appendChatMessage(
    sessionId: string,
    msg: { role: ChatMessage["role"]; blocks: unknown[]; meta?: Record<string, unknown> | null },
  ): Promise<ChatMessage>;

  // huginn (project discovery): one brief per project
  /** The latest discovery brief for a project, or null if never scouted. */
  getProjectBrief(projectId: string): Promise<ProjectBrief | null>;
  /** Upsert a project's brief (keyed by project_id). Pass status + any fields the
   *  scout has so far; omitted fields keep their column default on insert. */
  upsertProjectBrief(
    projectId: string,
    fields: {
      status: BriefStatus;
      mission?: string | null;
      summary?: string | null;
      built?: string[];
      missing?: string[];
      stack?: string[];
      model?: string | null;
      error?: string | null;
    },
  ): Promise<ProjectBrief>;

  // resolve (per-card analysis): the card's living, versioned understanding
  /** The latest analysis (current head) for a task, or null if never analysed. */
  getTaskAnalysis(taskId: string): Promise<TaskAnalysis | null>;
  /** Upsert the current head (status + problem + plan). Does NOT touch version /
   *  revisions / input_details — those are managed by beginAnalysisRevision. On
   *  first insert the head is version 1 with no history. */
  upsertTaskAnalysis(
    taskId: string,
    fields: {
      status: AnalysisStatus;
      revisedTitle?: string | null;
      details?: string | null;
      evidence?: AnalysisEvidence[];
      approach?: string | null;
      rationale?: string | null;
      mode?: PlanMode | null;
      steps?: TaskAnalysis["steps"];
      questions?: TaskAnalysis["questions"];
      model?: string | null;
      error?: string | null;
    },
  ): Promise<TaskAnalysis | null>;
  /** Mark the head's status (pending/failed) WITHOUT touching its content — inserts
   *  a fresh pending row if none exists. Used to flag "analysing…" and to record a
   *  failure while preserving the last good problem+plan. */
  setAnalysisStatus(taskId: string, status: AnalysisStatus, error?: string | null): Promise<void>;
  /** Start a new version: snapshot the current ready head into `revisions`, bump
   *  `version`, record the human `inputDetails` that triggered it, and set the head
   *  to pending. No-op (returns null) if there's no existing head to revise. */
  beginAnalysisRevision(taskId: string, inputDetails: string): Promise<TaskAnalysis | null>;
}

/** Concrete Postgres store with the CRUD helpers the API + runner need. */
export function createStore(db: Db): Store {
  return {
    async listRepositories() {
      const rows = await db.select().from(repositories).orderBy(asc(repositories.fullName));
      return rows.map(rowToRepository);
    },
    async getRepository(id) {
      const rows = await db.select().from(repositories).where(eq(repositories.id, id)).limit(1);
      return rows[0] ? rowToRepository(rows[0]) : null;
    },
    async getRepositoryByFullName(fullName) {
      const rows = await db
        .select()
        .from(repositories)
        .where(eq(repositories.fullName, fullName))
        .limit(1);
      return rows[0] ? rowToRepository(rows[0]) : null;
    },
    async insertRepository(values) {
      const rows = await db.insert(repositories).values(values).returning();
      return rowToRepository(rows[0]!);
    },
    async setRepoMap(id, map) {
      await db
        .update(repositories)
        .set({ repoMap: map, repoMapAt: new Date(), updatedAt: new Date() })
        .where(eq(repositories.id, id));
    },

    async listRepoMemories(repositoryId, limit = 14) {
      const rows = await db
        .select()
        .from(repoMemories)
        .where(eq(repoMemories.repositoryId, repositoryId))
        .orderBy(desc(repoMemories.weight), desc(repoMemories.updatedAt))
        .limit(limit);
      return rows.map(rowToRepoMemory);
    },
    async recordRepoMemory(values) {
      // Idempotent on (repo, kind, content): a recurring fact bumps weight rather
      // than piling up duplicates — so load-bearing lessons float to the top.
      const rows = await db
        .insert(repoMemories)
        .values({
          repositoryId: values.repositoryId,
          kind: values.kind,
          content: values.content,
          source: values.source ?? "eitri",
          prNumber: values.prNumber ?? null,
        })
        .onConflictDoUpdate({
          target: [repoMemories.repositoryId, repoMemories.kind, repoMemories.content],
          set: { weight: sql`${repoMemories.weight} + 1`, updatedAt: new Date() },
        })
        .returning();
      const mem = rowToRepoMemory(rows[0]!);
      // Best-effort: embed the lesson for semantic recall (#2). Skipped silently
      // if the gateway/pgvector is down — the row still lands, just weight-only.
      const emb = await embedText(mem.content);
      if (emb) {
        await db
          .execute(
            sql`insert into repo_memory_embeddings (memory_id, embedding, model)
                values (${mem.id}, ${toVec(emb)}::vector, ${EMBED_MODEL})
                on conflict (memory_id) do update set embedding = excluded.embedding, model = excluded.model, updated_at = now()`,
          )
          .catch(() => {});
      }
      return mem;
    },
    async searchRepoMemories(repositoryId, queryText, limit = 14) {
      const q = await embedText(queryText);
      if (q) {
        try {
          // ANN ordering in raw SQL (returns ids); rows fetched via the ORM so we
          // reuse rowToRepoMemory and never hand-map snake_case raw rows.
          const idRes = await db.execute(
            sql`select e.memory_id as id
                from repo_memory_embeddings e
                join repo_memories m on m.id = e.memory_id
                where m.repository_id = ${repositoryId}
                order by e.embedding <=> ${toVec(q)}::vector
                limit ${limit}`,
          );
          const ids = execRows(idRes)
            .map((r) => r.id as string)
            .filter(Boolean);
          if (ids.length) {
            const rows = await db.select().from(repoMemories).where(inArray(repoMemories.id, ids));
            const byId = new Map(rows.map((r) => [r.id, rowToRepoMemory(r)]));
            return ids.map((id) => byId.get(id)).filter((m): m is RepoMemory => Boolean(m));
          }
        } catch {
          // pgvector unavailable / type error → fall through to weight order.
        }
      }
      return this.listRepoMemories(repositoryId, limit);
    },

    async listProjects() {
      return db.select().from(projects);
    },
    async getProject(id) {
      const rows = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
      return rows[0] ?? null;
    },
    async setProjectRuntime(id, runtime) {
      const rows = await db
        .update(projects)
        .set({ runtime: runtime ?? null, updatedAt: new Date() })
        .where(eq(projects.id, id))
        .returning();
      return rows[0] ?? null;
    },
    async listFleetDevRepos() {
      const rows = await db
        .select({
          fullName: repositories.fullName,
          cloneUrl: repositories.cloneUrl,
          projectId: projects.id,
        })
        .from(projects)
        .innerJoin(repositories, eq(repositories.id, projects.repositoryId))
        .where(eq(projects.baseBranch, "dev"));
      const seen = new Map<string, { fullName: string; cloneUrl: string; projectId: string }>();
      for (const r of rows) if (!seen.has(r.fullName)) seen.set(r.fullName, r);
      return [...seen.values()];
    },
    async insertProject(values) {
      const rows = await db.insert(projects).values(values).returning();
      return rows[0]!;
    },

    async listTasks(opts) {
      const conds = [];
      if (opts?.projectId) conds.push(eq(tasks.projectId, opts.projectId));
      if (opts?.status) conds.push(eq(tasks.status, opts.status));
      const rows = conds.length
        ? await db.select().from(tasks).where(and(...conds))
        : await db.select().from(tasks);
      return rows.map(rowToTask);
    },
    async getTask(id) {
      const rows = await db.select().from(tasks).where(eq(tasks.id, id)).limit(1);
      return rows[0] ? rowToTask(rows[0]) : null;
    },
    async insertTask(values) {
      return db.transaction(async (tx) => {
        const rows = await tx.insert(tasks).values(values).returning();
        const task = rowToTask(rows[0]!);
        // Genesis event — the first entry on the card's lifecycle trail (same tx).
        await appendTaskEvent(tx, {
          taskId: task.id,
          type: "created",
          from: null,
          to: task.status,
          actor: task.createdBy ?? "system",
        });
        return task;
      });
    },
    async findActiveTaskByDedupeKey(projectId, dedupeKey) {
      const rows = await db
        .select()
        .from(tasks)
        .where(
          sql`${tasks.projectId} = ${projectId} AND ${tasks.dedupeKey} = ${dedupeKey} AND ${tasks.status} NOT IN ('done','failed','cancelled')`,
        )
        .orderBy(sql`${tasks.createdAt} DESC`)
        .limit(1);
      return rows[0] ? rowToTask(rows[0]) : null;
    },
    async updateTask(id, patch) {
      const rows = await db
        .update(tasks)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(tasks.id, id))
        .returning();
      if (!rows[0]) throw new Error(`task ${id} not found`);
      return rowToTask(rows[0]);
    },
    async transitionTask(id, to, opts) {
      return db.transaction(async (tx) => {
        const current = await tx
          .select({ status: tasks.status, owner: tasks.owner })
          .from(tasks)
          .where(eq(tasks.id, id))
          .limit(1);
        const from = current[0]?.status ?? null;
        const prevOwner = current[0]?.owner ?? null;
        // Queuing hands the card to the forge; a human-owned card would be stranded
        // (claimNext filters owner='brokk'), so force brokk ownership when queuing.
        const forceOwner = to === "queued" && prevOwner !== "brokk";
        const rows = await tx
          .update(tasks)
          .set({ ...opts.extra, status: to, ...(forceOwner ? { owner: "brokk" as const } : {}), updatedAt: new Date() })
          .where(eq(tasks.id, id))
          .returning();
        if (!rows[0]) throw new Error(`task ${id} not found`);
        await appendTaskEvent(tx, { taskId: id, type: "status", from, to, actor: opts.actor, reason: opts.reason });
        if (forceOwner) {
          await appendTaskEvent(tx, {
            taskId: id,
            type: "owner",
            from: prevOwner,
            to: "brokk",
            actor: opts.actor,
            reason: "enfileirado para o forge",
          });
        }
        return rowToTask(rows[0]);
      });
    },
    async setTaskOwner(id, owner, opts) {
      return db.transaction(async (tx) => {
        const current = await tx
          .select({ owner: tasks.owner })
          .from(tasks)
          .where(eq(tasks.id, id))
          .limit(1);
        const from = current[0]?.owner ?? null;
        const rows = await tx
          .update(tasks)
          .set({ owner, updatedAt: new Date() })
          .where(eq(tasks.id, id))
          .returning();
        if (!rows[0]) throw new Error(`task ${id} not found`);
        await appendTaskEvent(tx, { taskId: id, type: "owner", from, to: owner, actor: opts.actor, reason: opts.reason });
        return rowToTask(rows[0]);
      });
    },
    async resolveByHand(id, opts) {
      // #2: atomic "done by hand" — one tx sets owner=human + status=done and logs
      // both, emitting the dedicated `resolved` event. Replaces the two-write route.
      return db.transaction(async (tx) => {
        const current = await tx
          .select({ status: tasks.status, owner: tasks.owner })
          .from(tasks)
          .where(eq(tasks.id, id))
          .limit(1);
        if (!current[0]) throw new Error(`task ${id} not found`);
        const rows = await tx
          .update(tasks)
          .set({ status: "done", owner: "human", updatedAt: new Date() })
          .where(eq(tasks.id, id))
          .returning();
        if (current[0].owner !== "human") {
          await appendTaskEvent(tx, { taskId: id, type: "owner", from: current[0].owner, to: "human", actor: opts.actor, reason: "resolvido à mão" });
        }
        await appendTaskEvent(tx, {
          taskId: id,
          type: "resolved",
          from: current[0].status,
          to: "done",
          actor: opts.actor,
          reason: opts.reason ?? "resolvido fora do forge",
        });
        return rowToTask(rows[0]);
      });
    },
    async listTaskEvents(taskId) {
      const rows = await db
        .select()
        .from(taskEvents)
        .where(eq(taskEvents.taskId, taskId))
        .orderBy(asc(taskEvents.at));
      return rows.map(rowToTaskEvent);
    },
    async findTaskForMergedPr(prUrl, prNumber) {
      const url = prUrl.replace(/\/$/, "");
      const rows = await db
        .select()
        .from(tasks)
        .where(
          sql`(${tasks.prUrl} = ${url} OR ${tasks.prUrl} = ${url + "/"} OR ${tasks.prNumber} = ${prNumber})`,
        )
        .orderBy(sql`case when ${tasks.status} = 'review' then 0 else 1 end`)
        .limit(1);
      return rows[0] ? rowToTask(rows[0]) : null;
    },
    async openReviseExists(prNumber) {
      const rows = await db
        .select({ id: tasks.id })
        .from(tasks)
        .where(
          and(
            eq(tasks.kind, "revise"),
            eq(tasks.prNumber, prNumber),
            sql`${tasks.status} in ('backlog','queued','running')`,
          ),
        )
        .limit(1);
      return rows.length > 0;
    },

    async listUsers() {
      const rows = await db.select().from(users).orderBy(asc(users.createdAt));
      return rows.map(rowToUser);
    },
    async getUser(id) {
      const rows = await db.select().from(users).where(eq(users.id, id)).limit(1);
      return rows[0] ? rowToUser(rows[0]) : null;
    },
    async insertUser(values) {
      const rows = await db.insert(users).values(values).returning();
      return rowToUser(rows[0]!);
    },
    async listSubscriptions(userId) {
      const rows = userId
        ? await db.select().from(subscriptions).where(eq(subscriptions.userId, userId))
        : await db.select().from(subscriptions);
      return rows.map(rowToSubscription);
    },
    async insertSubscription(values) {
      const rows = await db.insert(subscriptions).values(values).returning();
      return rowToSubscription(rows[0]!);
    },
    async getSealedToken(id) {
      const rows = await db
        .select({ t: subscriptions.sealedToken })
        .from(subscriptions)
        .where(eq(subscriptions.id, id))
        .limit(1);
      return rows[0]?.t ?? null;
    },

    async hasReview(repo, prNumber, sha) {
      const rows = await db
        .select({ id: reviews.id })
        .from(reviews)
        .where(and(eq(reviews.repo, repo), eq(reviews.prNumber, prNumber), eq(reviews.sha, sha)))
        .limit(1);
      return rows.length > 0;
    },
    async insertReview(values) {
      const rows = await db.insert(reviews).values(values).returning();
      const r = rows[0]!;
      return {
        id: r.id,
        repo: r.repo,
        prNumber: r.prNumber,
        sha: r.sha,
        verdict: r.verdict,
        summary: r.summary,
        scanBlocking: r.scanBlocking,
        scanTotal: r.scanTotal,
        createdAt: r.createdAt.toISOString(),
      };
    },
    async listReviews(repo) {
      const rows = repo
        ? await db.select().from(reviews).where(eq(reviews.repo, repo))
        : await db.select().from(reviews);
      return rows.map((r) => ({
        id: r.id,
        repo: r.repo,
        prNumber: r.prNumber,
        sha: r.sha,
        verdict: r.verdict,
        summary: r.summary,
        scanBlocking: r.scanBlocking,
        scanTotal: r.scanTotal,
        createdAt: r.createdAt.toISOString(),
      }));
    },

    async registerAgent(host, capabilities) {
      // One row per (re)register; the runner uses the returned id for the session.
      const rows = await db
        .insert(agents)
        .values({ host, capabilities, status: "online", lastSeenAt: new Date() })
        .returning();
      return rowToAgent(rows[0]!);
    },
    async touchAgent(id) {
      await db
        .update(agents)
        .set({ lastSeenAt: new Date(), status: "online", updatedAt: new Date() })
        .where(eq(agents.id, id));
    },

    async getRun(id) {
      const rows = await db.select().from(runs).where(eq(runs.id, id)).limit(1);
      return rows[0] ? rowToRun(rows[0]) : null;
    },
    async listRunsByTask(taskId) {
      const rows = await db
        .select()
        .from(runs)
        .where(eq(runs.taskId, taskId))
        .orderBy(sql`${runs.createdAt} desc`);
      return rows.map(rowToRun);
    },
    async insertRun(values) {
      const rows = await db.insert(runs).values(values).returning();
      return rowToRun(rows[0]!);
    },
    async updateRun(id, patch) {
      const rows = await db
        .update(runs)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(runs.id, id))
        .returning();
      if (!rows[0]) throw new Error(`run ${id} not found`);
      return rowToRun(rows[0]);
    },

    async claimNext(runnerId) {
      return db.transaction(async (tx) => {
        // Lock a window of queued candidates (skip-locked so concurrent runners
        // don't fight). We then pick the first one whose plan dependencies have
        // landed — a plan card forges only after the cards it depends on are in
        // review/done (their commits are already on the feature branch).
        const candidates = await tx
          .select()
          .from(tasks)
          // owner='human' cards are pulled out for a person — the forge skips them.
          .where(and(eq(tasks.status, "queued"), eq(tasks.owner, "brokk")))
          .orderBy(sql`${tasks.priority} desc`, asc(tasks.createdAt))
          .limit(10)
          .for("update", { skipLocked: true });

        let taskRow: typeof tasks.$inferSelect | undefined;
        for (const cand of candidates) {
          if (!cand.planId || cand.dependsOn.length === 0) {
            taskRow = cand; // standalone card or no deps → always ready
            break;
          }
          const deps = await tx
            .select({ key: tasks.planKey, status: tasks.status })
            .from(tasks)
            .where(and(eq(tasks.planId, cand.planId), inArray(tasks.planKey, cand.dependsOn)));
          const ready =
            deps.length === cand.dependsOn.length &&
            deps.every((d) => d.status === "review" || d.status === "done");
          if (ready) {
            taskRow = cand;
            break;
          }
        }
        if (!taskRow) return null;

        // Resolve repo + project (the footgun fix — the runner no longer guesses
        // from BROKK_DEFAULT_REPO).
        const projRows = await tx.select().from(projects).where(eq(projects.id, taskRow.projectId)).limit(1);
        const projRow = projRows[0];
        if (!projRow) throw new Error(`task ${taskRow.id} has no project ${taskRow.projectId}`);
        const repoRows = await tx
          .select()
          .from(repositories)
          .where(eq(repositories.id, projRow.repositoryId))
          .limit(1);
        const repoRow = repoRows[0];
        if (!repoRow) throw new Error(`project ${projRow.id} has no repository ${projRow.repositoryId}`);

        const planRows = taskRow.planId
          ? await tx.select().from(plans).where(eq(plans.id, taskRow.planId)).limit(1)
          : [];
        const planRow = planRows[0];

        // Per-repo memory (#2) — highest-weight facts, injected into the forge.
        const memoryRows = await tx
          .select()
          .from(repoMemories)
          .where(eq(repoMemories.repositoryId, repoRow.id))
          .orderBy(desc(repoMemories.weight), desc(repoMemories.updatedAt))
          .limit(14);

        const updatedTask = await tx
          .update(tasks)
          .set({ status: "running", updatedAt: new Date() })
          .where(eq(tasks.id, taskRow.id))
          .returning();
        // Log the claim on the card's lifecycle trail (same tx as the flip).
        await appendTaskEvent(tx, {
          taskId: taskRow.id,
          type: "status",
          from: "queued",
          to: "running",
          actor: "forge",
          reason: `claimed by runner ${runnerId}`,
        });

        // Round-robin: grab the least-recently-used active seat and lock it so
        // two concurrent claims don't both pick the same one.
        const seat = await tx
          .select({ id: subscriptions.id, sealed: subscriptions.sealedToken })
          .from(subscriptions)
          .where(eq(subscriptions.status, "active"))
          .orderBy(sql`${subscriptions.lastUsedAt} asc nulls first`)
          .limit(1)
          .for("update", { skipLocked: true });
        const seatRow = seat[0];
        if (seatRow) {
          await tx
            .update(subscriptions)
            .set({ lastUsedAt: new Date() })
            .where(eq(subscriptions.id, seatRow.id));
        }

        const runRows = await tx
          .insert(runs)
          .values({
            taskId: taskRow.id,
            status: "running",
            runnerId,
            subscriptionId: seatRow?.id ?? null,
            model: taskRow.forca ? forcaToModel(taskRow.forca as ForcaLevel).model : null,
            startedAt: new Date(),
          })
          .returning();

        return {
          task: rowToTask(updatedTask[0]!),
          run: rowToRun(runRows[0]!),
          repository: rowToRepository(repoRow),
          project: rowToProject(projRow),
          plan: planRow ? rowToPlan(planRow) : null,
          sealedToken: seatRow?.sealed ?? null,
          memory: memoryRows.map(rowToRepoMemory),
        };
      });
    },

    async insertPlan(values) {
      const rows = await db.insert(plans).values(values).returning();
      return rowToPlan(rows[0]!);
    },
    async getPlan(id) {
      const rows = await db.select().from(plans).where(eq(plans.id, id)).limit(1);
      return rows[0] ? rowToPlan(rows[0]) : null;
    },
    async listPlans(opts) {
      const rows = opts?.projectId
        ? await db
            .select()
            .from(plans)
            .where(eq(plans.projectId, opts.projectId))
            .orderBy(desc(plans.createdAt))
        : await db.select().from(plans).orderBy(desc(plans.createdAt));
      return rows.map(rowToPlan);
    },
    async updatePlan(id, patch) {
      const rows = await db
        .update(plans)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(plans.id, id))
        .returning();
      if (!rows[0]) throw new Error(`plan ${id} not found`);
      return rowToPlan(rows[0]);
    },
    async getPlanTasks(planId) {
      const rows = await db
        .select()
        .from(tasks)
        .where(eq(tasks.planId, planId))
        .orderBy(asc(tasks.createdAt));
      return rows.map(rowToTask);
    },
    async setPlanPrIfUnset(planId, url, number) {
      // First card to push wins the PR; later cards keep the same one.
      await db
        .update(plans)
        .set({ prUrl: url, prNumber: number, status: "forging", updatedAt: new Date() })
        .where(and(eq(plans.id, planId), sql`${plans.prUrl} is null`));
      const rows = await db.select().from(plans).where(eq(plans.id, planId)).limit(1);
      if (!rows[0]) throw new Error(`plan ${planId} not found`);
      return rowToPlan(rows[0]);
    },
    async maybeAdvancePlan(planId) {
      const rows = await db.select().from(tasks).where(eq(tasks.planId, planId));
      if (rows.length === 0) return null;
      const allDone = rows.every((t) => t.status === "review" || t.status === "done");
      if (!allDone) return null;
      const updated = await db
        .update(plans)
        .set({ status: "review", updatedAt: new Date() })
        .where(and(eq(plans.id, planId), inArray(plans.status, ["planning", "forging"])))
        .returning();
      return updated[0] ? rowToPlan(updated[0]) : null;
    },
    async findPlanForMergedPr(prUrl, prNumber) {
      const url = prUrl.replace(/\/$/, "");
      const rows = await db
        .select()
        .from(plans)
        .where(
          sql`(${plans.prUrl} = ${url} OR ${plans.prUrl} = ${url + "/"} OR ${plans.prNumber} = ${prNumber})`,
        )
        .limit(1);
      return rows[0] ? rowToPlan(rows[0]) : null;
    },
    async markPlanDone(planId, prUrl, prNumber) {
      return db.transaction(async (tx) => {
        // Capture each card's real prior status BEFORE the bulk update — RETURNING
        // would yield the post-update value ('done'), losing the true `from` (#4).
        const targets = await tx
          .select({ id: tasks.id, from: tasks.status })
          .from(tasks)
          .where(and(eq(tasks.planId, planId), sql`${tasks.status} <> 'done'`));
        await tx
          .update(tasks)
          .set({ status: "done", prUrl, prNumber, updatedAt: new Date() })
          .where(and(eq(tasks.planId, planId), sql`${tasks.status} <> 'done'`));
        for (const t of targets) {
          await appendTaskEvent(tx, {
            taskId: t.id,
            type: "status",
            from: t.from,
            to: "done",
            actor: "github",
            reason: `plan PR merged (#${prNumber ?? "?"})`,
          });
        }
        const rows = await tx
          .update(plans)
          .set({ status: "done", updatedAt: new Date() })
          .where(eq(plans.id, planId))
          .returning();
        if (!rows[0]) throw new Error(`plan ${planId} not found`);
        return rowToPlan(rows[0]);
      });
    },

    async listEvents(runId, afterSeq = -1) {
      const rows = await db
        .select()
        .from(runEvents)
        .where(and(eq(runEvents.runId, runId), sql`${runEvents.seq} > ${afterSeq}`))
        .orderBy(asc(runEvents.seq));
      return rows.map(rowToEvent);
    },
    async appendEvents(runId, events) {
      if (events.length === 0) return [];
      return db.transaction(async (tx) => {
        const maxRow = await tx
          .select({ max: sql<number>`coalesce(max(${runEvents.seq}), -1)` })
          .from(runEvents)
          .where(eq(runEvents.runId, runId));
        let seq = (maxRow[0]?.max ?? -1) + 1;
        const values = events.map((e) => ({
          runId,
          seq: seq++,
          type: e.type,
          payload: e.payload as never,
        }));
        const rows = await tx.insert(runEvents).values(values).returning();
        return rows.map(rowToEvent);
      });
    },

    async listMimirPrompts(opts) {
      const rows = opts?.authorId
        ? await db
            .select()
            .from(mimirPrompts)
            .where(eq(mimirPrompts.authorId, opts.authorId))
            .orderBy(sql`${mimirPrompts.updatedAt} desc`)
        : await db.select().from(mimirPrompts).orderBy(sql`${mimirPrompts.updatedAt} desc`);
      return rows.map(rowToMimirPrompt);
    },
    async searchMimirPrompts(query, limit = 8) {
      const q = `%${query}%`;
      const rows = await db
        .select()
        .from(mimirPrompts)
        .where(sql`${mimirPrompts.title} ilike ${q} or ${mimirPrompts.body} ilike ${q}`)
        .orderBy(sql`${mimirPrompts.refineCount} desc`)
        .limit(limit);
      return rows.map(rowToMimirPrompt);
    },
    async getMimirPrompt(id) {
      const rows = await db.select().from(mimirPrompts).where(eq(mimirPrompts.id, id)).limit(1);
      return rows[0] ? rowToMimirPrompt(rows[0]) : null;
    },
    async insertMimirPrompt(values) {
      const rows = await db.insert(mimirPrompts).values(values).returning();
      return rowToMimirPrompt(rows[0]!);
    },
    async updateMimirPrompt(id, patch) {
      const rows = await db
        .update(mimirPrompts)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(mimirPrompts.id, id))
        .returning();
      if (!rows[0]) throw new Error(`mimir prompt ${id} not found`);
      return rowToMimirPrompt(rows[0]);
    },
    async deleteMimirPrompt(id) {
      await db.delete(mimirPrompts).where(eq(mimirPrompts.id, id));
    },
    async bumpMimirRefineCount(id) {
      await db
        .update(mimirPrompts)
        .set({ refineCount: sql`${mimirPrompts.refineCount} + 1`, updatedAt: new Date() })
        .where(eq(mimirPrompts.id, id));
    },
    async listMimirRevisions(opts) {
      const rows = opts?.authorId
        ? await db
            .select()
            .from(mimirRevisions)
            .where(eq(mimirRevisions.authorId, opts.authorId))
            .orderBy(sql`${mimirRevisions.createdAt} desc`)
            .limit(opts?.limit ?? 100)
        : await db
            .select()
            .from(mimirRevisions)
            .orderBy(sql`${mimirRevisions.createdAt} desc`)
            .limit(opts?.limit ?? 100);
      return rows.map(rowToMimirRevision);
    },
    async insertMimirRevision(values) {
      const rows = await db.insert(mimirRevisions).values(values).returning();
      return rowToMimirRevision(rows[0]!);
    },
    async insertMimirTriage(values) {
      const rows = await db.insert(mimirTriage).values(values).returning();
      return rowToMimirTriage(rows[0]!);
    },
    async linkTriageToTask(triageId, taskId) {
      const rows = await db
        .update(mimirTriage)
        .set({ taskId })
        .where(eq(mimirTriage.id, triageId))
        .returning();
      if (!rows[0]) throw new Error(`mimir triage ${triageId} not found`);
      return rowToMimirTriage(rows[0]);
    },
    async listTriageCalibration() {
      const tris = await db
        .select()
        .from(mimirTriage)
        .where(isNotNull(mimirTriage.taskId))
        .orderBy(desc(mimirTriage.createdAt));
      const out: TriageCalibration[] = [];
      for (const t of tris) {
        if (!t.taskId) continue;
        const task = (
          await db.select().from(tasks).where(eq(tasks.id, t.taskId)).limit(1)
        )[0];
        const lastRun = (
          await db
            .select()
            .from(runs)
            .where(eq(runs.taskId, t.taskId))
            .orderBy(desc(runs.createdAt))
            .limit(1)
        )[0];
        let eitriVerdict: string | null = null;
        if (task?.prNumber != null) {
          const rev = (
            await db
              .select()
              .from(reviews)
              .where(eq(reviews.prNumber, task.prNumber))
              .orderBy(desc(reviews.createdAt))
              .limit(1)
          )[0];
          eitriVerdict = rev?.verdict ?? null;
        }
        out.push({
          triageId: t.id,
          refino: t.refinoLevel as RefinoLevel,
          forca: t.forcaLevel as ForcaLevel,
          taskId: t.taskId,
          taskStatus: (task?.status as TaskStatus) ?? null,
          runStatus: (lastRun?.status as RunStatus) ?? null,
          eitriVerdict,
          createdAt: t.createdAt.toISOString(),
        });
      }
      return out;
    },

    async insertPreview(values) {
      const rows = await db.insert(previews).values(values).returning();
      return rowToPreview(rows[0]!);
    },
    async ensureActivePreview(values) {
      // One stable slot per app+branch, keyed by the deterministic subdomain.
      // Reactivate a stopped/failed slot (reusing its url + Hauldr project) or
      // insert a fresh one. The partial unique index on (project_id, branch)
      // WHERE status IN ('starting','live') is the concurrency backstop.
      const subdomain = values.subdomain as string;
      const found = await db
        .select()
        .from(previews)
        .where(eq(previews.subdomain, subdomain))
        .limit(1);
      const row = found[0];
      if (row) {
        if (row.status === "starting" || row.status === "live") {
          return { preview: rowToPreview(row), created: false };
        }
        const reactivated = await db
          .update(previews)
          .set({
            status: "starting",
            updatedAt: new Date(),
            // commitSha/builtAt are deliberately KEPT: the fleet feed shows the
            // slot in place ("Starting" over the previous build) instead of the
            // row vanishing; the supervisor overwrites both right after the
            // fresh checkout.
            // Refresh dev-mode metadata so a reused slot tracks the current
            // session checkout (no-op for build-mode previews).
            ...(values.mode !== undefined ? { mode: values.mode } : {}),
            ...(values.sessionId !== undefined ? { sessionId: values.sessionId } : {}),
            ...(values.workDir !== undefined ? { workDir: values.workDir } : {}),
          })
          .where(eq(previews.id, row.id))
          .returning();
        return { preview: rowToPreview(reactivated[0]!), created: false };
      }
      const inserted = await db.insert(previews).values(values).returning();
      return { preview: rowToPreview(inserted[0]!), created: true };
    },
    async getPreview(id) {
      const rows = await db.select().from(previews).where(eq(previews.id, id)).limit(1);
      return rows[0] ? rowToPreview(rows[0]) : null;
    },
    async listPreviews(opts) {
      const rows = opts?.projectId
        ? await db.select().from(previews).where(eq(previews.projectId, opts.projectId))
        : await db.select().from(previews);
      return rows.map(rowToPreview);
    },
    async getPreviewBySubdomain(subdomain) {
      const rows = await db
        .select()
        .from(previews)
        .where(eq(previews.subdomain, subdomain))
        .limit(1);
      return rows[0] ? rowToPreview(rows[0]) : null;
    },
    async setPreviewStatus(id, status, pid) {
      const patch: Partial<typeof previews.$inferInsert> = { status, updatedAt: new Date() };
      if (pid !== undefined) patch.pid = pid;
      const rows = await db.update(previews).set(patch).where(eq(previews.id, id)).returning();
      if (!rows[0]) throw new Error(`preview ${id} not found`);
      return rowToPreview(rows[0]);
    },
    async patchPreview(id, patch) {
      const set: Partial<typeof previews.$inferInsert> = { updatedAt: new Date() };
      if (patch.status !== undefined) set.status = patch.status;
      if (patch.detail !== undefined) set.detail = patch.detail ?? null;
      if (patch.commitSha !== undefined) set.commitSha = patch.commitSha ?? null;
      if (patch.builtAt !== undefined) set.builtAt = patch.builtAt ?? null;
      if (patch.pid !== undefined) set.pid = patch.pid;
      if (patch.port !== undefined) set.port = patch.port;
      if (patch.expiresAt !== undefined) set.expiresAt = patch.expiresAt ?? undefined;
      if (patch.lastSeenAt !== undefined) set.lastSeenAt = patch.lastSeenAt ?? undefined;
      const rows = await db
        .update(previews)
        .set(set)
        .where(eq(previews.id, id))
        .returning();
      if (!rows[0]) throw new Error(`preview ${id} not found`);
      return rowToPreview(rows[0]);
    },
    async touchPreview(id) {
      const now = new Date();
      const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      await db
        .update(previews)
        .set({ lastSeenAt: now, expiresAt, updatedAt: now })
        .where(eq(previews.id, id));
    },
    async stopPreview(id) {
      const rows = await db
        .update(previews)
        .set({ status: "stopped", pid: null, updatedAt: new Date() })
        .where(eq(previews.id, id))
        .returning();
      if (!rows[0]) throw new Error(`preview ${id} not found`);
      return rowToPreview(rows[0]);
    },

    async listChatSessions(opts) {
      const conds = [];
      if (opts?.projectId) conds.push(eq(chatSessions.projectId, opts.projectId));
      if (opts?.status) conds.push(eq(chatSessions.status, opts.status));
      const rows = conds.length
        ? await db.select().from(chatSessions).where(and(...conds)).orderBy(desc(chatSessions.updatedAt))
        : await db.select().from(chatSessions).orderBy(desc(chatSessions.updatedAt));
      return rows.map(rowToChatSession);
    },
    async chatSessionStats(sessionIds) {
      const out = new Map<string, ChatSessionStats>();
      if (sessionIds.length === 0) return out;
      // Token usage lives in assistant rows under meta.usage; sum input+cacheRead
      // for "in" so cache hits still count as context fed to the model.
      const rows = await db
        .select({
          sessionId: chatMessages.sessionId,
          messages: sql<number>`count(*)::int`,
          tokensIn: sql<number>`coalesce(sum(((${chatMessages.meta}->'usage'->>'inputTokens')::bigint) + ((${chatMessages.meta}->'usage'->>'cacheReadTokens')::bigint)), 0)::bigint`,
          tokensOut: sql<number>`coalesce(sum((${chatMessages.meta}->'usage'->>'outputTokens')::bigint), 0)::bigint`,
          lastMessageAt: sql<string | null>`max(${chatMessages.createdAt})`,
        })
        .from(chatMessages)
        .where(inArray(chatMessages.sessionId, sessionIds))
        .groupBy(chatMessages.sessionId);
      for (const r of rows) {
        out.set(r.sessionId, {
          messages: Number(r.messages) || 0,
          tokensIn: Number(r.tokensIn) || 0,
          tokensOut: Number(r.tokensOut) || 0,
          lastMessageAt: r.lastMessageAt ? new Date(r.lastMessageAt).toISOString() : null,
        });
      }
      return out;
    },
    async getChatSession(id) {
      const rows = await db.select().from(chatSessions).where(eq(chatSessions.id, id)).limit(1);
      return rows[0] ? rowToChatSession(rows[0]) : null;
    },
    async insertChatSession(values) {
      const rows = await db.insert(chatSessions).values(values).returning();
      return rowToChatSession(rows[0]!);
    },
    async updateChatSession(id, patch) {
      const rows = await db
        .update(chatSessions)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(chatSessions.id, id))
        .returning();
      if (!rows[0]) throw new Error(`chat session ${id} not found`);
      return rowToChatSession(rows[0]);
    },
    async deleteChatSession(id) {
      await db.delete(chatSessions).where(eq(chatSessions.id, id));
    },
    async resetRunningChatTurns() {
      const rows = await db
        .update(chatSessions)
        .set({ turnState: "idle", updatedAt: new Date() })
        .where(eq(chatSessions.turnState, "running"))
        .returning({ id: chatSessions.id });
      return rows.length;
    },
    async listChatMessages(sessionId, afterSeq = -1) {
      const rows = await db
        .select()
        .from(chatMessages)
        .where(and(eq(chatMessages.sessionId, sessionId), sql`${chatMessages.seq} > ${afterSeq}`))
        .orderBy(asc(chatMessages.seq));
      return rows.map(rowToChatMessage);
    },
    async appendChatMessage(sessionId, msg) {
      return db.transaction(async (tx) => {
        const maxRow = await tx
          .select({ max: sql<number>`coalesce(max(${chatMessages.seq}), -1)` })
          .from(chatMessages)
          .where(eq(chatMessages.sessionId, sessionId));
        const seq = (maxRow[0]?.max ?? -1) + 1;
        const rows = await tx
          .insert(chatMessages)
          .values({
            sessionId,
            seq,
            role: msg.role,
            blocks: msg.blocks as never,
            meta: (msg.meta ?? null) as never,
          })
          .returning();
        return rowToChatMessage(rows[0]!);
      });
    },

    async getProjectBrief(projectId) {
      const rows = await db.execute(
        sql`SELECT project_id, status, mission, summary, built, missing, stack, model, error, created_at, updated_at
            FROM project_briefs WHERE project_id = ${projectId} LIMIT 1`,
      );
      const row = execRows(rows)[0];
      return row ? rowToBrief(row) : null;
    },
    async upsertProjectBrief(projectId, fields) {
      const built = JSON.stringify(fields.built ?? []);
      const missing = JSON.stringify(fields.missing ?? []);
      const stack = JSON.stringify(fields.stack ?? []);
      const rows = await db.execute(
        sql`INSERT INTO project_briefs
              (project_id, status, mission, summary, built, missing, stack, model, error, updated_at)
            VALUES (${projectId}, ${fields.status}, ${fields.mission ?? null}, ${fields.summary ?? null},
              ${built}::jsonb, ${missing}::jsonb, ${stack}::jsonb, ${fields.model ?? null}, ${fields.error ?? null}, now())
            ON CONFLICT (project_id) DO UPDATE SET
              status = EXCLUDED.status,
              mission = EXCLUDED.mission,
              summary = EXCLUDED.summary,
              built = EXCLUDED.built,
              missing = EXCLUDED.missing,
              stack = EXCLUDED.stack,
              model = EXCLUDED.model,
              error = EXCLUDED.error,
              updated_at = now()
            RETURNING project_id, status, mission, summary, built, missing, stack, model, error, created_at, updated_at`,
      );
      const row = execRows(rows)[0];
      return rowToBrief(row!);
    },

    async getTaskAnalysis(taskId) {
      const rows = await db.execute(
        sql`SELECT task_id, status, version, revised_title, details, evidence, approach, rationale, mode,
                   steps, questions, input_details, revisions, model, error, created_at, updated_at
            FROM card_analyses WHERE task_id = ${taskId} LIMIT 1`,
      );
      const row = execRows(rows)[0];
      return row ? rowToAnalysis(row) : null;
    },
    async upsertTaskAnalysis(taskId, fields) {
      // The ready-result write: full problem + plan for the CURRENT version. Never
      // touches version / revisions / input_details (managed by the revision path).
      const evidence = JSON.stringify(fields.evidence ?? []);
      const steps = JSON.stringify(fields.steps ?? []);
      const questions = JSON.stringify(fields.questions ?? []);
      const rows = await db.execute(
        sql`INSERT INTO card_analyses
              (task_id, status, revised_title, details, evidence, approach, rationale, mode, steps, questions, model, error, updated_at)
            VALUES (${taskId}, ${fields.status}, ${fields.revisedTitle ?? null}, ${fields.details ?? null}, ${evidence}::jsonb,
              ${fields.approach ?? null}, ${fields.rationale ?? null}, ${fields.mode ?? null}, ${steps}::jsonb, ${questions}::jsonb,
              ${fields.model ?? null}, ${fields.error ?? null}, now())
            ON CONFLICT (task_id) DO UPDATE SET
              status = EXCLUDED.status,
              revised_title = EXCLUDED.revised_title,
              details = EXCLUDED.details,
              evidence = EXCLUDED.evidence,
              approach = EXCLUDED.approach,
              rationale = EXCLUDED.rationale,
              mode = EXCLUDED.mode,
              steps = EXCLUDED.steps,
              questions = EXCLUDED.questions,
              model = EXCLUDED.model,
              error = EXCLUDED.error,
              updated_at = now()
            RETURNING task_id, status, version, revised_title, details, evidence, approach, rationale, mode,
                      steps, questions, input_details, revisions, model, error, created_at, updated_at`,
      );
      const row = execRows(rows)[0];
      return row ? rowToAnalysis(row) : null;
    },
    async setAnalysisStatus(taskId, status, error = null) {
      // Status-only marker (pending/failed) that preserves the last good content.
      await db.execute(
        sql`INSERT INTO card_analyses (task_id, status, error)
            VALUES (${taskId}, ${status}, ${error})
            ON CONFLICT (task_id) DO UPDATE SET status = EXCLUDED.status, error = EXCLUDED.error, updated_at = now()`,
      );
    },
    async beginAnalysisRevision(taskId, inputDetails) {
      // Snapshot the current head into revisions[], bump version, record the human
      // input, and flip to pending — all preserving the content until the refine
      // overwrites it. No-op if there's no row yet (returns null → caller falls back).
      const rows = await db.execute(
        sql`UPDATE card_analyses SET
              revisions = COALESCE(revisions, '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
                'version', version,
                'title', revised_title,
                'details', details,
                'evidence', evidence,
                'approach', approach,
                'rationale', rationale,
                'mode', mode,
                'steps', steps,
                'questions', questions,
                'inputDetails', input_details,
                'createdAt', to_char(updated_at, 'YYYY-MM-DD"T"HH24:MI:SSOF')
              )),
              version = version + 1,
              input_details = ${inputDetails},
              status = 'pending',
              error = NULL,
              updated_at = now()
            WHERE task_id = ${taskId}
            RETURNING task_id, status, version, revised_title, details, evidence, approach, rationale, mode,
                      steps, questions, input_details, revisions, model, error, created_at, updated_at`,
      );
      const row = execRows(rows)[0];
      return row ? rowToAnalysis(row) : null;
    },
  };
}

/** Map a raw project_briefs row (self-healed table, not in drizzle) to the type.
 *  jsonb arrays come back already-parsed from node-postgres. */
function rowToBrief(row: Record<string, unknown>): ProjectBrief {
  const arr = (v: unknown): string[] => (Array.isArray(v) ? (v as string[]) : []);
  const iso = (v: unknown): string =>
    v instanceof Date ? v.toISOString() : typeof v === "string" ? v : new Date().toISOString();
  return {
    projectId: String(row.project_id),
    status: String(row.status) as BriefStatus,
    mission: (row.mission as string | null) ?? null,
    summary: (row.summary as string | null) ?? null,
    built: arr(row.built),
    missing: arr(row.missing),
    stack: arr(row.stack),
    model: (row.model as string | null) ?? null,
    error: (row.error as string | null) ?? null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.map(str).filter(Boolean) : []);
function mapSteps(v: unknown): AnalysisStep[] {
  return Array.isArray(v)
    ? (v as Record<string, unknown>[]).map((s) => ({
        title: str(s.title),
        touches: strList(s.touches),
        detail: str(s.detail),
        acceptance: str(s.acceptance),
      }))
    : [];
}
function mapEvidence(v: unknown): AnalysisEvidence[] {
  return Array.isArray(v)
    ? (v as Record<string, unknown>[])
        .map((e) => ({
          quote: str(e.quote),
          speaker: (e.speaker as string | null) ?? null,
          note: (e.note as string | null) ?? null,
        }))
        .filter((e) => e.quote)
    : [];
}
/** Coerce stored questions to the current shape. Tolerates the legacy `string[]`
 *  (pre-options analyses) by lifting each into a question with no options. */
function mapQuestions(v: unknown): AnalysisQuestion[] {
  return Array.isArray(v)
    ? v
        .map((q): AnalysisQuestion =>
          typeof q === "string"
            ? { question: q.trim(), options: [] }
            : {
                question: str((q as Record<string, unknown>).question),
                options: strList((q as Record<string, unknown>).options).slice(0, 2),
              },
        )
        .filter((q) => q.question)
    : [];
}

/** Map a raw card_analyses row (self-healed table, not in drizzle) to the type.
 *  jsonb columns come back already-parsed from node-postgres. */
function rowToAnalysis(row: Record<string, unknown>): TaskAnalysis {
  const iso = (v: unknown): string =>
    v instanceof Date ? v.toISOString() : typeof v === "string" ? v : new Date().toISOString();
  const revisions: AnalysisRevision[] = Array.isArray(row.revisions)
    ? (row.revisions as Record<string, unknown>[]).map((r) => ({
        version: typeof r.version === "number" ? r.version : Number(r.version) || 0,
        title: (r.title as string | null) ?? null,
        details: (r.details as string | null) ?? null,
        evidence: mapEvidence(r.evidence),
        approach: (r.approach as string | null) ?? null,
        rationale: (r.rationale as string | null) ?? null,
        mode: (r.mode as PlanMode | null) ?? null,
        steps: mapSteps(r.steps),
        questions: mapQuestions(r.questions),
        inputDetails: (r.inputDetails as string | null) ?? null,
        createdAt: str(r.createdAt) || iso(row.updated_at),
      }))
    : [];
  return {
    taskId: String(row.task_id),
    status: String(row.status) as AnalysisStatus,
    version: typeof row.version === "number" ? row.version : Number(row.version) || 1,
    revisedTitle: (row.revised_title as string | null) ?? null,
    details: (row.details as string | null) ?? null,
    evidence: mapEvidence(row.evidence),
    approach: (row.approach as string | null) ?? null,
    rationale: (row.rationale as string | null) ?? null,
    mode: (row.mode as PlanMode | null) ?? null,
    steps: mapSteps(row.steps),
    questions: mapQuestions(row.questions),
    inputDetails: (row.input_details as string | null) ?? null,
    revisions,
    model: (row.model as string | null) ?? null,
    error: (row.error as string | null) ?? null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

/** Phase-0 zero-config bootstrap mirror of drizzle-kit, so `pnpm dev` runs
 *  without a migration step. Real migrations come from `drizzle-kit generate`. */
export async function ensureSchema(db: Db): Promise<void> {
  await db.execute(sql`CREATE EXTENSION IF NOT EXISTS pgcrypto;`);
  // NOTE: enums + tables are authored in schema.ts; for production use
  // `pnpm --filter @brokk/db db:push`. This bootstrap is intentionally a no-op
  // placeholder so the API can boot against a freshly-pushed database.

  // Per-repo memory embeddings (#2 semantic recall) live in a side table kept OUT
  // of the drizzle schema (so `drizzle-kit push` never trips on the pgvector type).
  // Ensure it on every boot so it SELF-HEALS: a hand-applied table doesn't survive
  // a shared-cluster image rebuild, but the app re-creates it here. Best-effort —
  // if pgvector is unavailable the table is skipped and memory recall falls back to
  // weight order (see searchRepoMemories), so the forge never breaks.
  try {
    await db.execute(sql`CREATE EXTENSION IF NOT EXISTS vector;`).catch(() => {});
    await db.execute(sql`CREATE TABLE IF NOT EXISTS repo_memory_embeddings (
      memory_id uuid PRIMARY KEY REFERENCES repo_memories(id) ON DELETE CASCADE,
      embedding vector(1536) NOT NULL,
      model text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    );`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS repo_memory_embeddings_hnsw
      ON repo_memory_embeddings USING hnsw (embedding vector_cosine_ops);`);
  } catch {
    // pgvector not available (extension/type missing) — semantic recall stays
    // dormant; weight-ordered memory still works.
  }

  await ensureChatSchema(db);
}

/** Self-heal the Sindri chat tables (sessions + transcript). Idempotent
 *  CREATE IF NOT EXISTS — the same boot-time pattern repo_memory_embeddings uses,
 *  so we never depend on `drizzle-kit push` (which hangs on new tables against the
 *  shared, Hauldr-backed db_brokk). role/status/turn_state are plain text, so no
 *  enum DDL is needed. Called from ensureSchema() and standalone by Sindri's boot. */
export async function ensureChatSchema(db: Db): Promise<void> {
  await db.execute(sql`CREATE TABLE IF NOT EXISTS chat_sessions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title text NOT NULL DEFAULT 'New chat',
    status text NOT NULL DEFAULT 'active',
    branch text,
    model text NOT NULL DEFAULT 'sonnet',
    effort text,
    created_by text,
    turn_state text NOT NULL DEFAULT 'idle',
    last_turn_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );`);
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS chat_sessions_project_idx ON chat_sessions (project_id);`,
  );
  await db.execute(sql`CREATE TABLE IF NOT EXISTS chat_messages (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id uuid NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
    seq integer NOT NULL,
    role text NOT NULL,
    blocks jsonb NOT NULL DEFAULT '[]'::jsonb,
    meta jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT chat_messages_session_seq_uniq UNIQUE (session_id, seq)
  );`);
  // Huginn discovery brief — one row per project (PK = project_id), upserted by
  // each scout. Self-healed (never in drizzle) to avoid the push-hang on new
  // db_brokk tables; JSON arrays for built/missing/stack keep it schema-light.
  // Sindri live-preview columns on the (drizzle-pushed) previews table. Added
  // here as idempotent ALTERs so they self-heal on boot without a push (which
  // hangs on db_brokk). Guarded: if previews doesn't exist yet (fresh DB before
  // push), skip — the next push creates it with these columns from schema.ts.
  try {
    await db.execute(
      sql`ALTER TABLE previews ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'build';`,
    );
    await db.execute(
      sql`ALTER TABLE previews ADD COLUMN IF NOT EXISTS session_id uuid REFERENCES chat_sessions(id) ON DELETE SET NULL;`,
    );
    await db.execute(sql`ALTER TABLE previews ADD COLUMN IF NOT EXISTS work_dir text;`);
    // Sleipnir runtime: the unsupported reason + the pinned per-project RuntimeSpec.
    await db.execute(sql`ALTER TABLE previews ADD COLUMN IF NOT EXISTS detail text;`);
    // The sha a preview last built/served — what promotes a preview row to a
    // "deploy" in Heimdall's fleet view (commitless previews are dropped there).
    await db.execute(sql`ALTER TABLE previews ADD COLUMN IF NOT EXISTS commit_sha text;`);
    await db.execute(sql`ALTER TABLE previews ADD COLUMN IF NOT EXISTS built_at timestamptz;`);
    await db.execute(sql`ALTER TABLE projects ADD COLUMN IF NOT EXISTS runtime jsonb;`);
    // Add the 'unsupported' preview status. ADD VALUE can't run inside a txn block,
    // so it's its own statement; IF NOT EXISTS makes it idempotent on reboot.
    await db.execute(sql`ALTER TYPE preview_status ADD VALUE IF NOT EXISTS 'unsupported';`);
    // Resolve: the 'analysis' card status. Same ADD VALUE self-heal (push hangs on
    // db_brokk); AFTER 'backlog' keeps the enum order matching the board columns.
    await db.execute(sql`ALTER TYPE task_status ADD VALUE IF NOT EXISTS 'analysis' AFTER 'backlog';`);
    // Nv2 QA: the live-acceptance receipt run event. Same ADD VALUE self-heal.
    await db.execute(sql`ALTER TYPE run_event_type ADD VALUE IF NOT EXISTS 'acceptance';`);
    // Origin evidence (Muninn verbatim excerpts) on the drizzle-pushed tasks table.
    await db.execute(sql`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS evidence jsonb NOT NULL DEFAULT '[]'::jsonb;`);
    // from-brief idempotency key (ADR 0005). Self-healed column + a partial lookup
    // index over only the non-terminal statuses (the ones dedup considers "active").
    await db.execute(sql`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS dedupe_key text;`);
    await db.execute(
      sql`CREATE INDEX IF NOT EXISTS tasks_dedupe_key_active_idx ON tasks (project_id, dedupe_key) WHERE status NOT IN ('done','failed','cancelled');`,
    );
    // Card ownership + origin (Phase A lifecycle). Plain text (no ADD VALUE dance);
    // 'brokk' = forge may claim it, 'human' = pulled out for a person to resolve;
    // source 'agent'|'manual'. Backfilled to the safe defaults on existing rows.
    await db.execute(sql`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS owner text NOT NULL DEFAULT 'brokk';`);
    await db.execute(sql`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'agent';`);
    // Versioned analysis columns (the living understanding). Self-healed ADD COLUMNs
    // so existing card_analyses rows gain them without a push.
    await db.execute(sql`ALTER TABLE card_analyses ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;`);
    await db.execute(sql`ALTER TABLE card_analyses ADD COLUMN IF NOT EXISTS revised_title text;`);
    await db.execute(sql`ALTER TABLE card_analyses ADD COLUMN IF NOT EXISTS details text;`);
    await db.execute(sql`ALTER TABLE card_analyses ADD COLUMN IF NOT EXISTS evidence jsonb NOT NULL DEFAULT '[]'::jsonb;`);
    await db.execute(sql`ALTER TABLE card_analyses ADD COLUMN IF NOT EXISTS input_details text;`);
    await db.execute(sql`ALTER TABLE card_analyses ADD COLUMN IF NOT EXISTS revisions jsonb NOT NULL DEFAULT '[]'::jsonb;`);
  } catch (err) {
    console.warn(
      "[db] previews dev-mode columns ALTER skipped:",
      err instanceof Error ? err.message : err,
    );
  }

  // Card lifecycle trail (Phase A). Append-only; self-healed (kept out of the
  // drizzle push path, like project_briefs) so it survives an image rebuild.
  await db.execute(sql`CREATE TABLE IF NOT EXISTS task_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    type text NOT NULL,
    "from" text,
    "to" text,
    actor text NOT NULL DEFAULT 'system',
    reason text,
    at timestamptz NOT NULL DEFAULT now()
  );`);
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS task_events_task_idx ON task_events (task_id);`,
  );

  await db.execute(sql`CREATE TABLE IF NOT EXISTS project_briefs (
    project_id uuid PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    status text NOT NULL DEFAULT 'pending',
    mission text,
    summary text,
    built jsonb NOT NULL DEFAULT '[]'::jsonb,
    missing jsonb NOT NULL DEFAULT '[]'::jsonb,
    stack jsonb NOT NULL DEFAULT '[]'::jsonb,
    model text,
    error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );`);

  // Resolve per-card analysis — one row per task (PK = task_id), upserted by the
  // scout. Same self-heal rationale as project_briefs (kept out of drizzle to dodge
  // the push-hang on new db_brokk tables); JSON steps/questions keep it schema-light.
  await db.execute(sql`CREATE TABLE IF NOT EXISTS card_analyses (
    task_id uuid PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
    status text NOT NULL DEFAULT 'pending',
    version integer NOT NULL DEFAULT 1,
    revised_title text,
    details text,
    evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
    approach text,
    rationale text,
    mode text,
    steps jsonb NOT NULL DEFAULT '[]'::jsonb,
    questions jsonb NOT NULL DEFAULT '[]'::jsonb,
    input_details text,
    revisions jsonb NOT NULL DEFAULT '[]'::jsonb,
    model text,
    error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );`);
}
