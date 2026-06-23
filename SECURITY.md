# Security Policy

## Status

Brokk is **private and pre-1.0**, hardening toward a public release. It runs in production at
Cold Code Labs.

## Reporting a vulnerability

Please **do not open a public issue** for security vulnerabilities.

Use GitHub's private vulnerability reporting on this repository:

- Go to the **Security** tab → **Report a vulnerability**.

Include a description and impact, steps to reproduce (or a proof of concept), and any affected
versions or configurations. We'll acknowledge, investigate, and coordinate a fix.

## Why this matters here

Brokk is a coding agent with real power: it holds a GitHub token (contents + PR write on target
repos), an Anthropic credential (OAuth seat or API key), a runner shared secret, and it executes
model-authored code in worktrees. Reports are most useful when they concern:

- the runner's isolation (worktree boundaries, the opt-in Docker socket path),
- the runner/control-plane shared-secret auth and the public-facing endpoints,
- how secrets are passed to and exposed by the runner,
- Eitri's security ward (the semgrep/trivy gate) being bypassable,
- prompt-injection paths that could make the agent exfiltrate secrets or push to the wrong repo.

Misconfiguration of a self-hosted deployment, or vulnerabilities in upstream components (the
Claude Agent SDK, semgrep, trivy, `gh`), should go to the relevant project — we're happy to
help triage.
