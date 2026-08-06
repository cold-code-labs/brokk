// O ledger — a peça que o Brokk não tem hoje (ADR 0087 §Contexto).
//
// PoC: SQLite (node:sqlite, zero dep). O schema espelha 1:1 o DDL Postgres da
// ADR (sql/0001_findings.sql) para o port ao db_brokk/Drizzle ser mecânico.
// O que importa provar aqui não é o banco — é que um achado tem IDENTIDADE
// (fingerprint), HISTÓRICO (finding_events) e que triagem é PERMANENTE.

import { DatabaseSync } from "node:sqlite"
import { randomUUID } from "node:crypto"
import { mkdirSync } from "node:fs"
import path from "node:path"

const DDL = `
create table if not exists findings (
  id             text primary key,
  project        text not null,
  repo           text not null,
  lens_id        text not null,
  axis           text not null,
  source         text not null default 'brokk',
  fingerprint    text not null,
  severity       text not null,
  confidence     real,
  title          text not null,
  body           text,
  file_path      text,
  line_start     integer,
  line_end       integer,
  proof_kind     text not null,
  proof_ref      text,
  status         text not null,
  triage_reason  text,
  triaged_by     text,
  triaged_at     text,
  task_id        text,
  pr_url         text,
  first_seen_run text,
  last_seen_run  text,
  seen_count     integer not null default 1,
  created_at     text not null,
  updated_at     text not null,
  unique (project, lens_id, fingerprint)
);

create table if not exists finding_events (
  id         text primary key,
  finding_id text not null references findings(id) on delete cascade,
  kind       text not null,
  actor      text,
  reason     text,
  payload    text,
  created_at text not null
);

create table if not exists runs (
  id         text primary key,
  project    text not null,
  repo       text not null,
  lens_id    text not null,
  layer      text not null,
  status     text not null,
  stats      text,
  started_at text not null,
  ended_at   text
);

create index if not exists findings_project_status on findings(project, status);
create index if not exists finding_events_finding on finding_events(finding_id);
`

const now = () => new Date().toISOString()

export class Ledger {
  constructor(file) {
    mkdirSync(path.dirname(file), { recursive: true })
    this.db = new DatabaseSync(file)
    this.db.exec("pragma journal_mode = wal")
    this.db.exec(DDL)
  }

  close() {
    this.db.close()
  }

  event(findingId, kind, { actor, reason, payload } = {}) {
    this.db
      .prepare(
        `insert into finding_events (id, finding_id, kind, actor, reason, payload, created_at)
         values (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(randomUUID(), findingId, kind, actor ?? null, reason ?? null,
           payload ? JSON.stringify(payload) : null, now())
  }

  startRun({ project, repo, lensId, layer }) {
    const id = randomUUID()
    this.db
      .prepare(`insert into runs (id, project, repo, lens_id, layer, status, started_at)
                values (?, ?, ?, ?, ?, 'running', ?)`)
      .run(id, project, repo, lensId, layer, now())
    return id
  }

  endRun(runId, status, stats) {
    this.db
      .prepare(`update runs set status = ?, stats = ?, ended_at = ? where id = ?`)
      .run(status, JSON.stringify(stats ?? {}), now(), runId)
  }

  /**
   * O coração do dedupe. Retorna o veredito do ledger para este achado:
   *   'new'        — nunca visto; publica
   *   'recurring'  — já aberto; NÃO republica, só carimba last_seen/seen_count
   *   'suppressed' — já triado como wontfix/false_positive; NUNCA volta a aparecer
   *   'regression' — estava fixed e voltou; publica com destaque (métrica-chave da ADR)
   */
  upsert(f, runId) {
    const row = this.db
      .prepare(`select * from findings where project = ? and lens_id = ? and fingerprint = ?`)
      .get(f.project, f.lensId, f.fingerprint)

    if (!row) {
      const id = randomUUID()
      this.db
        .prepare(
          `insert into findings (id, project, repo, lens_id, axis, source, fingerprint,
             severity, confidence, title, body, file_path, line_start, line_end,
             proof_kind, proof_ref, status, first_seen_run, last_seen_run, created_at, updated_at)
           values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'open',?,?,?,?)`,
        )
        .run(id, f.project, f.repo, f.lensId, f.axis, f.source ?? "brokk", f.fingerprint,
             f.severity, f.confidence ?? null, f.title, f.body ?? null, f.filePath ?? null,
             f.lineStart ?? null, f.lineEnd ?? null, f.proofKind, f.proofRef ?? null,
             runId, runId, now(), now())
      this.event(id, "seen", { actor: f.lensId, payload: { first: true } })
      return { verdict: "new", id, row: null }
    }

    this.db
      .prepare(`update findings set last_seen_run = ?, seen_count = seen_count + 1,
                  updated_at = ?, line_start = ?, line_end = ? where id = ?`)
      .run(runId, now(), f.lineStart ?? row.line_start, f.lineEnd ?? row.line_end, row.id)
    this.event(row.id, "seen", { actor: f.lensId })

    if (row.status === "wontfix" || row.status === "false_positive" || row.status === "suppressed") {
      return { verdict: "suppressed", id: row.id, row }
    }
    if (row.status === "fixed") {
      this.db.prepare(`update findings set status = 'open' where id = ?`).run(row.id)
      this.event(row.id, "regression", { actor: f.lensId, reason: "fingerprint reapareceu após fixed" })
      return { verdict: "regression", id: row.id, row }
    }
    return { verdict: "recurring", id: row.id, row }
  }

  /** Triagem SEMPRE exige justificativa — a regra que o Svalinn provou (ADR 0087 §6). */
  triage(findingId, status, { reason, actor }) {
    if (!reason || !String(reason).trim()) {
      throw new Error("triagem exige justificativa — sem reason, não grava")
    }
    const r = this.db
      .prepare(`update findings set status = ?, triage_reason = ?, triaged_by = ?,
                  triaged_at = ?, updated_at = ? where id = ?`)
      .run(status, reason, actor ?? "cli", now(), now(), findingId)
    if (r.changes === 0) throw new Error(`finding ${findingId} não existe`)
    this.event(findingId, "triaged", { actor, reason, payload: { status } })
  }

  list({ project, status, lensId, limit = 50 } = {}) {
    const where = []
    const args = []
    if (project) { where.push("project = ?"); args.push(project) }
    if (status) { where.push("status = ?"); args.push(status) }
    if (lensId) { where.push("lens_id = ?"); args.push(lensId) }
    const sql = `select * from findings ${where.length ? "where " + where.join(" and ") : ""}
       order by case severity when 'critical' then 0 when 'high' then 1 when 'medium' then 2
                              when 'low' then 3 else 4 end, updated_at desc limit ?`
    return this.db.prepare(sql).all(...args, limit)
  }

  /** accept_rate por lente — a métrica que rebaixa lente ruidosa (ADR 0087 §6). */
  acceptRates(project) {
    return this.db
      .prepare(
        `select lens_id,
                count(*) as published,
                sum(case when status in ('triaged','dispatched','awaiting_verification','fixed') then 1 else 0 end) as accepted,
                sum(case when status in ('wontfix','false_positive','suppressed') then 1 else 0 end) as rejected
           from findings where project = ? group by lens_id`,
      )
      .all(project)
  }
}
