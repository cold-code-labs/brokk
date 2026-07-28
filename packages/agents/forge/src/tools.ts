// ─────────────────────────────────────────────────────────────────────────────
// Brokkr's DB hand — apply_migration (ADR 0017 §6b, Fase 4: escreve→aplica→registra).
//
// Schema is code. To change an app's database the agent NEVER runs raw DDL: it
// calls apply_migration, which (1) writes db/migrations/NNNN_<slug>.sql into the
// checkout AND (2) applies that SQL to the app's shared dev database through the
// Hauldr control-plane migrate endpoint — the SAME endpoint, tracked under the
// SAME name, that the app's deploy-time scripts/hauldr-migrate.mjs uses. So when
// the change later lands on `dev` and the dev-build deploys, the entrypoint finds
// the name already in _app_migrations and skips it: the file and the live schema
// are identical by construction — zero drift, no re-execution.
//
// Dev-lane only: composed exactly when the run carries a `migration` context (a
// `<app>_dev` DB + control-plane creds). The PR path has no dev DB, no tool.
// ─────────────────────────────────────────────────────────────────────────────

import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { PartialExecutor, ToolDef } from "@brokk/afl";

/** Where apply_migration writes + applies. */
export interface MigrationToolContext {
  /** The checkout the migration file is written into. */
  cwd: string;
  /** Control-plane base url (HAULDR_CONTROL_URL). */
  controlUrl: string;
  /** Bearer for the migrate endpoint — the per-project migrate token Heimdall
   *  returns (accepted by POST /v1/projects/:name/migrate). Never the retired
   *  data-plane management key (HAULDR_TOKEN). */
  token: string;
  /** The project whose dev DB receives the DDL, e.g. `logcheck_dev`. */
  project: string;
}

const MIGRATIONS_DIR = "db/migrations";

export const MIGRATION_TOOL_DEF: ToolDef = {
  name: "apply_migration",
  description:
    "Change this app's DATABASE SCHEMA. Schema is code in db/migrations/*.sql applied to a " +
    "shared dev database. This tool writes the migration file AND applies it to the dev DB " +
    "immediately, so the running preview reflects it at once. ALWAYS use this for DDL " +
    "(create/alter/drop table, column, index, view, function, RLS policy, trigger, grant). " +
    "NEVER run DDL any other way (psql/bash, a DB client) and NEVER write to db/migrations/ " +
    "with write_file/edit_file — this tool owns that path so the file and the live database " +
    "can never drift. Prefer ADDITIVE changes (add a table/column; `create ... if not exists`); " +
    "a destructive change (drop/rename) can break the running dev-build that shares this DB. " +
    "One migration per change. On error the file is removed — fix the SQL and call again. " +
    "Already-applied migrations are skipped on deploy.",
  input_schema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description:
          "Short snake_case slug for the change, e.g. `add_orders_table` or " +
          "`orders_add_status_column`. A sortable timestamp prefix is added automatically, so " +
          "migrations created in parallel PRs never collide — do not add your own number.",
      },
      sql: {
        type: "string",
        description:
          "The migration SQL. Unqualified objects land in `public` (search_path is pinned by " +
          "the control plane); reference the auth schema explicitly as `auth.*`. PostgREST is " +
          "reloaded automatically after DDL — do not add a NOTIFY statement.",
      },
    },
    required: ["name", "sql"],
  },
};

/** A collision-free, lexicographically-sortable migration prefix: a UTC timestamp
 *  (YYYYMMDDHHMMSS) + a short random suffix. Sequential `NNNN` prefixes made
 *  PARALLEL PRs collide — two agents on separate worktrees each read the same
 *  "max + 1" and produced the SAME `0002_…` file, so their migrations clashed on
 *  merge (an unbreakable rebase livelock). Timestamps are what Rails/Django/Prisma
 *  use for exactly this reason; existing NNNN files still sort first ('0' < '2') so
 *  applied history is preserved, and the random suffix guards same-second parallel
 *  creates. The control plane tracks migrations by name, not a contiguous sequence,
 *  so gaps are fine. */
function migrationPrefix(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  const ts =
    String(d.getUTCFullYear()) +
    p(d.getUTCMonth() + 1) +
    p(d.getUTCDate()) +
    p(d.getUTCHours()) +
    p(d.getUTCMinutes()) +
    p(d.getUTCSeconds());
  return `${ts}${randomBytes(2).toString("hex")}`;
}

/** A partial executor exposing apply_migration; null for any other tool so it
 *  composes on top of the generic hands via composeExecutors. */
export function makeMigrationExecutor(ctx: MigrationToolContext): PartialExecutor {
  const base = ctx.controlUrl.replace(/\/+$/, "");
  return async (name, input) => {
    if (name !== "apply_migration") return null;

    const slug = String(input.name ?? "")
      .trim()
      .toLowerCase()
      .replace(/\.sql$/, "")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
    const sql = String(input.sql ?? "");
    if (!slug) return { ok: false, content: "apply_migration needs a non-empty `name`" };
    if (!sql.trim()) return { ok: false, content: "apply_migration needs a non-empty `sql` body" };

    const dir = join(ctx.cwd, MIGRATIONS_DIR);
    const migName = `${migrationPrefix()}_${slug}`;
    const file = join(dir, `${migName}.sql`);

    // Write the file first, then apply. If the apply fails (bad SQL / rejected DDL
    // / control plane down), remove the file — an unapplied migration left in the
    // tree would abort the dev-build deploy (`set -e` in docker-entrypoint.sh).
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(file, sql.endsWith("\n") ? sql : `${sql}\n`, "utf8");

    const url = `${base}/v1/projects/${encodeURIComponent(ctx.project)}/migrate?name=${encodeURIComponent(migName)}`;
    let res: Awaited<ReturnType<typeof fetch>>;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${ctx.token}`, "Content-Type": "text/plain" },
        body: sql,
      });
    } catch (e) {
      await fs.rm(file, { force: true });
      return { ok: false, content: `apply_migration: control plane unreachable — ${(e as Error).message}` };
    }

    const text = await res.text();
    if (!res.ok) {
      await fs.rm(file, { force: true });
      if (res.status === 401 || res.status === 403) {
        return {
          ok: false,
          content:
            `apply_migration: AUTH FAILED (${res.status}). Credential rejected for ` +
            `${ctx.project} — use the per-project migrate token from Heimdall, not ` +
            `HAULDR_TOKEN. Do not retry with the same token. ${text}`.trim(),
        };
      }
      return { ok: false, content: `apply_migration: ${res.status} ${text}` };
    }

    let applied = true;
    try {
      applied = (JSON.parse(text) as { applied?: boolean }).applied !== false;
    } catch {
      /* non-JSON body — assume applied */
    }
    return {
      ok: true,
      content: `${applied ? "applied" : "already applied"} db/migrations/${migName}.sql → ${ctx.project}`,
    };
  };
}
