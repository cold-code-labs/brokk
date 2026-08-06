-- ADR 0087 — ledger de achados no db_brokk.
-- O PoC roda em SQLite (src/ledger.mjs) com este mesmo shape; este arquivo é o
-- alvo do port. Nada de sec entra aqui por padrão: findings de segurança ficam
-- em db_svalinn e chegam federados (source = 'svalinn'), ADR 0079.

create table if not exists findings (
  id             uuid primary key default gen_random_uuid(),
  project_id     uuid not null references projects(id) on delete cascade,
  repo           text not null,
  lens_id        text not null,
  axis           text not null check (axis in ('review','qa','ui','arch','product','sec')),
  source         text not null default 'brokk' check (source in ('brokk','svalinn')),
  fingerprint    text not null,
  cluster_id     uuid,
  severity       text not null check (severity in ('critical','high','medium','low','info')),
  confidence     numeric,
  title          text not null,
  body           text,
  file_path      text,
  line_start     integer,
  line_end       integer,
  proof_kind     text not null check (proof_kind in ('executable','advisory')),
  proof_ref      text,
  status         text not null default 'open' check (status in (
                   'open','triaged','dispatched','awaiting_verification',
                   'fixed','wontfix','false_positive','suppressed')),
  triage_reason  text,
  triaged_by     text,
  triaged_at     timestamptz,
  task_id        uuid references tasks(id) on delete set null,
  pr_url         text,
  first_seen_run uuid,
  last_seen_run  uuid,
  seen_count     integer not null default 1,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint findings_dedupe unique (project_id, lens_id, fingerprint),
  -- ADR 0087 §3: achado advisory nunca chega a 'fixed' sozinho.
  constraint findings_advisory_nao_fecha check (
    not (proof_kind = 'advisory' and status = 'fixed' and triaged_by is null)
  ),
  -- ADR 0087 §6: triagem sem justificativa não existe.
  constraint findings_triagem_justificada check (
    status not in ('wontfix','false_positive','suppressed')
    or (triage_reason is not null and length(btrim(triage_reason)) > 0)
  )
);

create index if not exists findings_project_status on findings (project_id, status);
create index if not exists findings_lens on findings (lens_id);
create index if not exists findings_fingerprint on findings (fingerprint);

create table if not exists finding_events (
  id         uuid primary key default gen_random_uuid(),
  finding_id uuid not null references findings(id) on delete cascade,
  kind       text not null check (kind in (
               'seen','verified','refuted','triaged','dispatched',
               'regression','verified_fixed')),
  actor      text,
  reason     text,
  payload    jsonb,
  created_at timestamptz not null default now()
);

create index if not exists finding_events_finding on finding_events (finding_id, created_at desc);
