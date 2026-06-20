import type {
  Agent,
  Review,
  Run,
  RunEvent,
  RunStatus,
  Subscription,
  Task,
  TaskStatus,
  User,
} from "@brokk/core";
import { and, asc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import {
  agents,
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
    schema: { repositories, projects, tasks, agents, runs, runEvents, pullRequests, users, subscriptions, reviews },
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
    priority: row.priority,
    labels: row.labels,
    baseBranch: row.baseBranch,
    createdBy: row.createdBy,
    prUrl: row.prUrl,
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

// ── Store ─────────────────────────────────────────────────────────────────────

export interface Store {
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
}

/** Concrete Postgres store with the CRUD helpers the API + runner need. */
export function createStore(db: Db): Store {
  return {
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
