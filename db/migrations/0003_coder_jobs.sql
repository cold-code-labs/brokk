create table if not exists brokk_v2.coder_jobs (
 run_id uuid primary key references brokk_v2.artifacts(id) on delete cascade,
 project_id uuid not null references brokk_v2.projects(id) on delete cascade,
 state text not null default 'queued' check (state in ('queued','working','review','failed')),
 owner text not null default '',
 lease_hash text not null default '',
 lease_until timestamptz,
 session_id text not null default '',
 updated_at timestamptz not null default now()
);
