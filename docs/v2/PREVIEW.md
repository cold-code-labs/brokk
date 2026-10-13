# Preview through Brokk

The development workspace owns a bounded preview recipe for each project. Server adapters coordinate GitHub, the existing self-hosted Woodpecker, Hauldr's development namespace and Coolify's established preview lane. Provider credentials and resource handles remain server-side.

## Operator flow

1. Create a project, define the scope and design contract, and approve the intended scope.
2. Prepare preview. A project without a repository gets the configured private Vite template and a stable generated identity. Existing repositories are bound once by a technical administrator.
3. Brokk cuts preview from the default branch, enrolls the repository in Woodpecker, provisions a fresh development namespace and prepares a separate application. No production data is copied.
4. Prepare development and inspect the exact context. Its checksum binds the confirmation to the scope, task, repository, environment and design contract. Changes require preparation again.
5. Devin creates a feature branch and a PR targeting preview. It receives code/specifications, not management credentials or database access.
6. Inspect the delivery. Integration requires the exact head SHA, the authorized repository and base branch, a confirmed session association and a green Woodpecker status. Only preview is integrated.
7. Publish the checked preview. The broker verifies the current preview commit's Woodpecker check and backend readiness, then requests the official Coolify deployment. Readiness requires a finished deployment matching that commit and a successful public health response.

The production URL records the existing destination. Preview operations cannot merge main or deploy that application. Production promotion is a separate release decision.

## Boundaries and recovery

Recipes are immutable after binding; slug, repository and hostname cannot be reassigned between projects. Operators use preparation, verification, integration and preview publication; clients and readers only inspect. Endpoints authorize project/organization on the server.

Preparation reserves a durable lease before provider calls, checkpoints resources, and handles duplicate clicks. Resource reuse checks repository, branch and the Brokk project marker. Ambiguous creation remains uncertain and is reconciled by inspecting the deterministic identity instead of blindly repeating creation. Paid Devin sessions are never retried automatically.

The API never returns provider credentials, database connections, JWT signing secrets, resource handles or leases. SPA recipes receive only project-scoped anonymous publishable keys at build time. The static NFCS site does not require database calls; its namespace is prepared for future functionality.

## Configuration

Server-only settings:

- BROKK_COOLIFY_URL, BROKK_COOLIFY_TOKEN, BROKK_COOLIFY_PROJECT, BROKK_COOLIFY_SERVER, BROKK_COOLIFY_GITHUB_APP, optional BROKK_COOLIFY_ENVIRONMENT.
- BROKK_HAULDR_URL and BROKK_HAULDR_KEY.
- BROKK_GITHUB_TOKEN, BROKK_REPOSITORY_OWNER and BROKK_REPOSITORY_TEMPLATE.
- BROKK_WOODPECKER_URL and BROKK_WOODPECKER_TOKEN.
- BROKK_PREVIEW_DOMAIN, optional BROKK_PREVIEW_ALIAS_DOMAIN and BROKK_PREVIEW_MAX_PROJECTS (1–100, default 30).

Use the existing preview routing domain. A custom project alias needs its own infrastructure route before binding. New repository templates must not contain GitHub Actions workflows; the broker configures Woodpecker and leaves Actions disabled.

The dedicated API lives under /api/projects/:id/environment: GET for public status, PUT for an administrator recipe, POST /prepare, /refresh, /publish, /integrate and GET /deliveries. Integration takes the confirmed run ID and exact head SHA. No endpoint accepts arbitrary provider URLs, environment variables, commands or SQL.

Checks cover tenant/role boundaries, concurrent preparation, hidden capabilities, collisions, red CI, changed PR heads and readiness against the actual deployed commit.

O provisionamento desliga o deploy automático do Coolify e habilita SOURCE_COMMIT na build. Assim, pushes passam pelo Woodpecker e a publicação ocorre pela ação validada do Brokk. Aplicações existentes devem manter esses dois ajustes.
