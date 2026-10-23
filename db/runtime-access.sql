-- Server-only product access. Application code owns organization authorization.
-- No anon/authenticated privileges, cross-product access, schema creation or ownership.
REVOKE ALL ON SCHEMA brokk FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA brokk FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA brokk FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA brokk FROM PUBLIC;
GRANT USAGE ON SCHEMA brokk TO brokk_runtime;
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA brokk TO brokk_runtime;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA brokk TO brokk_runtime;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA brokk TO brokk_runtime;
DO $access$
DECLARE t record;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname='brokk' LOOP
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY','brokk',t.tablename);
    EXECUTE format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY','brokk',t.tablename);
    EXECUTE format('DROP POLICY IF EXISTS runtime_access ON %I.%I','brokk',t.tablename);
    EXECUTE format('CREATE POLICY runtime_access ON %I.%I TO brokk_runtime USING (true) WITH CHECK (true)','brokk',t.tablename);
  END LOOP;
END;
$access$;
