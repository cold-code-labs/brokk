import type { AgentEngine, AgentRunContext, RunUsage } from "@brokk/core";

/**
 * ClaudeAgentEngine — the brain, over the headless Claude Agent SDK.
 *
 * It runs `query()` to completion in the task's worktree (`ctx.cwd`), forwards
 * the agent's stream into Brokk run-events, and returns the token usage.
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
  /** Extra system prompt prepended to every task. */
  systemPrompt?: string;
}

export class ClaudeAgentEngine implements AgentEngine {
  constructor(private readonly opts: ClaudeEngineOptions) {}

  async run(ctx: AgentRunContext): Promise<RunUsage> {
    // Route the agent's traffic through headroom when configured (stretches the
    // Max window). Empty = go direct to Anthropic (subscription token / api key).
    if (this.opts.anthropicBaseUrl) process.env.ANTHROPIC_BASE_URL = this.opts.anthropicBaseUrl;
    if (this.opts.anthropicApiKey) process.env.ANTHROPIC_API_KEY = this.opts.anthropicApiKey;

    // Per-run seat token (a member's Max). Override the ambient one for this run
    // and restore after. Runs are sequential in the runner loop, so this is safe.
    const prevToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    if (ctx.authToken) process.env.CLAUDE_CODE_OAUTH_TOKEN = ctx.authToken;

    const usage: RunUsage = { tokensIn: 0, tokensOut: 0, headroomSaved: 0 };

    // Lazy import so the package builds even if the SDK isn't installed yet.
    const { query } = (await import("@anthropic-ai/claude-agent-sdk")) as any;

    const prompt = buildPrompt(ctx, this.opts.systemPrompt);
    ctx.emit({ type: "status", payload: { phase: "agent_start", model: ctx.model } });

    try {
      const stream = query({
        prompt,
        options: {
          cwd: ctx.cwd,
          model: ctx.model,
          permissionMode: "bypassPermissions",
          ...(ctx.allowedTools.length ? { allowedTools: ctx.allowedTools } : {}),
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
    } catch (err) {
      ctx.emit({ type: "log", payload: { level: "error", error: String(err) } });
      throw err;
    } finally {
      // Restore the ambient token so it never leaks into the next run.
      if (ctx.authToken) {
        if (prevToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
        else process.env.CLAUDE_CODE_OAUTH_TOKEN = prevToken;
      }
    }

    ctx.emit({ type: "status", payload: { phase: "agent_done", usage } });
    return usage;
  }
}

/** Assemble the task prompt. Repo conventions (CLAUDE.md/AGENTS.md) are picked
 *  up by the agent itself from `cwd`, so we keep this focused on the task. */
function buildPrompt(ctx: AgentRunContext, systemPrompt?: string): string {
  const labels = ctx.task.labels.length ? `\nLabels: ${ctx.task.labels.join(", ")}` : "";
  return [
    systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
    "",
    `# Task: ${ctx.task.title}`,
    ctx.task.body || "(no description)",
    labels,
    "",
    "When done, ensure changes are committed-ready (Brokk will commit, push, and open the PR).",
  ].join("\n");
}

const DEFAULT_SYSTEM_PROMPT =
  "You are Brokk, an autonomous coding agent. Implement the task in the current " +
  "repository working tree. Follow the repo's existing conventions. Make focused, " +
  "reviewable changes. Do not push or open PRs yourself — that is handled for you.";
