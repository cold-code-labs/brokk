-- Fresh Supabase contract. No historical rows or demo seeds.
CREATE SCHEMA IF NOT EXISTS brokk;
REVOKE ALL ON SCHEMA brokk FROM PUBLIC;
CREATE TABLE IF NOT EXISTS brokk.organizations (id uuid PRIMARY KEY, name text NOT NULL, external_id text UNIQUE, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS brokk.members (organization_id uuid NOT NULL REFERENCES brokk.organizations(id), email text NOT NULL, role text NOT NULL CHECK(role IN ('admin','operator','client','reader')), PRIMARY KEY(organization_id,email));
CREATE TABLE IF NOT EXISTS brokk.projects (id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES brokk.organizations(id), name text NOT NULL, objective text NOT NULL DEFAULT '', status text NOT NULL DEFAULT 'planning', version integer NOT NULL DEFAULT 1, repository text, external_id text, updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(organization_id,external_id));
CREATE TABLE IF NOT EXISTS brokk.artifacts (id uuid PRIMARY KEY, project_id uuid NOT NULL REFERENCES brokk.projects(id), kind text NOT NULL CHECK(kind IN ('scope','task','screen','token','component','review','call','feedback','run')), title text NOT NULL, status text NOT NULL, data jsonb NOT NULL, version integer NOT NULL DEFAULT 1, author text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS brokk.versions (artifact_id uuid NOT NULL REFERENCES brokk.artifacts(id), version integer NOT NULL, snapshot jsonb NOT NULL, actor text NOT NULL, at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(artifact_id,version));
CREATE TABLE IF NOT EXISTS brokk.events (id uuid PRIMARY KEY, project_id uuid NOT NULL REFERENCES brokk.projects(id), actor text NOT NULL, action text NOT NULL, detail text NOT NULL, at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS brokk.sessions (digest text PRIMARY KEY, identity jsonb NOT NULL, expires_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS brokk.tickets (digest text PRIMARY KEY, identity jsonb NOT NULL, project_id uuid NOT NULL REFERENCES brokk.projects(id), expires_at timestamptz NOT NULL);
CREATE INDEX IF NOT EXISTS artifacts_project_idx ON brokk.artifacts(project_id);
CREATE INDEX IF NOT EXISTS events_project_idx ON brokk.events(project_id,at);
CREATE UNIQUE INDEX IF NOT EXISTS run_request_idx ON brokk.artifacts(project_id,(data->>'requestKey')) WHERE kind='run';
REVOKE ALL ON ALL TABLES IN SCHEMA brokk FROM PUBLIC;

CREATE TABLE IF NOT EXISTS brokk.environments (
  project_id uuid PRIMARY KEY REFERENCES brokk.projects(id),
  slug text NOT NULL UNIQUE,
  repository text NOT NULL UNIQUE,
  profile text NOT NULL DEFAULT 'application',
  preview_url text NOT NULL UNIQUE,
  production_url text NOT NULL DEFAULT '',
  state text NOT NULL DEFAULT 'configured',
  step text NOT NULL DEFAULT 'configured',
  detail text NOT NULL DEFAULT '',
  data_ready boolean NOT NULL DEFAULT false,
  ci_state text NOT NULL DEFAULT 'pending',
  commit text NOT NULL DEFAULT '',
  deployed_commit text NOT NULL DEFAULT '',
  resources jsonb NOT NULL DEFAULT '{"application":"","dataProject":"","deployment":""}',
  lease text NOT NULL DEFAULT '',
  lease_until timestamptz,
  version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON brokk.environments FROM PUBLIC;

create table if not exists brokk.coder_jobs (
 run_id uuid primary key references brokk.artifacts(id) on delete cascade,
 project_id uuid not null references brokk.projects(id) on delete cascade,
 state text not null default 'queued' check (state in ('queued','working','review','failed')),
 owner text not null default '',
 lease_hash text not null default '',
 lease_until timestamptz,
 session_id text not null default '',
 updated_at timestamptz not null default now()
);

create table if not exists brokk.coder_workers (
 owner text primary key,
 revision text not null,
 ready boolean not null default false,
 repositories jsonb not null default '[]',
 updated_at timestamptz not null default now()
);

CREATE TABLE IF NOT EXISTS brokk.extension_grants (
  digest text PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES brokk.projects(id) ON DELETE CASCADE,
  call_id uuid NOT NULL REFERENCES brokk.artifacts(id) ON DELETE CASCADE,
  identity jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked boolean NOT NULL DEFAULT false,
  capture_until timestamptz,
  captures integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS extension_call_idx ON brokk.extension_grants(call_id);
REVOKE ALL ON brokk.extension_grants FROM PUBLIC;
