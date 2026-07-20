// ─────────────────────────────────────────────────────────────────────────────
// ClaudeCliEngine — the SECOND engine behind core's AgentEngine port (opt-in via
// BROKK_FORGE_ENGINE=cli; ForgeEngine/afl stays the default).
//
// Instead of driving the afl loop against the gateway (LiteLLM → Ratatoskr),
// each forge pass runs the genuine Claude Code CLI headless in the worktree
// (packages/afl/src/claude-cli.ts). Heal passes RESUME the same CLI session, so
// the agent keeps its memory of what it already tried — the same continuity
// property the native engine has, via the CLI's own transcript instead of ours.
//
// Event mapping preserves the SDK-era shapes (`usage`={input_tokens,output_tokens},
// `message`={role,content}) exactly like ForgeEngine.forgeHooks, so the control
// plane, Board UI, and Langfuse tracer need no change. Verify → autofix → heal
// orchestration mirrors ForgeEngine so runs behave identically from the outside.
// ─────────────────────────────────────────────────────────────────────────────

import { runClaudeCliTurn, type AgentEvent, type CliTurnOutcome } from "@brokk/afl";
import type { AgentEngine, AgentRunContext, RunResult, RunUsage, VerifyOutcome } from "@brokk/core";
import { buildHealPrompt, buildPrompt, DEFAULT_SYSTEM_PROMPT } from "./prompts.js";

export interface ClaudeCliEngineOptions {
  /** alias → concrete model id. Defaults to the current CCL model ids. */
  models?: { haiku: string; sonnet: string; opus: string };
  /** Tell the agent it has a headless browser (via bash). Default OFF. */
  browser?: boolean;
  /** Hard cap on agentic turns per pass (runaway guard). */
  maxTurns?: number;
  /** Kill a single pass after this long. Default 1h. */
  turnTimeoutMs?: number;
}

const DEFAULT_MODELS: Record<string, string> = {
  haiku: "claude-haiku-4-5-20251001",
  sonnet: "claude-sonnet-4-6",
  opus: "claude-opus-4-8",
};

export class ClaudeCliEngine implements AgentEngine {
  constructor(private readonly opts: ClaudeCliEngineOptions = {}) {}

  async run(ctx: AgentRunContext): Promise<RunResult> {
    const models: Record<string, string> = { ...DEFAULT_MODELS, ...(this.opts.models ?? {}) };
    const model = models[ctx.model] ?? ctx.model;
    const usage: RunUsage = { tokensIn: 0, tokensOut: 0, headroomSaved: 0 };
    // tool_use id → name, so tool_result events carry the name like forgeHooks'.
    const toolNames = new Map<string, string>();
    let cliSessionId: string | undefined;

    const emitAdapter = (e: AgentEvent) => {
      switch (e.type) {
        case "tool_use":
          toolNames.set(e.id, e.name);
          ctx.emit({ type: "tool_use", payload: { id: e.id, name: e.name, input: e.input } });
          break;
        case "tool_result":
          ctx.emit({
            type: "tool_result",
            payload: {
              tool_use_id: e.toolUseId,
              name: toolNames.get(e.toolUseId) ?? "",
              ok: e.ok,
              preview: e.preview,
            },
          });
          break;
        case "thinking_delta":
          if (e.text) ctx.emit({ type: "thinking", payload: { text: e.text } });
          break;
        default:
          break; // text_delta/status stay lean — message blocks carry final text
      }
    };

    const pass = (prompt: string): Promise<CliTurnOutcome> =>
      runClaudeCliTurn({
        cwd: ctx.cwd,
        prompt,
        model,
        resume: cliSessionId,
        appendSystem: DEFAULT_SYSTEM_PROMPT,
        maxTurns: this.opts.maxTurns,
        gh: true,
        timeoutMs: this.opts.turnTimeoutMs ?? 3_600_000,
        emit: emitAdapter,
        hooks: {
          onAssistant: (blocks, meta) => {
            ctx.emit({ type: "message", payload: { role: "assistant", content: blocks } });
            ctx.emit({
              type: "usage",
              payload: { input_tokens: meta.usage.inputTokens, output_tokens: meta.usage.outputTokens },
            });
            usage.tokensIn += meta.usage.inputTokens;
            usage.tokensOut += meta.usage.outputTokens;
          },
        },
      });

    const forgePass = async (prompt: string): Promise<CliTurnOutcome> => {
      const outcome = await pass(prompt);
      cliSessionId = outcome.cliSessionId ?? cliSessionId;
      if (outcome.stop === "error") {
        throw new Error(`claude CLI pass failed: ${outcome.resultText.slice(0, 2000)}`);
      }
      return outcome;
    };

    let verify: VerifyOutcome | null = null;
    let healAttempts = 0;
    let autofixResolved = 0;
    let lastHealFailure: string | undefined;
    const maxHeal = ctx.verify ? Math.max(0, ctx.maxHealAttempts ?? 0) : 0;

    try {
      ctx.emit({ type: "status", payload: { phase: "agent_start", model, engine: "cli" } });
      const first = await forgePass(buildPrompt(ctx, this.opts.browser));
      ctx.emit({ type: "status", payload: { phase: "forge_pass", stop: first.stop } });

      // Verify → autofix → heal, mirroring ForgeEngine (#1/#2). Heal resumes the
      // SAME CLI session so the agent recalls its own prior moves.
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
          if (ctx.autofix) {
            const fix = await ctx.autofix(verify.output);
            if (fix.changed) {
              ctx.emit({ type: "status", payload: { phase: "autofix", round, note: fix.note } });
              verify = await ctx.verify!();
              ctx.emit({ type: "status", payload: { phase: "verify_done", ok: verify.ok, round, after: "autofix" } });
              if (verify.ok) {
                autofixResolved++;
                break;
              }
            }
          }
          healAttempts++;
          lastHealFailure = verify.output.slice(-4000);
          ctx.emit({ type: "status", payload: { phase: "heal", attempt: healAttempts, of: maxHeal } });
          await forgePass(buildHealPrompt(ctx, verify.output));
        }
      }
    } catch (err) {
      ctx.emit({ type: "log", payload: { level: "error", error: String(err) } });
      throw err;
    }

    ctx.emit({ type: "status", payload: { phase: "agent_done", usage, healAttempts, autofixResolved } });
    return { usage, verify, healAttempts, lastHealFailure, autofixResolved };
  }
}
