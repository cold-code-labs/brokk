// Cursor Agent CLI turn driver — mirror of claude-cli.ts for `agent` binary.
// Same AgentEvent wire as the native AFL loop + claude-cli: text_delta,
// thinking_delta, tool_use, tool_result, usage. Continuity: --resume <session_id>.

import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import type { AgentEvent, ContentBlock, ToolResultBlock, TurnUsage } from "./types.js";
import {
  resultContentToString,
  type CliTurnHooks,
  type CliTurnInput,
  type CliTurnOutcome,
} from "./claude-cli.js";

const ZERO_USAGE: TurnUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
};

function agentBin(): string {
  return process.env.BROKK_CURSOR_CLI_BIN || process.env.CURSOR_AGENT_BIN || "agent";
}

let available: boolean | null = null;
export function cursorCliAvailable(): boolean {
  if (available !== null) return available;
  if (!process.env.CURSOR_API_KEY && !process.env.CURSOR_AUTH_TOKEN) {
    return (available = false);
  }
  try {
    const r = spawnSync(agentBin(), ["--version"], { timeout: 10_000, stdio: "ignore" });
    available = r.status === 0;
  } catch {
    available = false;
  }
  return available;
}

function cliEnv(input: CliTurnInput): Record<string, string> {
  const src = process.env;
  const out: Record<string, string> = {};
  for (const k of ["PATH", "TMPDIR", "LANG", "TZ"]) {
    if (src[k]) out[k] = src[k]!;
  }
  out.HOME =
    src.BROKK_CLI_HOME || (src.HOME && src.HOME !== "/" ? src.HOME : "/home/brokk");
  if (src.CURSOR_API_KEY) out.CURSOR_API_KEY = src.CURSOR_API_KEY;
  if (src.CURSOR_AUTH_TOKEN) out.CURSOR_AUTH_TOKEN = src.CURSOR_AUTH_TOKEN;
  out.GIT_AUTHOR_NAME = src.BROKK_GIT_NAME || "Brokk";
  out.GIT_AUTHOR_EMAIL = src.BROKK_GIT_EMAIL || "brokk@coldcodelabs.com";
  out.GIT_COMMITTER_NAME = out.GIT_AUTHOR_NAME;
  out.GIT_COMMITTER_EMAIL = out.GIT_AUTHOR_EMAIL;
  if (input.gh && (src.GH_TOKEN || src.GITHUB_TOKEN)) {
    out.GH_TOKEN = src.GH_TOKEN || src.GITHUB_TOKEN!;
    out.GITHUB_TOKEN = out.GH_TOKEN;
  }
  out.NO_COLOR = "1";
  return { ...out, ...(input.env ?? {}) };
}

function mapUsage(u: Record<string, unknown> | undefined | null): TurnUsage {
  if (!u) return { ...ZERO_USAGE };
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    inputTokens: n(u.inputTokens ?? u.input_tokens),
    outputTokens: n(u.outputTokens ?? u.output_tokens),
    cacheReadTokens: n(u.cacheReadTokens ?? u.cache_read_input_tokens),
    cacheCreationTokens: n(u.cacheWriteTokens ?? u.cache_creation_input_tokens),
  };
}

/** Cursor may send partial deltas OR full assistant text frames. Emit only the
 *  new suffix so the live scratchpad (and any fallback concat) stays readable. */
export function textDeltaFromFrame(streamed: string, frame: string): { delta: string; next: string } {
  if (!frame) return { delta: "", next: streamed };
  if (frame.startsWith(streamed)) {
    return { delta: frame.slice(streamed.length), next: frame };
  }
  if (streamed.includes(frame)) {
    return { delta: "", next: streamed };
  }
  const sep = streamed && !streamed.endsWith("\n") ? "\n" : "";
  return { delta: sep + frame, next: streamed + sep + frame };
}

export async function runCursorCliTurn(input: CliTurnInput): Promise<CliTurnOutcome> {
  const emit = input.emit ?? (() => {});
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--stream-partial-output",
    "--trust",
    "--force",
  ];
  if (input.model) args.push("--model", input.model);
  if (input.resume) args.push("--resume", input.resume);

  const prompt =
    input.appendSystem && !input.resume
      ? `${input.appendSystem}\n\n---\n\n${input.prompt}`
      : input.prompt;

  const proc = spawn(agentBin(), args, {
    cwd: input.cwd,
    env: cliEnv(input),
    stdio: ["pipe", "pipe", "pipe"],
  });
  proc.stdin.write(prompt);
  proc.stdin.end();

  let cliSessionId: string | null = input.resume ?? null;
  let usage: TurnUsage = { ...ZERO_USAGE };
  let resultText = "";
  let streamedText = "";
  let sawAssistantPersist = false;
  let stop: CliTurnOutcome["stop"] = "error";
  let ok = false;
  let aborted = false;
  let stderrTail = "";

  const kill = () => {
    aborted = true;
    proc.kill("SIGTERM");
    setTimeout(() => proc.kill("SIGKILL"), 5_000).unref?.();
  };
  input.signal?.addEventListener("abort", kill, { once: true });
  const timer =
    input.timeoutMs && input.timeoutMs > 0 ? setTimeout(kill, input.timeoutMs) : null;
  timer?.unref?.();

  proc.stderr.on("data", (d: Buffer) => {
    stderrTail = (stderrTail + d.toString()).slice(-4000);
  });

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
      return;
    }

    const parented = Boolean((ev as { parent_tool_use_id?: unknown }).parent_tool_use_id);

    switch (ev.type) {
      case "system": {
        if (ev.subtype === "init" && typeof ev.session_id === "string") {
          cliSessionId = ev.session_id;
          emit({ type: "status", phase: "cli_init", detail: { cliSessionId, model: ev.model } });
        }
        break;
      }
      case "thinking": {
        if (ev.subtype === "delta" && typeof ev.text === "string" && ev.text) {
          emit({ type: "thinking_delta", text: ev.text });
        }
        break;
      }
      case "assistant": {
        const msg = (ev as { message?: { content?: unknown[]; usage?: Record<string, unknown>; stop_reason?: string } })
          .message;
        const content = Array.isArray(msg?.content) ? msg!.content! : [];
        const blocks: ContentBlock[] = [];
        for (const part of content) {
          if (!part || typeof part !== "object") continue;
          const p = part as {
            type?: string;
            text?: string;
            id?: string;
            name?: string;
            input?: Record<string, unknown>;
            thinking?: string;
          };
          if (p.type === "text" && p.text) {
            const { delta, next } = textDeltaFromFrame(streamedText, p.text);
            streamedText = next;
            if (delta) emit({ type: "text_delta", text: delta });
            blocks.push({ type: "text", text: p.text });
          } else if (p.type === "thinking" && p.thinking) {
            emit({ type: "thinking_delta", text: p.thinking });
            blocks.push({ type: "thinking", thinking: p.thinking });
          } else if (p.type === "tool_use" && p.id && p.name) {
            const inputObj = p.input ?? {};
            emit({ type: "tool_use", id: p.id, name: p.name, input: inputObj });
            blocks.push({ type: "tool_use", id: p.id, name: p.name, input: inputObj });
          }
        }
        // Live: always text_delta / tool_use above. Persist only rounds that
        // include tool_use — partial text frames must NOT become chat_messages
        // rows (BROKK-36). Final prose lands once on `result`.
        if (!parented && blocks.some((b) => b.type === "tool_use")) {
          const meta = { usage: mapUsage(msg?.usage), stopReason: msg?.stop_reason };
          if (msg?.usage) {
            usage = meta.usage;
            emit({ type: "usage", usage });
          }
          if (input.hooks?.onAssistant) {
            sawAssistantPersist = true;
            enqueue(() => input.hooks!.onAssistant!(blocks, meta));
          }
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
        if (typeof ev.session_id === "string") cliSessionId = ev.session_id;
        if (typeof ev.result === "string") resultText = ev.result;
        usage = mapUsage(ev.usage as Record<string, unknown>);
        ok = ev.subtype === "success" || ev.is_error === false;
        stop = aborted ? "aborted" : ok ? "done" : "error";
        // Final prose once. Prefer `result` (not streamed concat) so the card
        // is not a wall of every narration chunk glued together.
        if (input.hooks?.onAssistant) {
          const text = (resultText || (!sawAssistantPersist ? streamedText : "")).trim();
          if (text) {
            enqueue(() =>
              input.hooks!.onAssistant!([{ type: "text", text }], {
                usage,
                stopReason: undefined,
              }),
            );
          }
        }
        break;
      }
      default:
        break;
    }
  });

  const exitCode: number | null = await new Promise((resolve) => {
    proc.on("close", (code) => resolve(code));
  });
  input.signal?.removeEventListener("abort", kill);
  if (timer) clearTimeout(timer);
  await chain;

  if (aborted) stop = "aborted";
  else if (!ok && stop === "error" && exitCode === 0 && resultText) {
    ok = true;
    stop = "done";
  }
  if (!ok && stop === "error" && stderrTail) {
    emit({ type: "status", phase: "cli_error", detail: { stderrTail: stderrTail.slice(-800) } });
  }

  if (!ok && !resultText) {
    resultText = stderrTail.trim() || `cursor-agent exited ${exitCode} without a result event`;
  }

  return { ok, cliSessionId, resultText, usage, stop, exitCode };
}

export type { CliTurnHooks, CliTurnInput, CliTurnOutcome };
