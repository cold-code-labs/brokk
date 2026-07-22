import { Hono } from "hono";
import postgres from "postgres";
import { actorFrom, canSeeProject } from "../actor.js";
import type { AppDeps } from "../app.js";

/**
 * Studio — a read-only bridge from a Sindri preview to the Hauldr database
 * backing it. Resolves the preview's Hauldr project → its internal Postgres URL
 * (via the control-plane), opens a short-lived READ-ONLY connection, and serves
 * schema introspection + paginated row reads. Everything runs server-side; the
 * dbUrl and the connection never leave the API. P0 = viewer only (no writes, no
 * provisioning). See ADR 0012.
 */

/** Resolve a Hauldr project name to a Postgres URL — through Heimdall's SCOPED
 *  agent API, not the data plane's management key.
 *
 *  This used to GET the control plane directly with `HAULDR_TOKEN`, which reads
 *  the superuser DSN of ANY project on the fleet — a client's production
 *  database included — to browse one dev lane. Heimdall refuses anything but
 *  `<app>_dev` of a registered app, so the Studio can now only reach what it was
 *  ever meant to.
 *
 *  Prefers `adminDbUrl` (the owner connection) so the viewer sees every table
 *  regardless of RLS or the authenticator's grants, which vary by cluster;
 *  falls back to `dbUrl`. Null when unconfigured, out of scope, or not ready. */
async function resolveDbUrl(deps: AppDeps, project: string): Promise<string | null> {
  if (!deps.heimdallAgentUrl || !deps.heimdallAgentToken) return null;
  const res = await fetch(
    `${deps.heimdallAgentUrl.replace(/\/$/, "")}/api/agent/lanes/${encodeURIComponent(project)}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${deps.heimdallAgentToken}` },
      signal: AbortSignal.timeout(60_000),
    },
  ).catch(() => null);
  if (!res || !res.ok) return null;
  const payload = (await res.json().catch(() => null)) as
    | { project?: { connection?: { adminDbUrl?: string | null; dbUrl?: string } | null } | null }
    | null;
  const c = payload?.project?.connection;
  return c?.adminDbUrl ?? c?.dbUrl ?? null;
}

/** Open a short-lived, READ-ONLY connection to a project db, run `fn`, close it.
 *  Per-request (no pool): the Studio is low-QPS and this keeps P0 leak-free; a
 *  cached pool is a later optimization. */
async function withDb<T>(dbUrl: string, fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const sql = postgres(dbUrl, {
    max: 1,
    connect_timeout: 10,
    idle_timeout: 5,
    prepare: false,
    connection: {
      application_name: "brokk-studio",
      statement_timeout: 10000,
      // Defense-in-depth: the whole session refuses writes. P0 only SELECTs.
      default_transaction_read_only: true,
    },
    onnotice: () => {},
  });
  try {
    return await fn(sql);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

/** The database name from a Postgres URL (the label the panel shows). */
function dbNameOf(dbUrl: string): string | undefined {
  try {
    return new URL(dbUrl).pathname.replace(/^\//, "") || undefined;
  } catch {
    return undefined;
  }
}

export function studioRoutes(deps: AppDeps): Hono {
  const r = new Hono();
  const enabled = Boolean(deps.heimdallAgentUrl && deps.heimdallAgentToken);

  async function loadPreviewForActor(c: { req: { param: (n: string) => string; header: (n: string) => string | undefined } }) {
    const preview = await deps.store.getPreview(c.req.param("previewId"));
    if (!preview) return null;
    const actor = actorFrom(c as never);
    const project = await deps.store.getProject(preview.projectId);
    if (!project || !canSeeProject(actor, project.logtoOrgId)) return null;
    return preview;
  }

  /** GET /studio/:previewId/overview — is there a reachable Hauldr db behind this
   *  preview? Never throws on a down db — reports connected:false with a reason so
   *  the panel can render a hero instead of an error. */
  r.get("/:previewId/overview", async (c) => {
    const preview = await loadPreviewForActor(c);
    if (!preview) return c.json({ error: "preview not found" }, 404);
    const hauldrProject = preview.hauldrProject;
    if (!enabled) return c.json({ connected: false, hauldrProject, reason: "studio-disabled" });
    const dbUrl = await resolveDbUrl(deps, hauldrProject);
    if (!dbUrl) return c.json({ connected: false, hauldrProject, reason: "no-database" });
    try {
      const rows = await withDb(dbUrl, (sql) =>
        sql<{ count: number }[]>`
          select count(*)::int as count
          from information_schema.tables
          where table_schema = 'public' and table_type = 'BASE TABLE'`,
      );
      return c.json({
        connected: true,
        hauldrProject,
        database: dbNameOf(dbUrl),
        tableCount: rows[0]?.count ?? 0,
      });
    } catch (e) {
      return c.json({
        connected: false,
        hauldrProject,
        reason: "unreachable",
        error: e instanceof Error ? e.message : String(e),
      });
    }
  });

  /** GET /studio/:previewId/tables — public base tables + live-row estimate. */
  r.get("/:previewId/tables", async (c) => {
    const preview = await loadPreviewForActor(c);
    if (!preview) return c.json({ error: "preview not found" }, 404);
    if (!enabled) return c.json({ error: "studio disabled" }, 503);
    const dbUrl = await resolveDbUrl(deps, preview.hauldrProject);
    if (!dbUrl) return c.json({ error: "no database" }, 409);
    const tables = await withDb(dbUrl, (sql) =>
      sql<{ name: string; rows: number }[]>`
        select t.table_name as name,
               coalesce(s.n_live_tup, 0)::int as rows
        from information_schema.tables t
        left join pg_stat_user_tables s
          on s.relname = t.table_name and s.schemaname = t.table_schema
        where t.table_schema = 'public' and t.table_type = 'BASE TABLE'
        order by t.table_name`,
    );
    return c.json({ tables });
  });

  /** GET /studio/:previewId/tables/:table?limit&offset — columns + a page of rows
   *  (read-only). The table name is validated against the public schema before it
   *  is interpolated as an identifier. */
  r.get("/:previewId/tables/:table", async (c) => {
    const preview = await loadPreviewForActor(c);
    if (!preview) return c.json({ error: "preview not found" }, 404);
    if (!enabled) return c.json({ error: "studio disabled" }, 503);
    const dbUrl = await resolveDbUrl(deps, preview.hauldrProject);
    if (!dbUrl) return c.json({ error: "no database" }, 409);

    const table = c.req.param("table");
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 50) || 50, 1), 200);
    const offset = Math.max(Number(c.req.query("offset") ?? 0) || 0, 0);

    const result = await withDb(dbUrl, async (sql) => {
      const ok = await sql`
        select 1 from information_schema.tables
        where table_schema = 'public' and table_name = ${table}
          and table_type = 'BASE TABLE' limit 1`;
      if (ok.length === 0) return null;
      const columns = await sql<{ name: string; type: string; nullable: boolean }[]>`
        select column_name as name, data_type as type, (is_nullable = 'YES') as nullable
        from information_schema.columns
        where table_schema = 'public' and table_name = ${table}
        order by ordinal_position`;
      // `table` is validated above; sql(table) escapes it as an identifier.
      const rows = await sql`select * from ${sql(table)} limit ${limit + 1} offset ${offset}`;
      const hasMore = rows.length > limit;
      return { columns, rows: rows.slice(0, limit), hasMore };
    });

    if (!result) return c.json({ error: "table not found" }, 404);
    return c.json({ table, ...result, limit, offset });
  });

  return r;
}
