CREATE TABLE IF NOT EXISTS brokk_v2.environments (
  project_id uuid PRIMARY KEY REFERENCES brokk_v2.projects(id),
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
REVOKE ALL ON brokk_v2.environments FROM PUBLIC;
