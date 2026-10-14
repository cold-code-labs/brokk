create table if not exists brokk_v2.coder_workers (
 owner text primary key,
 revision text not null,
 ready boolean not null default false,
 repositories jsonb not null default '[]',
 updated_at timestamptz not null default now()
);
