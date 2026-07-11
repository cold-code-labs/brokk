// ─────────────────────────────────────────────────────────────────────────────
// Claude Code CLI turn driver — the SECOND engine lane (opt-in, never default).
//
// Runs one headless turn of the genuine `claude` CLI (`-p --output-format
// stream-json`) inside a checkout and maps its event stream onto the same
// AgentEvent shapes the native loop emits, so everything downstream (TurnManager
// SSE, chat_messages persistence, the Board) works unchanged. Session continuity
// is the CLI's own (`--resume <cli session id>`), NOT a transcript replay — the
// CLI owns its context under $HOME/.claude, we only store the id.
//
// Why this lane exists alongside the lean Afl loop (which stays the default):
//   • the genuine client passes the seat's shape-gate natively (no Ratatoskr
//     marker spoofing) AND gets prompt-cache READS the raw-API seat path never
//     serves — the fat preamble is ~90% cache hit in practice;
//   • it brings the full harness (skills, subagents, compaction, plan mode).
//
// Trust boundary: the CLI process needs CLAUDE_CODE_OAUTH_TOKEN in its env and
// its bash does NOT route through brokk-sandbox/uid-split — the container is the
// boundary. Internal/trusted repos only; the env we pass is allowlisted so the
// worker's infra secrets (DB url, runner secret, vkeys) never reach it.
// ─────────────────────────────────────────────────────────────────────────────

import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import type { AgentEvent, ContentBlock, ToolResultBlock, TurnUsage } from "./types.js";

export interface CliTurnHooks {
  /** One completed assistant API message (text/thinking/tool_use blocks). */
  onAssistant?: (
    blocks: ContentBlock[],
    meta: { usage: TurnUsage; stopReason?: string },
  ) => void | Promise<void>;
  /** The tool_result batch that answered the previous assistant round. */
  onToolResults?: (blocks: ContentBlock[]) => void | Promise<void>;
}

export interface CliTurnInput {
  /** Working directory (the session/task checkout). */
  cwd: string;
  /** The user prompt for this turn (written to stdin — no argv size limit). */
  prompt: string;
  /** Concrete model id (or CLI alias). Omit = CLI default. */
  model?: string;
  /** Resume an existing CLI session (its id from a prior turn's outcome). */
  resume?: string;
  /** Appended to the CLI's own system prompt (repo/branch grounding). */
  appendSystem?: string;
  /** Hard cap on agentic turns (runaway guard). Omit = CLI default. */
  maxTurns?: number;
  /** Pass GH_TOKEN through so the model's bash can run git push / gh. */
  gh?: boolean;
  /** Extra env entries layered over the allowlist. */
  env?: Record<string, string>;
  emit?: (e: AgentEvent) => void;
  hooks?: CliTurnHooks;
  signal?: AbortSignal;
  /** Kill the process after this long. 0/undefined = no cap. */
  timeoutMs?: number;
}

export interface CliTurnOutcome {
  ok: boolean;
  /** The CLI's session id — store it and pass as `resume` next turn. */
  cliSessionId: string | null;
  /** Final assistant text (the `result` field of the result event). */
  resultText: string;
  /** Cumulative usage as the CLI reports it. */
  usage: TurnUsage;
  stop: "done" | "aborted" | "max_turns" | "error";
  exitCode: number | null;
}

const ZERO_USAGE: TurnUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
};

function cliBin(): string {
  return process.env.BROKK_CLAUDE_CLI_BIN || "claude";
}

/** Feature gate: binary on PATH + a seat token in the worker env. Memoized —
 *  the binary doesn't appear mid-process. */
let available: boolean | null = null;
export function claudeCliAvailable(): boolean {
  if (available !== null) return available;
  if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) return (available = false);
  try {
    const r = spawnSync(cliBin(), ["--version"], { timeout: 10_000, stdio: "ignore" });
    available = r.status === 0;
  } catch {
    available = false;
  }
  return available;
}

/** Minimal env for the CLI process — the worker's secrets stay out (N1 spirit).
 *  The seat token goes in deliberately: this lane IS the credentialed one. */
function cliEnv(input: CliTurnInput): Record<string, string> {
  const src = process.env;
  const out: Record<string, string> = {};
  for (const k of ["HOME", "PATH", "TMPDIR", "LANG", "TZ"]) {
    if (src[k]) out[k] = src[k]!;
  }
  out.CLAUDE_CODE_OAUTH_TOKEN = src.CLAUDE_CODE_OAUTH_TOKEN ?? "";
  // Git identity so the model's local commits attribute like the fleet's.
  out.GIT_AUTHOR_NAME = src.BROKK_GIT_NAME || "Brokk";
  out.GIT_AUTHOR_EMAIL = src.BROKK_GIT_EMAIL || "brokk@coldcodelabs.com";
  out.GIT_COMMITTER_NAME = out.GIT_AUTHOR_NAME;
  out.GIT_COMMITTER_EMAIL = out.GIT_AUTHOR_EMAIL;
  if (input.gh && (src.GH_TOKEN || src.GITHUB_TOKEN)) {
    out.GH_TOKEN = src.GH_TOKEN || src.GITHUB_TOKEN!;
    out.GITHUB_TOKEN = out.GH_TOKEN;
  }
  // Keep the headless run self-contained: no auto-update, no phone-home extras.
  out.DISABLE_AUTOUPDATER = "1";
  out.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  out.NO_COLOR = "1";
  return { ...out, ...(input.env ?? {}) };
}

function mapUsage(u: Record<string, unknown> | undefined | null): TurnUsage {
  if (!u) return { ...ZERO_USAGE };
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    inputTokens: n(u.input_tokens),
    outputTokens: n(u.output_tokens),
    cacheReadTokens: n(u.cache_read_input_tokens),
    cacheCreationTokens: n(u.cache_creation_input_tokens),
  };
}

/** tool_result content arrives as a string or an array of content parts —
 *  normalize to the plain string our ToolResultBlock carries. */
function resultContentToString(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (p && typeof p === "object" && (p as { type?: string }).type === "text") {
          return String((p as { text?: unknown }).text ?? "");
        }
        return "";
      })
      .join("");
  }
  return content == null ? "" : JSON.stringify(content);
}

/** Run ONE headless CLI turn to completion, streaming events as they happen. */
export async function runClaudeCliTurn(input: CliTurnInput): Promise<CliTurnOutcome> {
  const emit = input.emit ?? (() => {});
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--dangerously-skip-permissions",
  ];
  if (input.model) args.push("--model", input.model);
  if (input.resume) args.push("--resume", input.resume);
  if (input.appendSystem) args.push("--append-system-prompt", input.appendSystem);
  if (input.maxTurns && input.maxTurns > 0) args.push("--max-turns", String(input.maxTurns));

  const proc = spawn(cliBin(), args, {
    cwd: input.cwd,
    env: cliEnv(input),
    stdio: ["pipe", "pipe", "pipe"],
  });
  proc.stdin.write(input.prompt);
  proc.stdin.end();

  let cliSessionId: string | null = input.resume ?? null;
  let usage: TurnUsage = { ...ZERO_USAGE };
  let resultText = "";
  let stop: CliTurnOutcome["stop"] = "error";
  let ok = false;
  let sawResult = false;
  let aborted = false;
  let stderrTail = "";

  const kill = () => {
    aborted = true;
    proc.kill("SIGTERM");
    // The CLI traps SIGTERM to flush; escalate if it lingers.
    setTimeout(() => proc.kill("SIGKILL"), 5_000).unref?.();
  };
  const onAbort = () => kill();
  input.signal?.addEventListener("abort", onAbort, { once: true });
  const timer =
    input.timeoutMs && input.timeoutMs > 0 ? setTimeout(kill, input.timeoutMs) : null;
  timer?.unref?.();

  proc.stderr.on("data", (d: Buffer) => {
    stderrTail = (stderrTail + d.toString()).slice(-4000);
  });

  // Serialize hook work (DB writes) so persisted messages keep stream order.
  let chain: Promise<void> = Promise.resolve();
  const enqueue = (fn: () => void | Promise<void>) => {
    chain = chain.then(fn).catch(() => {});
  };

  const rl = createInterface({ input: proc.stdout });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return; // non-JSON noise on stdout — ignore
    }
    // Subagent traffic (Task tool) carries parent_tool_use_id — surface its tool
    // activity in the live stream but keep it OUT of the persisted transcript.
    const parented = Boolean((ev as { parent_tool_use_id?: unknown }).parent_tool_use_id);

    switch (ev.type) {
      case "system": {
        if (ev.subtype === "init") {
          if (typeof ev.session_id === "string") cliSessionId = ev.session_id;
          emit({
            type: "status",
            phase: "cli_init",
            detail: { cliSessionId, model: (ev as { model?: unknown }).model },
          });
        }
        break;
      }
      case "stream_event": {
        const se = (ev as { event?: { type?: string; delta?: { type?: string; text?: string; thinking?: string } } }).event;
        if (se?.type === "content_block_delta" && !parented) {
          if (se.delta?.type === "text_delta" && se.delta.text) {
            emit({ type: "text_delta", text: se.delta.text });
          } else if (se.delta?.type === "thinking_delta" && se.delta.thinking) {
            emit({ type: "thinking_delta", text: se.delta.thinking });
          }
        }
        break;
      }
      case "assistant": {
        const msg = (ev as { message?: { content?: unknown[]; usage?: Record<string, unknown>; stop_reason?: string } }).message;
        const blocks = (Array.isArray(msg?.content) ? msg!.content : []) as ContentBlock[];
        for (const b of blocks) {
          if ((b as { type?: string }).type === "tool_use") {
            const tu = b as { id: string; name: string; input: Record<string, unknown> };
            emit({ type: "tool_use", id: tu.id, name: tu.name, input: tu.input ?? {} });
          }
        }
        if (!parented && blocks.length) {
          const meta = { usage: mapUsage(msg?.usage), stopReason: msg?.stop_reason };
          emit({ type: "usage", usage: meta.usage });
          if (input.hooks?.onAssistant) enqueue(() => input.hooks!.onAssistant!(blocks, meta));
        }
        break;
      }
      case "user": {
        const msg = (ev as { message?: { content?: unknown } }).message;
        const parts = Array.isArray(msg?.content) ? (msg!.content as Record<string, unknown>[]) : [];
        const results: ToolResultBlock[] = [];
        for (const p of parts) {
          if (p?.type !== "tool_result") continue;
          const block: ToolResultBlock = {
            type: "tool_result",
            tool_use_id: String(p.tool_use_id ?? ""),
            content: resultContentToString(p.content),
            ...(p.is_error ? { is_error: true } : {}),
          };
          results.push(block);
          emit({
            type: "tool_result",
            toolUseId: block.tool_use_id,
            ok: !block.is_error,
            preview: block.content.slice(0, 600),
          });
        }
        if (!parented && results.length && input.hooks?.onToolResults) {
          enqueue(() => input.hooks!.onToolResults!(results));
        }
        break;
      }
      case "result": {
        sawResult = true;
        if (typeof ev.session_id === "string") cliSessionId = ev.session_id;
        usage = mapUsage((ev as { usage?: Record<string, unknown> }).usage);
        resultText = typeof ev.result === "string" ? ev.result : "";
        const isErr = Boolean(ev.is_error);
        ok = !isErr;
        stop = isErr ? (ev.subtype === "error_max_turns" ? "max_turns" : "error") : "done";
        break;
      }
      default:
        break;
    }
  });

  const exitCode: number | null = await new Promise((resolve) => {
    proc.on("close", (code) => resolve(code));
    proc.on("error", () => resolve(null));
  });
  await chain; // flush pending persistence
  if (timer) clearTimeout(timer);
  input.signal?.removeEventListener("abort", onAbort);

  if (aborted) {
    return { ok: false, cliSessionId, resultText, usage, stop: "aborted", exitCode };
  }
  if (!sawResult) {
    return {
      ok: false,
      cliSessionId,
      resultText: stderrTail.trim() || `claude exited ${exitCode} without a result event`,
      usage,
      stop: "error",
      exitCode,
    };
  }
  if (!ok && !resultText) resultText = stderrTail.trim() || "claude turn failed";
  return { ok, cliSessionId, resultText, usage, stop, exitCode };
}
