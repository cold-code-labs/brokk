# Brokk v2

- Product: organization-scoped development workspace; Portuguese user copy, English code.
- React + Vite SPA, Hono API, Postgres. Serve API and SPA from one origin.
- No browser database access, credentials, shell, infrastructure controls or arbitrary code execution.
- Identity uses OIDC; roles and memberships come from the database. Development login is forbidden in production.
- All artifacts and provider sessions inherit project organization access. Preserve versions, original feedback and audit trails.
- Operators direct product work; clients review; only technical administrators configure memberships and repository allowlists.
- Devin and Daily integrations are server-only, bounded, and fail visibly when unavailable. Never retry ambiguous paid session creation automatically.
- Scope and review approval do not authorize production deployment of client code. Preview preparation, checked PR integration and preview publication use the bounded server recipe. Coder and production promotion remain separate.
- Checks: pnpm typecheck, pnpm lint, pnpm test, pnpm build.
- Release: PR, green Woodpecker CI, merge, official Coolify deployment and production verification. Never GitHub Actions.
- Legacy code is preserved in Git history; reconstruction plan is docs/v2/PLANO.md.

- Design system changes must preserve typed aliases, project-scoped component/screen links, dependency versions and review invalidation. Read docs/v2/DESIGN-SYSTEM.md. Preview and exports use the same shared contract; never execute operator-supplied HTML, CSS or JS.
