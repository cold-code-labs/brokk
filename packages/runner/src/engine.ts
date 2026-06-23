import type { AgentEngine, AgentRunContext, RunResult, RunUsage, VerifyOutcome } from "@brokk/core";

/**
 * ClaudeAgentEngine — the brain, over the headless Claude Agent SDK.
 *
 * It runs `query()` to completion in the task's worktree (`ctx.cwd`), forwards
 * the agent's stream into Brokk run-events, then VERIFIES the work and, if the
 * verify fails, RE-PROMPTS the agent with the failure output and forges again —
 * up to `ctx.maxHealAttempts` rounds (#1, the in-trajectory self-heal loop).
 * Returns the token usage + the final verify outcome.
 *
 * Auth is whatever the host `claude`/SDK is configured with:
 *   - api_key      → ANTHROPIC_API_KEY (routed through the gateway)
 *   - subscription → CLAUDE_CODE_OAUTH_TOKEN (`claude setup-token`)
 * Either way we point ANTHROPIC_BASE_URL at the headroom proxy first.
 *
 * ⚠️ TODO(P1): the exact SDK message shapes / options are version-dependent and
 * UNVERIFIED — this compiles structurally but must be exercised in the P1 spike
 * (1 card → real PR) before trusting it. Kept intentionally defensive (`any`).
 */
export interface ClaudeEngineOptions {
  anthropicBaseUrl: string;
  anthropicApiKey: string;
  /** Gateway mode (Ratatoskr/LiteLLM): a bearer token the SDK sends to the LLM
   *  gateway (ANTHROPIC_AUTH_TOKEN). When set, the gateway holds the real
   *  subscription credential and we DON'T use a per-run OAuth seat token or an
   *  API key — `anthropicBaseUrl` points at the gateway. Empty = legacy
   *  subscription/api-key path (per-run CLAUDE_CODE_OAUTH_TOKEN). */
  anthropicAuthToken: string;
  /** Extra system prompt prepended to every task. */
  systemPrompt?: string;
  /** Give the forge agent a real headless browser via the Playwright MCP server,
   *  so it can drive a running app while forging (e.g. to check a card's
   *  acceptance against a live preview). Default OFF — when false the agent gets
   *  exactly today's tools (file/bash/git), no `mcpServers`, no browser. Gated by
   *  BROKK_BROWSER in the runner config. */
  browser?: boolean;
}

/**
 * Playwright MCP server, wired as a stdio MCP server per the installed
 * @anthropic-ai/claude-agent-sdk Options shape (verified against the .d.ts in
 * node_modules — `options.mcpServers: Record<string, McpStdioServerConfig>`, and
 * its tools surface as `mcp__playwright__*` names to put in `allowedTools`).
 *
 * Flags: `--headless` (no display on the runner host) and `--isolated` (ephemeral
 * browser profile per session — nothing persists between forges).
 */
function playwrightMcpServer() {
  // Point @playwright/mcp at a specific chromium when PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  // is set (the runner image installs system chromium for musl/Alpine); unset on
  // dev hosts → it uses Playwright's bundled browser.
  const exe = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  const args = ["@playwright/mcp@latest", "--headless", "--isolated", "--browser", "chromium"];
  if (exe) args.push("--executable-path", exe);
  return { playwright: { type: "stdio" as const, command: "npx", args } };
}

/** Allow the Playwright MCP tools when the browser is on. The trailing `__` form
 *  ("mcp__playwright" without a tool suffix) whitelists every tool the server
 *  exposes (navigate/click/snapshot/…), so we don't have to track the exact set
 *  per @playwright/mcp version. */
const PLAYWRIGHT_ALLOWED_TOOLS = ["mcp__playwright"];

export class ClaudeAgentEngine implements AgentEngine {
  constructor(private readonly opts: ClaudeEngineOptions) {}

  async run(ctx: AgentRunContext): Promise<RunResult> {
    // Route the agent's traffic. In gateway mode the base url is the LLM gateway
    // (LiteLLM → Ratatoskr); otherwise it's headroom (or empty = direct).
    if (this.opts.anthropicBaseUrl) process.env.ANTHROPIC_BASE_URL = this.opts.anthropicBaseUrl;

    const gateway = !!this.opts.anthropicAuthToken;
    // Snapshot the auth env so we can restore it after the run (the runner loop
    // is sequential, so mutating process.env per-run is safe).
    const prevAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
    const prevApiKey = process.env.ANTHROPIC_API_KEY;
    const prevOAuth = process.env.CLAUDE_CODE_OAUTH_TOKEN;

    if (gateway) {
      // Authenticate to the gateway with a bearer token (a per-tool LiteLLM
      // virtual key). The gateway injects the real subscription credential
      // upstream, so the seat token / API key must NOT be present — both would
      // take precedence over ANTHROPIC_AUTH_TOKEN and break gateway auth.
      process.env.ANTHROPIC_AUTH_TOKEN = this.opts.anthropicAuthToken;
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    } else {
      // Legacy path: direct API key and/or a per-run Max seat token.
      if (this.opts.anthropicApiKey) process.env.ANTHROPIC_API_KEY = this.opts.anthropicApiKey;
      if (ctx.authToken) process.env.CLAUDE_CODE_OAUTH_TOKEN = ctx.authToken;
    }

    const usage: RunUsage = { tokensIn: 0, tokensOut: 0, headroomSaved: 0 };

    // Lazy import so the package builds even if the SDK isn't installed yet.
    const { query } = (await import("@anthropic-ai/claude-agent-sdk")) as any;

    // Browser lane (BROKK_BROWSER): when on, attach the Playwright MCP server and
    // allow its tools so the agent can drive a headless browser during the forge.
    // When off, both stay empty and the spread below is a no-op — behaviour is
    // byte-for-byte today's (no `mcpServers`, default file/bash/git tools only).
    const mcpServers = this.opts.browser ? playwrightMcpServer() : undefined;
    const allowedTools = [
      ...ctx.allowedTools,
      ...(this.opts.browser ? PLAYWRIGHT_ALLOWED_TOOLS : []),
    ];

    // One agent pass over the worktree. Fresh session each call — the changes
    // live in the worktree, so a heal pass re-reads the files; we don't depend on
    // the SDK's (version-uncertain) session-resume to carry forge context.
    const forge = async (prompt: string): Promise<void> => {
      const stream = query({
        prompt,
        options: {
          cwd: ctx.cwd,
          model: ctx.model,
          permissionMode: "bypassPermissions",
          ...(allowedTools.length ? { allowedTools } : {}),
          ...(mcpServers ? { mcpServers } : {}),
        },
      });
      for await (const message of stream as AsyncIterable<any>) {
        switch (message?.type) {
          case "assistant":
          case "user":
            ctx.emit({ type: "message", payload: message });
            break;
          case "tool_use":
            ctx.emit({ type: "tool_use", payload: message });
            break;
          case "tool_result":
            ctx.emit({ type: "tool_result", payload: message });
            break;
          case "result": {
            const u = message.usage ?? message?.message?.usage ?? {};
            usage.tokensIn += Number(u.input_tokens ?? 0);
            usage.tokensOut += Number(u.output_tokens ?? 0);
            ctx.emit({ type: "usage", payload: u });
            break;
          }
          default:
            ctx.emit({ type: "log", payload: message });
        }
      }
    };

    let verify: VerifyOutcome | null = null;
    let healAttempts = 0;
    const maxHeal = ctx.verify ? Math.max(0, ctx.maxHealAttempts ?? 0) : 0;

    try {
      ctx.emit({ type: "status", payload: { phase: "agent_start", model: ctx.model } });
      await forge(buildPrompt(ctx, this.opts.systemPrompt, this.opts.browser));

      // Verify → self-heal loop (#1). Forge, verify, and while it's red and we
      // still have heal budget, hand the failure back and forge a fix.
      if (ctx.verify) {
        for (let round = 0; ; round++) {
          ctx.emit({ type: "status", payload: { phase: "verify_start", round } });
          verify = await ctx.verify();
          ctx.emit({ type: "status", payload: { phase: "verify_done", ok: verify.ok, round } });
          ctx.emit({
            type: "log",
            payload: { level: verify.ok ? "info" : "error", verify: verify.output.slice(-4000) },
          });
          if (verify.ok || round >= maxHeal) break;
          healAttempts++;
          ctx.emit({
            type: "status",
            payload: { phase: "heal", attempt: healAttempts, of: maxHeal },
          });
          await forge(buildHealPrompt(ctx, verify.output));
        }
      }
    } catch (err) {
      ctx.emit({ type: "log", payload: { level: "error", error: String(err) } });
      throw err;
    } finally {
      // Restore the ambient auth env so per-run mutations never leak forward.
      const restore = (k: string, v: string | undefined) => {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      };
      restore("ANTHROPIC_AUTH_TOKEN", prevAuthToken);
      restore("ANTHROPIC_API_KEY", prevApiKey);
      restore("CLAUDE_CODE_OAUTH_TOKEN", prevOAuth);
    }

    ctx.emit({ type: "status", payload: { phase: "agent_done", usage, healAttempts } });
    return { usage, verify, healAttempts };
  }
}

/** Assemble the task prompt. Repo conventions (CLAUDE.md/AGENTS.md) are picked
 *  up by the agent itself from `cwd`; here we add the task, its success condition,
 *  and the per-repo memory (learned conventions / past review failures). */
function buildPrompt(ctx: AgentRunContext, systemPrompt?: string, browser?: boolean): string {
  const labels = ctx.task.labels.length ? `\nLabels: ${ctx.task.labels.join(", ")}` : "";
  const browserHint = browser
    ? [
        "",
        "## Browser available",
        "You have a headless browser via the Playwright MCP tools (`mcp__playwright__*`).",
        "When a card's acceptance is a UI or HTTP behaviour, drive the running app to check it,",
        "and commit a Playwright e2e spec (under `e2e/`, reading `process.env.BASE_URL`) that proves",
        "it — that spec is the durable acceptance receipt the verify step re-runs.",
      ].join("\n")
    : "";
  const acceptance = ctx.task.acceptance
    ? [
        "",
        "## Acceptance (the success condition — you MUST make this true)",
        ctx.task.acceptance,
        "Add or extend a test that proves it. The change is not done until a test covers this behaviour.",
      ].join("\n")
    : "";
  const memory =
    ctx.memory && ctx.memory.length
      ? [
          "",
          "## Repo memory (lessons from past work here — respect these)",
          ...ctx.memory.map((m) => `- ${m}`),
        ].join("\n")
      : "";
  return [
    systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
    "",
    `# Task: ${ctx.task.title}`,
    ctx.task.body || "(no description)",
    labels,
    acceptance,
    memory,
    browserHint,
    "",
    "When done, ensure changes are committed-ready (Brokk will commit, push, and open the PR).",
  ].join("\n");
}

/** Re-prompt for a heal pass: the agent's previous changes are already in the
 *  worktree; the verify command failed — fix it so verification passes. */
function buildHealPrompt(ctx: AgentRunContext, verifyOutput: string): string {
  const acceptance = ctx.task.acceptance
    ? `\nThe acceptance condition still stands: ${ctx.task.acceptance}\n`
    : "";
  return [
    "Your previous changes are in the working tree, but VERIFICATION FAILED.",
    "Read the failure output below, fix the code (and tests) so the verify command passes,",
    "and keep the original task intact. Do not revert working changes — repair them.",
    acceptance,
    `# Task (unchanged): ${ctx.task.title}`,
    "",
    "## Verify failure output",
    "```",
    verifyOutput.slice(-12_000),
    "```",
  ].join("\n");
}

const DEFAULT_SYSTEM_PROMPT =
  "You are Brokk, an autonomous coding agent. Implement the task in the current " +
  "repository working tree. Follow the repo's existing conventions. Make focused, " +
  "reviewable changes, and cover the behaviour you change with a test. Do not push " +
  "or open PRs yourself — that is handled for you.";
