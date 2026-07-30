// OpenHands CLI turn driver — third forge/chat lane (ADR 0072).
// Brokk owns worktree/verify/PR; OpenHands owns the agent loop; LLM fuel is
// LiteLLM → OmniRoute via LLM_BASE_URL / LLM_API_KEY / LLM_MODEL (no Cursor/Claude
// seat in this process).
//
// Invocation (OpenHands CLI headless):
//   openhands --headless --json --override-with-envs --exit-without-confirmation -t "…"
// Optional resume: --resume <id>

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, TurnUsage } from "./types.js";
import { type CliTurnInput, type CliTurnOutcome } from "./claude-cli.js";

const ZERO_USAGE: TurnUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
};

function openhandsBin(): string {
  return process.env.BROKK_OPENHANDS_BIN || process.env.OPENHANDS_BIN || "openhands";
}

let available: boolean | null = null;

/** True when the OpenHands CLI is on PATH and LLM fuel env is present. */
export function openHandsCliAvailable(): boolean {
  if (available !== null) return available;
  const key = process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN;
  const base = process.env.LLM_BASE_URL || process.env.OPENAI_BASE_URL || process.env.ANTHROPIC_BASE_URL;
  if (!key || !base) {
    return (available = false);
  }
  try {
    const r = spawnSync(openhandsBin(), ["--version"], { timeout: 15_000, stdio: "ignore" });
    available = r.status === 0;
  } catch {
    available = false;
  }
  return available;
}

/** Env for the OpenHands child. Exported for unit tests. */
export function buildOpenHandsCliEnv(
  input: Pick<CliTurnInput, "model" | "gh" | "env">,
  src: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};
  // Broader than cursor-cli: the OH binary is a Python/uv stack and needs XDG,
  // SSL, and locale or it exits "ok" with only a Rich banner (no JSONL).
  for (const k of [
    "PATH",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",
    "HOME",
    "USER",
    "SHELL",
    "TERM",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "REQUESTS_CA_BUNDLE",
    "CURL_CA_BUNDLE",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
    "LD_LIBRARY_PATH",
  ]) {
    if (src[k]) out[k] = src[k]!;
  }
  out.HOME =
    src.BROKK_CLI_HOME || (src.HOME && src.HOME !== "/" ? src.HOME : "/home/brokk");
  out.TERM = out.TERM || "dumb";

  // Fuel — LiteLLM vkey or Omni fleet key. Prefer LLM_*; fall back to gateway envs.
  const apiKey = src.LLM_API_KEY || src.OPENAI_API_KEY || src.ANTHROPIC_AUTH_TOKEN || "";
  const baseUrl = (src.LLM_BASE_URL || src.OPENAI_BASE_URL || src.ANTHROPIC_BASE_URL || "").replace(
    /\/$/,
    "",
  );
  // OpenHands expects …/v1; Brokk often stores LiteLLM root without suffix.
  const withV1 = !baseUrl
    ? ""
    : baseUrl.endsWith("/v1")
      ? baseUrl
      : `${baseUrl}/v1`;
  out.LLM_API_KEY = apiKey;
  out.LLM_BASE_URL = withV1;
  out.LLM_MODEL =
    input.model ||
    src.LLM_MODEL ||
    src.BROKK_OPENHANDS_MODEL ||
    "openai/cursor/auto";
  out.OPENHANDS_SUPPRESS_BANNER = "1";
  // Brokk worktree IS the workspace — no nested Docker sandbox (forge has no sock).
  out.RUNTIME = src.BROKK_OPENHANDS_RUNTIME || "process";
  // Persist under a Brokk-owned dir — ad-hoc root smokes can leave ~/.openhands
  // root-owned and the dropped forge uid then crashes on first write.
  out.OH_PERSISTENCE_DIR =
    src.OH_PERSISTENCE_DIR || `${out.HOME.replace(/\/$/, "")}/.openhands-brokk`;

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
    inputTokens: n(u.inputTokens ?? u.input_tokens ?? u.prompt_tokens),
    outputTokens: n(u.outputTokens ?? u.output_tokens ?? u.completion_tokens),
    cacheReadTokens: n(u.cacheReadTokens ?? u.cache_read_input_tokens),
    cacheCreationTokens: n(u.cacheWriteTokens ?? u.cache_creation_input_tokens),
  };
}

/** Flatten OH content blocks / nested text into a readable string. */
export function ohText(value: unknown, max = 2000): string {
  if (value == null) return "";
  if (typeof value === "string") return value.slice(0, max);
  if (typeof value === "number" || typeof value === "boolean") return String(value).slice(0, max);
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const item of value) {
      if (typeof item === "string") parts.push(item);
      else if (item && typeof item === "object") {
        const o = item as Record<string, unknown>;
        if (typeof o.text === "string") parts.push(o.text);
        else if (typeof o.content === "string") parts.push(o.content);
        else if (typeof o.message === "string") parts.push(o.message);
      }
    }
    return parts.join("\n").slice(0, max);
  }
  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    const nested = ohText(o.text ?? o.content ?? o.message ?? o.preview, max);
    if (nested) return nested;
    try {
      return JSON.stringify(value).slice(0, max);
    } catch {
      return "";
    }
  }
  return "";
}

function ohToolName(raw: Record<string, unknown>, action?: Record<string, unknown> | null): string {
  const from =
    raw.tool_name ??
    action?.tool_name ??
    action?.name ??
    action?.action ??
    (typeof action?.kind === "string" && !/Event$/i.test(action.kind) ? action.kind : null) ??
    raw.name;
  if (typeof from === "string" && from && !/^ActionEvent$/i.test(from) && !/^ObservationEvent$/i.test(from)) {
    return from;
  }
  // FinishAction → finish, TerminalObservation stays last-resort
  const kind = String(action?.kind ?? raw.kind ?? "");
  const m = kind.match(/^(.*)(Action|Observation)$/i);
  if (m?.[1]) return m[1].replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
  return from ? String(from) : "action";
}

function ohToolInput(raw: Record<string, unknown>, action?: Record<string, unknown> | null): Record<string, unknown> {
  const src = action ?? raw;
  const args = src.args ?? src.inputs ?? src.arguments;
  if (args && typeof args === "object" && !Array.isArray(args)) return args as Record<string, unknown>;
  if (typeof args === "string") {
    try {
      const parsed = JSON.parse(args) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      /* keep falling through */
    }
    return { value: args };
  }
  const out: Record<string, unknown> = {};
  for (const k of ["command", "path", "kind", "security_risk", "summary"] as const) {
    if (src[k] != null) out[k] = src[k];
  }
  if (Object.keys(out).length) return out;
  return {};
}

/**
 * Map one OpenHands 1.14+ event (JSONL / conversation event) → AgentEvent(s).
 * Exported for unit tests — OH uses `kind: ActionEvent` + `tool_name`, not
 * Anthropic-shaped tool_use blocks.
 */
export function mapOpenHandsEvent(
  raw: Record<string, unknown>,
  emit: (e: AgentEvent) => void,
  toolIds: Map<string, string>,
): void {
  const kind = String(raw.kind ?? raw.type ?? raw.event_type ?? "");
  const action = raw.action && typeof raw.action === "object" ? (raw.action as Record<string, unknown>) : null;
  const observation =
    raw.observation && typeof raw.observation === "object" ? (raw.observation as Record<string, unknown>) : null;

  // Agent errors (bad tool args, etc.)
  if (/AgentError|error_event/i.test(kind) || raw.error) {
    const text = ohText(raw.error ?? raw.message ?? raw.content) || kind || "openhands error";
    emit({ type: "error", message: text.slice(0, 2000) });
    return;
  }

  const isAction =
    /ActionEvent/i.test(kind) ||
    (!!raw.tool_name && !!action && !observation) ||
    (!!action && !observation && /Action/i.test(String(action.kind ?? kind)));
  if (isAction && !observation) {
    const name = ohToolName(raw, action);
    const id = String(raw.tool_call_id ?? action?.id ?? raw.id ?? `oh-${toolIds.size + 1}`);
    toolIds.set(id, name);
    emit({ type: "tool_use", id, name, input: ohToolInput(raw, action) });
    const thought = ohText(raw.thought ?? raw.reasoning_content ?? raw.summary);
    if (thought) emit({ type: "text_delta", text: thought });
    return;
  }

  const isObservation =
    /ObservationEvent/i.test(kind) ||
    !!observation ||
    (!!raw.tool_name && !!raw.action_id && !action);
  if (isObservation) {
    const obs = observation ?? raw;
    const toolUseId = String(
      raw.action_id ?? raw.tool_call_id ?? (obs as { cause?: string }).cause ?? [...toolIds.keys()].at(-1) ?? "oh-unknown",
    );
    const name = ohToolName(raw, null);
    if (!toolIds.has(toolUseId)) toolIds.set(toolUseId, name);
    const content =
      ohText((obs as { content?: unknown }).content) ||
      ohText((obs as { message?: unknown }).message) ||
      ohText(obs).slice(0, 2000);
    const exit = (obs as { extras?: { exit_code?: number } }).extras?.exit_code;
    const ok =
      exit === undefined
        ? !((obs as { is_error?: boolean }).is_error === true)
        : Number(exit) === 0;
    emit({
      type: "tool_result",
      toolUseId,
      ok,
      preview: content.slice(0, 2000) || `(${name})`,
    });
    return;
  }

  // Skip system/bootstrap noise
  if (/System|Console|Conditional/i.test(kind) && !raw.message) return;

  const text =
    ohText(raw.message) ||
    ohText(raw.content) ||
    ohText(raw.thought) ||
    ohText(raw.reasoning_content) ||
    ohText((raw.llm_message as { content?: unknown } | undefined)?.content);
  if (text) emit({ type: "text_delta", text });
}

/** @deprecated use mapOpenHandsEvent — kept as the internal name in the turn loop. */
function emitOhEvent(raw: Record<string, unknown>, emit: (e: AgentEvent) => void, toolIds: Map<string, string>): void {
  mapOpenHandsEvent(raw, emit, toolIds);
}

export async function runOpenHandsCliTurn(input: CliTurnInput): Promise<CliTurnOutcome> {
  const emit = input.emit ?? (() => {});
  // Prompt via file (`-f`) — forge prompts are large; `-t` blows argv / truncates.
  const promptBody = input.appendSystem
    ? `${input.appendSystem}\n\n---\n\n${input.prompt}`
    : input.prompt;
  const promptDir = await mkdtemp(join(tmpdir(), "brokk-oh-"));
  const promptFile = join(promptDir, `task-${randomBytes(4).toString("hex")}.md`);
  await writeFile(promptFile, promptBody, "utf8");

  const args = [
    "--headless",
    "--json",
    "--override-with-envs",
    "--exit-without-confirmation",
    "-f",
    promptFile,
  ];
  if (input.resume) {
    args.push("--resume", input.resume);
  }

  // input.env (per-run overrides, e.g. an org fuel key → OmniRoute · ASGARD-25)
  // wins over the ambient process.env. Absent → exactly process.env as before.
  const env = buildOpenHandsCliEnv(input, { ...process.env, ...(input.env ?? {}) });
  emit({ type: "status", phase: "openhands_start", detail: { model: env.LLM_MODEL } });

  try {
    return await new Promise((resolve) => {
      const child = spawn(openhandsBin(), args, {
        cwd: input.cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let resultText = "";
      let usage: TurnUsage = { ...ZERO_USAGE };
      let cliSessionId: string | null = input.resume ?? null;
      const toolIds = new Map<string, string>();
      let jsonEvents = 0;
      let stderrTail = "";
      let settled = false;
      // OpenHands 1.14 often prints pretty multi-line JSON after a `--JSON Event--`
      // marker instead of strict JSONL — accumulate until parse succeeds.
      let prettyBuf: string | null = null;

      const finish = (outcome: CliTurnOutcome) => {
        if (settled) return;
        settled = true;
        resolve(outcome);
      };

      const handleJson = (raw: Record<string, unknown>) => {
        jsonEvents += 1;
        if (typeof raw.conversation_id === "string") cliSessionId = raw.conversation_id;
        if (typeof raw.id === "string" && (raw.type === "conversation" || raw.conversation_id)) {
          cliSessionId = String(raw.conversation_id ?? raw.id);
        }
        if (raw.usage || raw.token_usage) {
          usage = mapUsage((raw.usage ?? raw.token_usage) as Record<string, unknown>);
          emit({ type: "usage", usage });
        }
        const msg = raw.message ?? raw.content;
        if (typeof msg === "string" && msg && (raw.type === "message" || raw.role === "assistant")) {
          resultText = msg;
        }
        emitOhEvent(raw, emit, toolIds);
      };

      const onLine = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        if (trimmed === "--JSON Event--" || trimmed === "JSON Event") {
          prettyBuf = "";
          return;
        }
        if (prettyBuf !== null) {
          const buf = prettyBuf + (prettyBuf ? "\n" : "") + line;
          try {
            handleJson(JSON.parse(buf) as Record<string, unknown>);
            prettyBuf = null;
          } catch {
            // keep buffering until the object closes
            prettyBuf = buf.length > 2_000_000 ? null : buf;
          }
          return;
        }
        try {
          handleJson(JSON.parse(trimmed) as Record<string, unknown>);
        } catch {
          // Banner / TUI noise
        }
      };

      const rlOut = createInterface({ input: child.stdout! });
      const rlErr = createInterface({ input: child.stderr! });
      rlOut.on("line", onLine);
      // OH sometimes emits JSONL on stderr when Rich owns stdout.
      rlErr.on("line", (line) => {
        onLine(line);
        stderrTail = (stderrTail + "\n" + line).slice(-4000);
      });

      const timeoutMs = input.timeoutMs ?? 3_600_000;
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish({
          ok: false,
          cliSessionId,
          resultText: resultText || "openhands turn timed out",
          usage,
          stop: "error",
          exitCode: null,
        });
      }, timeoutMs);

      if (input.signal) {
        const onAbort = () => {
          child.kill("SIGTERM");
        };
        if (input.signal.aborted) onAbort();
        else input.signal.addEventListener("abort", onAbort, { once: true });
      }

      child.on("error", (err) => {
        clearTimeout(timer);
        finish({
          ok: false,
          cliSessionId,
          resultText: String(err),
          usage,
          stop: "error",
          exitCode: null,
        });
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        // Exit 0 with zero JSONL events = CLI bailed (settings/banner) without a turn.
        const worked = jsonEvents > 0 || toolIds.size > 0;
        const ok = code === 0 && worked;
        if (!resultText && !ok) {
          resultText =
            stderrTail.trim().slice(-1500) ||
            (code === 0
              ? "openhands exited 0 without JSONL agent events (no real turn)"
              : `openhands exited ${code}`);
        }
        input.hooks?.onAssistant?.(
          [{ type: "text", text: resultText || `(openhands json events=${jsonEvents})` }],
          { usage },
        );
        finish({
          ok,
          cliSessionId,
          resultText,
          usage,
          stop: input.signal?.aborted ? "aborted" : ok ? "done" : "error",
          exitCode: code,
        });
      });
    });
  } finally {
    await rm(promptDir, { recursive: true, force: true }).catch(() => {});
  }
}
