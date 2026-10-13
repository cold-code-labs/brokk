# Brokk v2

- Product: organization-scoped development workspace; Portuguese user copy, English code.
- React + Vite SPA, Hono API, Postgres. Serve API and SPA from one origin.
- No browser database access, credentials, shell, infrastructure controls or arbitrary code execution.
- Identity uses OIDC; roles and memberships come from the database. Development login is forbidden in production.
- All artifacts and provider sessions inherit project organization access. Preserve versions, original feedback and audit trails.
- Operators direct product work; clients review; only technical administrators configure memberships and repository allowlists.
- Devin and Daily integrations are server-only, bounded, and fail visibly when unavailable. Never retry ambiguous paid session creation automatically.
- Scope and review approval do not authorize deploying client code. Preview lanes and Coder are deferred.
- Checks: pnpm typecheck, pnpm lint, pnpm test, pnpm build.
- Release: PR, green Woodpecker CI, merge, official Coolify deployment and production verification. Never GitHub Actions.
- Legacy code is preserved in Git history; reconstruction plan is docs/v2/PLANO.md.
