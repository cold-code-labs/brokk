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
  /** Extra system prompt prepended to every task. */
  systemPrompt?: string;
}

export class ClaudeAgentEngine implements AgentEngine {
  constructor(private readonly opts: ClaudeEngineOptions) {}

  async run(ctx: AgentRunContext): Promise<RunResult> {
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
    };

    let verify: VerifyOutcome | null = null;
    let healAttempts = 0;
    const maxHeal = ctx.verify ? Math.max(0, ctx.maxHealAttempts ?? 0) : 0;

    try {
      ctx.emit({ type: "status", payload: { phase: "agent_start", model: ctx.model } });
      await forge(buildPrompt(ctx, this.opts.systemPrompt));

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
      // Restore the ambient token so it never leaks into the next run.
      if (ctx.authToken) {
        if (prevToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
        else process.env.CLAUDE_CODE_OAUTH_TOKEN = prevToken;
      }
    }

    ctx.emit({ type: "status", payload: { phase: "agent_done", usage, healAttempts } });
    return { usage, verify, healAttempts };
  }
}

/** Assemble the task prompt. Repo conventions (CLAUDE.md/AGENTS.md) are picked
 *  up by the agent itself from `cwd`; here we add the task, its success condition,
 *  and the per-repo memory (learned conventions / past review failures). */
function buildPrompt(ctx: AgentRunContext, systemPrompt?: string): string {
  const labels = ctx.task.labels.length ? `\nLabels: ${ctx.task.labels.join(", ")}` : "";
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
