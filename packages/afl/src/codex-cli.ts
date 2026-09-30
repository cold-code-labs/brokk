// OpenAI Codex CLI turn driver — native forge lane alongside claude/cursor/
// openhands/opencode. Brokk owns worktree/verify/PR; Codex owns the agent loop
// and its own session continuity (resume by thread id).
//
// Invocation (official headless JSONL):
//   codex exec --json --sandbox workspace-write --skip-git-repo-check [-m MODEL] -
// Resume:
//   codex exec resume THREAD_ID --json --sandbox workspace-write --skip-git-repo-check [-m MODEL] -
// The prompt is written to stdin (`-`) so large prompts never hit argv limits.
//
// Auth is NOT probed here. Codex may be logged in via a persisted HOME/CODEX_HOME
// session, so availability only proves the binary exists.

import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import type { AgentEvent, TurnUsage } from "./types.js";
import { type CliTurnInput, type CliTurnOutcome } from "./claude-cli.js";

const ZERO_USAGE: TurnUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
};

function codexBin(): string {
  return process.env.BROKK_CODEX_CLI_BIN || process.env.CODEX_BIN || "codex";
}

let available: boolean | null = null;

/** True when the Codex CLI binary answers `--version`. Does not require an API key. */
export function codexCliAvailable(): boolean {
  if (available !== null) return available;
  try {
    const r = spawnSync(codexBin(), ["--version"], { timeout: 15_000, stdio: "ignore" });
    available = r.status === 0;
  } catch {
    available = false;
  }
  return available;
}

/** Allowlisted env for the Codex child. Exported for unit tests. */
export function buildCodexCliEnv(
  input: CliTurnInput,
  src: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const k of ["PATH", "TMPDIR", "LANG", "TZ", "TERM", "HOME", "CODEX_HOME"]) {
    if (src[k]) out[k] = src[k];
  }
  for (const k of [
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "OPENAI_ORG_ID",
    "OPENAI_PROJECT_ID",
    "CODEX_API_KEY",
    "CODEX_ACCESS_TOKEN",
  ]) {
    if (src[k]) out[k] = src[k];
  }
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

/** argv for `codex exec` / `codex exec resume`. The trailing `-` reads the prompt from stdin. */
export function buildCodexArgs(input: CliTurnInput): string[] {
  const args = ["exec"];
  if (input.resume) args.push("resume", input.resume);
  args.push("--json", "--sandbox", "workspace-write", "--skip-git-repo-check");
  if (input.model) args.push("--model", input.model);
  args.push("-");
  return args;
}

/**
 * Grounding text is prepended only on a fresh session. Resume sends the bare
 * prompt so Codex's own thread does not get the same system block twice.
 */
export function buildCodexPrompt(input: CliTurnInput): string {
  if (input.appendSystem && !input.resume) return `${input.appendSystem}\n\n---\n\n${input.prompt}`;
  return input.prompt;
}

/** Mutable parse state shared across JSONL lines of one turn. */
export interface CodexJsonState {
  threadId: string | null;
  resultText: string;
  usage: TurnUsage;
  terminal: "success" | "error" | null;
  /** item id → tool name, so the matching tool_result reuses the tool_use name. */
  tools: Map<string, string>;
  /** item id → reasoning text already emitted (frames arrive cumulative). */
  reasoning: Map<string, string>;
}

export function newCodexJsonState(): CodexJsonState {
  return {
    threadId: null,
    resultText: "",
    usage: { ...ZERO_USAGE },
    terminal: null,
    tools: new Map(),
    reasoning: new Map(),
  };
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function mapUsage(u: unknown): TurnUsage {
  const o = (u ?? {}) as Record<string, unknown>;
  return {
    inputTokens: num(o.input_tokens),
    outputTokens: num(o.output_tokens),
    cacheReadTokens: num(o.cached_input_tokens),
    cacheCreationTokens: num(o.cache_write_input_tokens),
  };
}

interface CodexItem {
  id?: string;
  type?: string;
  text?: string;
  command?: string;
  aggregated_output?: string;
  exit_code?: number | null;
  status?: string;
  changes?: unknown;
  server?: string;
  tool?: string;
  arguments?: unknown;
  result?: unknown;
  error?: unknown;
  query?: string;
  items?: unknown;
}

/** New suffix of a cumulative reasoning frame; "" when the frame adds nothing. */
function reasoningDelta(prev: string, next: string): string {
  if (!next || next === prev) return "";
  if (prev && next.startsWith(prev)) return next.slice(prev.length);
  return next;
}

function toolName(item: CodexItem): string {
  switch (item.type) {
    case "command_execution":
      return "shell";
    case "file_change":
      return "apply_patch";
    case "web_search":
      return "web_search";
    case "mcp_tool_call":
      return item.server ? `${item.server}.${item.tool ?? "tool"}` : item.tool || "mcp_tool";
    default:
      return item.type || "tool";
  }
}

function toolInput(item: CodexItem): Record<string, unknown> {
  switch (item.type) {
    case "command_execution":
      return { command: str(item.command) };
    case "file_change":
      return { changes: item.changes ?? null };
    case "web_search":
      return { query: str(item.query) };
    case "mcp_tool_call":
      return (item.arguments as Record<string, unknown>) ?? {};
    default:
      return {};
  }
}

function toolPreview(item: CodexItem): string {
  if (item.type === "command_execution") return str(item.aggregated_output).slice(0, 4000);
  if (item.type === "web_search") return JSON.stringify(item.result ?? item.aggregated_output ?? "").slice(0, 4000);
  if (item.result !== undefined) return JSON.stringify(item.result).slice(0, 4000);
  if (item.aggregated_output) return str(item.aggregated_output).slice(0, 4000);
  return "";
}

function toolOk(item: CodexItem): boolean {
  if (item.status === "failed" || item.error) return false;
  if (typeof item.exit_code === "number") return item.exit_code === 0;
  return true;
}

/**
 * Translate one Codex JSONL object into canonical AgentEvents, mutating `state`.
 * Returns the error message when the line is a terminal failure, else null.
 */
export function handleCodexJsonLine(
  raw: Record<string, unknown>,
  emit: (e: AgentEvent) => void,
  state: CodexJsonState,
): string | null {
  const type = str(raw.type);
  const item = (raw.item ?? null) as CodexItem | null;

  if (type === "thread.started") {
    const id = str(raw.thread_id);
    if (id) state.threadId = id;
    emit({ type: "status", phase: "codex_init", detail: { threadId: state.threadId } });
    return null;
  }
  if (type === "turn.started") {
    emit({ type: "status", phase: "codex_turn_started" });
    return null;
  }
  if (type === "turn.completed") {
    state.usage = mapUsage(raw.usage);
    state.terminal = "success";
    return null;
  }
  if (type === "turn.failed" || type === "error") {
    const err = raw.error as { message?: string } | string | undefined;
    const message =
      (typeof err === "string" ? err : err?.message) || str(raw.message) || "codex turn failed";
    state.terminal = "error";
    emit({ type: "error", message });
    return message;
  }

  if (!item || !item.type) return null;

  if (item.type === "error") {
    const message = str(item.error) || str(item.text) || "codex item error";
    emit({ type: "error", message });
    return null;
  }

  if (item.type === "agent_message" && type === "item.completed") {
    const text = str(item.text);
    if (text) {
      state.resultText = text;
      emit({ type: "text_delta", text });
    }
    return null;
  }

  if (item.type === "reasoning") {
    const id = item.id || "reasoning";
    const next = str(item.text);
    const delta = reasoningDelta(state.reasoning.get(id) ?? "", next);
    state.reasoning.set(id, next);
    if (delta) emit({ type: "thinking_delta", text: delta });
    return null;
  }

  if (item.type === "todo_list") {
    emit({ type: "status", phase: "codex_todo", detail: { items: item.items ?? [] } });
    return null;
  }

  if (
    item.type === "command_execution" ||
    item.type === "file_change" ||
    item.type === "mcp_tool_call" ||
    item.type === "web_search"
  ) {
    const id = item.id || item.type;
    if (type === "item.started" || (type === "item.updated" && !state.tools.has(id))) {
      state.tools.set(id, toolName(item));
      emit({ type: "tool_use", id, name: toolName(item), input: toolInput(item) });
    }
    if (type === "item.completed") {
      if (!state.tools.has(id)) {
        state.tools.set(id, toolName(item));
        emit({ type: "tool_use", id, name: toolName(item), input: toolInput(item) });
      }
      emit({ type: "tool_result", toolUseId: id, ok: toolOk(item), preview: toolPreview(item) });
    }
  }
  return null;
}

/**
 * One non-interactive Codex turn. `turn.completed` is the authoritative success;
 * `turn.failed`/`error` always win. A clean exit with text but no terminal event
 * is accepted as success for forward compatibility.
 */
export async function runCodexCliTurn(input: CliTurnInput): Promise<CliTurnOutcome> {
  const emit = input.emit ?? (() => {});
  const child = spawn(codexBin(), buildCodexArgs(input), {
    cwd: input.cwd,
    env: buildCodexCliEnv(input),
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });
  child.stdin.write(buildCodexPrompt(input));
  child.stdin.end();

  const state = newCodexJsonState();
  let failMsg: string | null = null;
  let aborted = false;
  let stderrTail = "";

  // Same teardown as claude-cli: the detached child leads its own process group,
  // so abort/timeout signals the GROUP (kill(-pid)) — SIGTERM to let Codex flush,
  // SIGKILL after 5s if it lingers. Orphan tool children die with the turn.
  const kill = () => {
    aborted = true;
    const pid = child.pid;
    const signalGroup = (sig: NodeJS.Signals) => {
      if (pid == null) return;
      try {
        process.kill(-pid, sig);
      } catch {
        try {
          child.kill(sig);
        } catch {
          /* already gone */
        }
      }
    };
    signalGroup("SIGTERM");
    setTimeout(() => signalGroup("SIGKILL"), 5_000).unref?.();
  };
  const onAbort = () => kill();
  input.signal?.addEventListener("abort", onAbort, { once: true });
  const timer =
    input.timeoutMs && input.timeoutMs > 0 ? setTimeout(kill, input.timeoutMs) : null;
  timer?.unref?.();

  child.stderr.on("data", (d: Buffer) => {
    stderrTail = (stderrTail + d.toString()).slice(-4000);
  });

  const rl = createInterface({ input: child.stdout! });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const msg = handleCodexJsonLine(JSON.parse(trimmed) as Record<string, unknown>, emit, state);
      if (msg) failMsg = msg;
    } catch {
      /* non-JSON noise on stdout — ignore */
    }
  }

  const exitCode: number | null = await new Promise((resolve) => {
    child.on("close", (code) => resolve(code));
    child.on("error", () => resolve(null));
  });
  if (timer) clearTimeout(timer);
  input.signal?.removeEventListener("abort", onAbort);

  const outcome = (ok: boolean, stop: CliTurnOutcome["stop"], text?: string): CliTurnOutcome => ({
    ok,
    stop,
    exitCode,
    cliSessionId: state.threadId,
    resultText: text ?? state.resultText,
    usage: state.usage,
  });

  if (aborted) return outcome(false, "aborted");
  // turn.failed / error always prevail over a clean-looking exit.
  if (state.terminal === "error" || failMsg) {
    return outcome(false, "error", state.resultText || failMsg || stderrTail.trim() || "codex turn failed");
  }
  // turn.completed is the authoritative success signal.
  if (state.terminal === "success") {
    if (state.resultText) {
      await input.hooks?.onAssistant?.([{ type: "text", text: state.resultText }], { usage: state.usage });
    }
    return outcome(true, "done");
  }
  // Defensive fallback for forward compatibility: clean exit + text, no terminal event.
  if (exitCode === 0 && state.resultText) {
    await input.hooks?.onAssistant?.([{ type: "text", text: state.resultText }], { usage: state.usage });
    return outcome(true, "done");
  }
  return outcome(
    false,
    "error",
    state.resultText || `codex exited ${exitCode} without a completed turn: ${stderrTail.trim() || "(no stderr)"}`,
  );
}
