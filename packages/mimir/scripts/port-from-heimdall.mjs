// ─────────────────────────────────────────────────────────────────────────────
// One-shot port: Heimdall's PocketBase (SQLite) → Brokk's Postgres.
// Snapshot, not sync — run once during cutover, after the target schema exists
// (`pnpm --filter @brokk/db db:push`) and before tearing Mímir down in Heimdall.
//
// Steps:
//   1. Copy the PB db out of the Heimdall container:
//        sudo docker cp <heimdall-container>:/app/pocketbase/pb_data/data.db /tmp/heimdall.db
//   2. From the brokk repo root:
//        MIMIR_PB_DB=/tmp/heimdall.db \
//        BROKK_DATABASE_URL=postgres://brokk:...@host:5432/brokk \
//        node packages/mimir/scripts/port-from-heimdall.mjs
//
// Maps: PB ids → fresh UUIDs (saved_prompt_id remapped via an in-memory table);
//       tags CSV → text[] (jsonb); PB datetimes → timestamptz.
// Requires Node >= 22.5 (node:sqlite). Set WIPE=0 to append instead of replacing.
// ─────────────────────────────────────────────────────────────────────────────

import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import postgres from "postgres";

const PB = process.env.MIMIR_PB_DB;
const PG = process.env.BROKK_DATABASE_URL;
if (!PB || !PG) {
  console.error("set MIMIR_PB_DB (path to PB data.db) and BROKK_DATABASE_URL");
  process.exit(1);
}

const toTags = (csv) =>
  (csv ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const toTs = (v) => {
  const s = v ? String(v).trim() : "";
  return s || new Date().toISOString();
};

const sqlite = new DatabaseSync(PB, { readOnly: true });
const sql = postgres(PG);

const prompts = sqlite.prepare("select * from mimir_prompts").all();
const revisoes = sqlite.prepare("select * from mimir_revisoes").all();

if (process.env.WIPE !== "0") {
  await sql`delete from mimir_triage`;
  await sql`delete from mimir_revisions`;
  await sql`delete from mimir_prompts`;
}

// pb prompt id → new uuid, so the history's saved_prompt_id still resolves.
const idMap = new Map();

for (const p of prompts) {
  const id = randomUUID();
  idMap.set(p.id, id);
  await sql`
    insert into mimir_prompts
      (id, title, body, tags, author_id, author_name, author_email, refine_count, created_at, updated_at)
    values
      (${id}, ${p.title}, ${p.body}, ${JSON.stringify(toTags(p.tags))}::jsonb,
       ${p.author_id || null}, ${p.author_name || null}, ${p.author_email || null},
       ${p.refine_count || 0}, ${toTs(p.created)}, ${toTs(p.updated)})`;
}

for (const r of revisoes) {
  await sql`
    insert into mimir_revisions
      (id, input, output, rationale, model, mode, saved_prompt_id, author_id, author_name, author_email, created_at)
    values
      (${randomUUID()}, ${r.input}, ${r.output || null}, ${r.rationale || null},
       ${r.model || null}, ${r.mode || null}, ${idMap.get(r.saved_prompt_id) ?? null},
       ${r.author_id || null}, ${r.author_name || null}, ${r.author_email || null}, ${toTs(r.created)})`;
}

console.log(`ported ${prompts.length} prompts, ${revisoes.length} revisions`);
await sql.end();
