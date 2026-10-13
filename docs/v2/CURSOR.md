# Cursor CLI executor

Devin and Cursor CLI consume the same approved project scope, task and versioned design contract. The operator explicitly chooses an available executor. Quota refusal never triggers a second paid session automatically.

Cursor jobs are committed to a durable queue together with the run reservation. A trusted worker receives only that project's repository, product context and a private lease. Duplicate claims cannot start the same job. The worker credential and lease are never returned to the public workspace, browser or coder prompt.

The CLI generates code in a managed isolated workspace. A technical worker handles Git and PR creation after reviewing the diff; the coder does not receive infrastructure, database, GitHub administration or Brokk worker credentials. The NFCS validation uses the existing authenticated local Cursor CLI with a per-process filesystem policy, blocked SSH/management/database ports and explicit CLI sandbox mode. This is a local worker test; permanent hosted worker capacity is a separate operational setup.

The worker reports assistant progress through Brokk. Operator requests enter a scoped queue and are consumed on the next CLI turn, not during an in-flight tool call. Completed PRs enter review and use the same exact-head Woodpecker integration and official Coolify preview publication gates. Failed or expired workers never automatically repeat an execution. The original lease may only close an expired job as failed; it cannot publish a result or resume execution.

Private worker protocol: POST /api/worker/cursor/claim and POST /api/worker/cursor/:runId/report, authenticated with BROKK_CURSOR_WORKER_SECRET. The worker keeps renewing its lease while working, waits for technical inspection and reports a repository-scoped PR. Clients cannot call these endpoints with their session cookie.

This separates orchestration from execution. A future model API executor can implement the same job/result contract, while provider selection policy, budgets and supervision remain explicit product work rather than an implicit permission expansion.
