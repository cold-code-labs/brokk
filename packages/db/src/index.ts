import type {
  Agent,
  ForcaLevel,
  MimirMode,
  MimirPrompt,
  MimirRevision,
  MimirTriage,
  Preview,
  PreviewStatus,
  RefinoLevel,
  Repository,
  Review,
  Run,
  RunEvent,
  RunStatus,
  Subscription,
  Task,
  TaskKind,
  TaskStatus,
  TriageSource,
  User,
} from "@brokk/core";
import { and, asc, desc, eq, isNotNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import {
  agents,
  mimirPrompts,
  mimirRevisions,
  mimirTriage,
  previews,
  projects,
  pullRequests,
  repositories,
  reviews,
  runEvents,
  runs,
  subscriptions,
  tasks,
  users,
} from "./schema.js";

export * from "./schema.js";

export function createDb(connectionString: string) {
  const client = postgres(connectionString);
  const db = drizzle(client, {
    schema: { repositories, projects, tasks, agents, runs, runEvents, pullRequests, previews, users, subscriptions, reviews, mimirPrompts, mimirRevisions, mimirTriage },
  });
  return { db, client };
}

export type Db = ReturnType<typeof createDb>["db"];

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
    priority: row.priority,
    labels: row.labels,
    baseBranch: row.baseBranch,
    createdBy: row.createdBy,
    prUrl: row.prUrl,
    prNumber: row.prNumber,
    branch: row.branch,
    iteration: row.iteration,
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
    status: row.status as PreviewStatus,
    pid: row.pid,
    lastSeenAt: iso(row.lastSeenAt),
    expiresAt: iso(row.expiresAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ── Store ─────────────────────────────────────────────────────────────────────

export interface Store {
  // repositories (the GitHub repos the forge can work in)
  listRepositories(): Promise<Repository[]>;
  getRepository(id: string): Promise<Repository | null>;
  getRepositoryByFullName(fullName: string): Promise<Repository | null>;
  insertRepository(values: typeof repositories.$inferInsert): Promise<Repository>;

  // projects
  listProjects(): Promise<(typeof projects.$inferSelect)[]>;
  getProject(id: string): Promise<typeof projects.$inferSelect | null>;
  insertProject(
    values: typeof projects.$inferInsert,
  ): Promise<typeof projects.$inferSelect>;

  // tasks
  listTasks(opts?: { projectId?: string; status?: TaskStatus }): Promise<Task[]>;
  getTask(id: string): Promise<Task | null>;
  insertTask(values: typeof tasks.$inferInsert): Promise<Task>;
  updateTask(id: string, patch: Partial<typeof tasks.$inferInsert>): Promise<Task>;
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
  /** Atomically claim the next queued task: create a run, flip task → running,
   *  and assign the least-recently-used active seat (round-robin). Returns the
   *  seat's sealed token for the control plane to decrypt, or null seat. */
  claimNext(
    runnerId: string,
  ): Promise<{ task: Task; run: Run; sealedToken: string | null } | null>;

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

    async listProjects() {
      return db.select().from(projects);
    },
    async getProject(id) {
      const rows = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
      return rows[0] ?? null;
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
      const rows = await db.insert(tasks).values(values).returning();
      return rowToTask(rows[0]!);
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
      // Pick the oldest, highest-priority queued task and lock it so concurrent
      // runners don't grab the same one.
      return db.transaction(async (tx) => {
        const picked = await tx
          .select()
          .from(tasks)
          .where(eq(tasks.status, "queued"))
          .orderBy(sql`${tasks.priority} desc`, asc(tasks.createdAt))
          .limit(1)
          .for("update", { skipLocked: true });
        const taskRow = picked[0];
        if (!taskRow) return null;

        const updatedTask = await tx
          .update(tasks)
          .set({ status: "running", updatedAt: new Date() })
          .where(eq(tasks.id, taskRow.id))
          .returning();

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
            startedAt: new Date(),
          })
          .returning();

        return {
          task: rowToTask(updatedTask[0]!),
          run: rowToRun(runRows[0]!),
          sealedToken: seatRow?.sealed ?? null,
        };
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
          .set({ status: "starting", updatedAt: new Date() })
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
  };
}

/** Phase-0 zero-config bootstrap mirror of drizzle-kit, so `pnpm dev` runs
 *  without a migration step. Real migrations come from `drizzle-kit generate`. */
export async function ensureSchema(db: Db): Promise<void> {
  await db.execute(sql`CREATE EXTENSION IF NOT EXISTS pgcrypto;`);
  // NOTE: enums + tables are authored in schema.ts; for production use
  // `pnpm --filter @brokk/db db:push`. This bootstrap is intentionally a no-op
  // placeholder so the API can boot against a freshly-pushed database.
}
