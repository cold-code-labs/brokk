CREATE TABLE IF NOT EXISTS brokk_v2.extension_grants (
  digest text PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES brokk_v2.projects(id) ON DELETE CASCADE,
  call_id uuid NOT NULL REFERENCES brokk_v2.artifacts(id) ON DELETE CASCADE,
  identity jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked boolean NOT NULL DEFAULT false,
  capture_until timestamptz,
  captures integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS extension_call_idx ON brokk_v2.extension_grants(call_id);
REVOKE ALL ON brokk_v2.extension_grants FROM PUBLIC;
