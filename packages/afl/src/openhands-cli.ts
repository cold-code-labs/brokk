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
  for (const k of ["PATH", "TMPDIR", "LANG", "TZ", "HOME", "USER", "SHELL"]) {
    if (src[k]) out[k] = src[k]!;
  }
  out.HOME =
    src.BROKK_CLI_HOME || (src.HOME && src.HOME !== "/" ? src.HOME : "/home/brokk");

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

/** Best-effort map of OpenHands JSONL events → AgentEvent. */
function emitOhEvent(raw: Record<string, unknown>, emit: (e: AgentEvent) => void, toolIds: Map<string, string>): void {
  const type = String(raw.type ?? raw.event_type ?? "");
  const action = raw.action as Record<string, unknown> | string | undefined;
  const observation = raw.observation as Record<string, unknown> | string | undefined;

  if (type === "action" || raw.action) {
    const act = typeof action === "object" && action ? action : raw;
    const name = String(
      (act as { action?: string }).action ??
        (act as { name?: string }).name ??
        (typeof action === "string" ? action : "action"),
    );
    const id = String((act as { id?: string }).id ?? raw.id ?? `oh-${toolIds.size + 1}`);
    toolIds.set(id, name);
    const input =
      (act as { args?: unknown }).args ??
      (act as { inputs?: unknown }).inputs ??
      (act as { path?: unknown }).path ??
      {};
    emit({ type: "tool_use", id, name, input: typeof input === "object" && input ? input : { value: input } });
    return;
  }

  if (type === "observation" || raw.observation) {
    const obs = typeof observation === "object" && observation ? observation : raw;
    const cause = String((obs as { cause?: string }).cause ?? (obs as { action_id?: string }).action_id ?? "");
    const toolUseId = cause || [...toolIds.keys()].at(-1) || "oh-unknown";
    const content = String(
      (obs as { content?: string }).content ??
        (obs as { message?: string }).message ??
        JSON.stringify(obs).slice(0, 2000),
    );
    const ok = !/error|fail/i.test(String((obs as { extras?: { exit_code?: number } }).extras?.exit_code ?? ""));
    emit({
      type: "tool_result",
      toolUseId,
      ok,
      preview: content.slice(0, 2000),
    });
    return;
  }

  if (type === "message" || type === "agent_state_changed" || raw.message || raw.content) {
    const text = String(
      (raw as { message?: string }).message ??
        (raw as { content?: string }).content ??
        (raw as { thought?: string }).thought ??
        "",
    );
    if (text) emit({ type: "text_delta", text });
  }
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

  const env = buildOpenHandsCliEnv(input);
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

      const finish = (outcome: CliTurnOutcome) => {
        if (settled) return;
        settled = true;
        resolve(outcome);
      };

      const onLine = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        try {
          const raw = JSON.parse(trimmed) as Record<string, unknown>;
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
        } catch {
          // Banner / TUI noise — never overwrite a real assistant result.
        }
      };

      const rlOut = createInterface({ input: child.stdout! });
      const rlErr = createInterface({ input: child.stderr! });
      rlOut.on("line", onLine);
      rlErr.on("line", (line) => {
        stderrTail = (stderrTail + "\n" + line).slice(-4000);
        if (/error|fail|traceback/i.test(line) && !resultText) {
          resultText = line.slice(0, 2000);
        }
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
