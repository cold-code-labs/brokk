// ─────────────────────────────────────────────────────────────────────────────
// ForgeEngine — Brokkr's brain, native over @brokk/afl (NO Agent SDK).
//
// It drives the Afl agent loop (the shared kernel) in the task's worktree with
// the generic hands (read/write/edit/list_dir + bash, with gh creds so the agent
// can run git/gh), then VERIFIES the work and, on a red verify, re-prompts the
// SAME conversation with the failure and forges again — up to ctx.maxHealAttempts
// rounds (#1, the in-trajectory self-heal loop). Returns token usage + the final
// verify outcome.
//
// Why native beats the SDK here (the lean win, NORTH-STAR §9):
//   • No 33k-token Claude-Code preamble per turn — we own the system prompt.
//   • We own the transcript, so a heal pass CONTINUES the conversation (the agent
//     sees what it already tried + the verify failure) instead of the SDK's
//     fresh-session-per-pass amnesia.
//   • Minimal tool surface (fs + bash), mutation gated by shellEnv's allowlist.
//
// Auth: gateway-only. The runner points ANTHROPIC_BASE_URL at LiteLLM → Ratatoskr
// and authenticates with a LiteLLM virtual key (ANTHROPIC_AUTH_TOKEN); Ratatoskr
// injects the real subscription credential + the "You are Claude Code" marker
// upstream. The legacy per-run OAuth seat path (CLAUDE_CODE_OAUTH_TOKEN) is retired
// by this migration — the seat lives behind Ratatoskr now.
// ─────────────────────────────────────────────────────────────────────────────

import {
  type AgentLoopHooks,
  type AflConfig,
  type ChatTurnMessage,
  composeExecutors,
  FS_TOOL_DEFS,
  makeFsExecutor,
  resolveModel,
  runAgentLoop,
} from "@brokk/afl";
import type { AgentEngine, AgentRunContext, RunResult, RunUsage, VerifyOutcome } from "@brokk/core";
import { buildHealPrompt, buildPrompt, DEFAULT_SYSTEM_PROMPT } from "./prompts.js";

export interface ForgeEngineOptions {
  /** Gateway base url (ANTHROPIC_BASE_URL) — LiteLLM → Ratatoskr. */
  gatewayUrl: string;
  /** Gateway bearer (ANTHROPIC_AUTH_TOKEN) — a LiteLLM virtual key. */
  authToken: string;
  /** anthropic-version header. Default mirrors Claude Code. */
  anthropicVersion?: string;
  /** alias → concrete model id. Defaults to the current CCL model ids. */
  models?: { haiku: string; sonnet: string; opus: string };
  /** Max output tokens per assistant round. Forge writes whole files, so this is
   *  higher than chat's default; the gateway shrinks it on a busy-seat 429. */
  maxTokens?: number;
  /** Hard ceiling on tool-use rounds in ONE forge pass (runaway guard). */
  maxRounds?: number;
  /** Override Brokkr's system prompt. */
  systemPrompt?: string;
  /** When true, tell the agent it has a headless browser (via bash) for UI/HTTP
   *  acceptance checks. Default OFF — behaviour is fs/bash/git only. */
  browser?: boolean;
}

const DEFAULT_MODELS = {
  haiku: "claude-haiku-4-5-20251001",
  sonnet: "claude-sonnet-4-6",
  opus: "claude-opus-4-8",
};

export class ForgeEngine implements AgentEngine {
  private readonly cfg: AflConfig;
  constructor(private readonly opts: ForgeEngineOptions) {
    this.cfg = {
      gatewayUrl: opts.gatewayUrl.replace(/\/$/, ""),
      authToken: opts.authToken,
      anthropicVersion: opts.anthropicVersion ?? "2023-06-01",
      models: opts.models ?? DEFAULT_MODELS,
      maxTokens: opts.maxTokens ?? 8192,
      maxRounds: opts.maxRounds ?? 120,
    };
  }

  async run(ctx: AgentRunContext): Promise<RunResult> {
    const model = resolveModel(this.cfg, ctx.model);
    const system = this.opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    // The generic hands are the only executor; compose wraps the partial with the
    // unknown-tool fallback to satisfy the loop's full ToolExecutor.
    const exec = composeExecutors(makeFsExecutor({ cwd: ctx.cwd }));
    const usage: RunUsage = { tokensIn: 0, tokensOut: 0, headroomSaved: 0 };
    const hooks = this.forgeHooks(ctx, usage);

    // One growing transcript carries every forge + heal pass. The worktree holds
    // the code; the conversation holds the reasoning. Both persist across heals.
    const messages: ChatTurnMessage[] = [
      { role: "user", content: [{ type: "text", text: buildPrompt(ctx, this.opts.browser) }] },
    ];

    const forgePass = () =>
      runAgentLoop({
        cfg: this.cfg,
        model,
        system,
        messages,
        tools: FS_TOOL_DEFS,
        exec,
        maxTokens: this.cfg.maxTokens,
        maxRounds: this.cfg.maxRounds,
        hooks,
      });

    let verify: VerifyOutcome | null = null;
    let healAttempts = 0;
    const maxHeal = ctx.verify ? Math.max(0, ctx.maxHealAttempts ?? 0) : 0;

    try {
      ctx.emit({ type: "status", payload: { phase: "agent_start", model } });
      const first = await forgePass();
      ctx.emit({ type: "status", payload: { phase: "forge_pass", stop: first.stop, rounds: first.rounds } });

      // Verify → self-heal loop (#1). Forge, verify, and while it's red and we
      // still have heal budget, hand the failure back and forge a fix — in the
      // SAME conversation so the agent recalls its own prior moves.
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
          ctx.emit({ type: "status", payload: { phase: "heal", attempt: healAttempts, of: maxHeal } });
          messages.push({
            role: "user",
            content: [{ type: "text", text: buildHealPrompt(ctx, verify.output) }],
          });
          await forgePass();
        }
      }
    } catch (err) {
      ctx.emit({ type: "log", payload: { level: "error", error: String(err) } });
      throw err;
    }

    ctx.emit({ type: "status", payload: { phase: "agent_done", usage, healAttempts } });
    return { usage, verify, healAttempts };
  }

  /** Map the loop's hooks onto the runner's RunEvent stream, keeping the SDK-era
   *  event SHAPES so the control plane, Board UI, and Langfuse tracer need no
   *  change: `usage` carries {input_tokens,output_tokens}; `message` carries
   *  {role,content} (Board reads content[].text). Also folds usage into RunUsage. */
  private forgeHooks(ctx: AgentRunContext, usage: RunUsage): AgentLoopHooks {
    return {
      onAssistant: (blocks, meta) => {
        ctx.emit({ type: "message", payload: { role: "assistant", content: blocks } });
        ctx.emit({
          type: "usage",
          payload: { input_tokens: meta.usage.inputTokens, output_tokens: meta.usage.outputTokens },
        });
        usage.tokensIn += meta.usage.inputTokens;
        usage.tokensOut += meta.usage.outputTokens;
      },
      onToolUse: (tu) => ctx.emit({ type: "tool_use", payload: { id: tu.id, name: tu.name, input: tu.input } }),
      onToolResult: (tu, r) =>
        ctx.emit({
          type: "tool_result",
          payload: { tool_use_id: tu.id, name: tu.name, ok: r.ok, preview: r.content.slice(0, 600) },
        }),
    };
  }
}
