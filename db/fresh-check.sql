-- Run only against an isolated, freshly created database before fixture rows.
DO $check$
DECLARE t record; n bigint;
BEGIN
 IF (SELECT count(*) FROM pg_tables WHERE schemaname='brokk') <> 12 THEN RAISE EXCEPTION 'fresh_table_contract'; END IF;
 FOR t IN SELECT tablename FROM pg_tables WHERE schemaname='brokk' LOOP
  EXECUTE format('SELECT count(*) FROM %I.%I','brokk',t.tablename) INTO n;
  IF n<>0 THEN RAISE EXCEPTION 'fresh_schema_contains_seed_data: %',t.tablename; END IF;
 END LOOP;
 IF has_schema_privilege('brokk_runtime','brokk','CREATE') THEN RAISE EXCEPTION 'runtime_can_create_objects'; END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='brokk_runtime' AND (rolsuper OR rolcreaterole OR rolcreatedb OR rolbypassrls)) THEN RAISE EXCEPTION 'privileged_runtime'; END IF;
 IF EXISTS(SELECT 1 FROM pg_tables pt JOIN pg_namespace n ON n.nspname=pt.schemaname JOIN pg_class c ON c.relnamespace=n.oid AND c.relname=pt.tablename WHERE pt.schemaname='brokk' AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity OR pg_get_userbyid(c.relowner)='brokk_runtime')) THEN RAISE EXCEPTION 'runtime_security_contract'; END IF;
END;
$check$;
SET ROLE brokk_runtime;
SELECT count(*) FROM brokk.projects;
RESET ROLE;
