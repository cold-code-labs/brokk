# Supabase fresh cut

`db/schema.sql` is the empty `brokk` contract, without the legacy Hauldr model or demo seeds. No rows are imported from either `db_brokk` or the previous dedicated `brokk_v2` database. All twelve current tables are required by live features and remain; historical migration files are retired in Git history.

Apply schema and `db/runtime-access.sql` with a migration credential before deployment. The production web process only verifies schema readiness and connects over TLS with `brokk_runtime`; it cannot create schemas/tables. Authorization and organization checks remain in the server. Local development/tests may initialize their isolated database automatically.

The cut is explicitly destructive: stop old executor writes, switch the reviewed/green deployment to the empty Supabase schema, verify health, login and empty project lists, and then remove the retired product databases and worker job state. Do not resume ambiguous historical paid launches. Client application databases referenced by historical previews are not Brokk's own database and are not deleted by this cut.

A4 login and the existing delivery infrastructure remain. New projects and grants are created through normal authorized flows. Hauldr preview provisioning is an infrastructure capability for separate application databases, not the persistence of this Brokk installation; its removal requires a separate provider change.

Long-lived containers use the official IPv4 session pooler (port 5432), with the product role and project suffix in the username, TLS verification and a small connection pool. Do not use transaction pooling for prepared statements.

TLS trusts the public Supabase Root 2021 CA distributed by the official dashboard. Brokk loads the bundled CA through Node; PostgREST mounts the inline Compose config and uses `sslrootcert=/etc/supabase-ca.crt`. Certificate verification must remain enabled.
