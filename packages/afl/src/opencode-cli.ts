// OpenCode CLI turn driver — Brokk Chat lane (ADR 0073 / 0074).
// Brokk owns checkout/session/UI; OpenCode owns the interactive agent loop;
// LLM fuel is LiteLLM → OmniRoute via openai-compatible provider config.
//
// Invocation:
//   opencode run --format json --auto --dir <cwd> [-m provider/model] [-s session] "…"

import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentEvent, TurnUsage } from "./types.js";
import { type CliTurnInput, type CliTurnOutcome } from "./claude-cli.js";

const ZERO_USAGE: TurnUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
};

function opencodeBin(): string {
  return process.env.BROKK_OPENCODE_BIN || process.env.OPENCODE_BIN || "opencode";
}

let available: boolean | null = null;

/** Writable dirs for OpenCode state — the Coolify volume often has root-owned
 *  `.local` under HOME/work from earlier entrypoints; without this, `opencode
 *  --version` exits 1 (EACCES) and the engine chip stays unavailable. */
function openCodeStateEnv(src: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const home =
    src.BROKK_CLI_HOME ||
    (src.HOME && src.HOME !== "/" ? src.HOME : "/home/brokk");
  const base = src.BROKK_OPENCODE_STATE_DIR || `${home}/work/.opencode-brokk`;
  return {
    HOME: home,
    XDG_DATA_HOME: src.XDG_DATA_HOME || `${base}/share`,
    XDG_STATE_HOME: src.XDG_STATE_HOME || `${base}/state`,
    XDG_CACHE_HOME: src.XDG_CACHE_HOME || `${base}/cache`,
    XDG_CONFIG_HOME: src.XDG_CONFIG_HOME || `${base}/config`,
  };
}

/** True when the OpenCode CLI is on PATH and Omni/LiteLLM fuel env is present. */
export function openCodeCliAvailable(): boolean {
  if (available !== null) return available;
  const key = process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN;
  const base = process.env.LLM_BASE_URL || process.env.OPENAI_BASE_URL || process.env.ANTHROPIC_BASE_URL;
  if (!key || !base) {
    return (available = false);
  }
  try {
    const r = spawnSync(opencodeBin(), ["--version"], {
      timeout: 15_000,
      stdio: "ignore",
      env: { ...process.env, ...openCodeStateEnv() },
    });
    available = r.status === 0;
  } catch {
    available = false;
  }
  return available;
}

/** Env + inline config for the OpenCode child. Exported for unit tests. */
export function buildOpenCodeCliEnv(
  input: Pick<CliTurnInput, "model" | "gh" | "env">,
  src: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};
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
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
  ]) {
    if (src[k]) out[k] = src[k]!;
  }
  out.HOME =
    src.BROKK_CLI_HOME || (src.HOME && src.HOME !== "/" ? src.HOME : "/home/brokk");
  Object.assign(out, openCodeStateEnv({ ...src, HOME: out.HOME }));
  out.TERM = out.TERM || "dumb";

  const apiKey = src.LLM_API_KEY || src.OPENAI_API_KEY || src.ANTHROPIC_AUTH_TOKEN || "";
  const baseUrl = (src.LLM_BASE_URL || src.OPENAI_BASE_URL || src.ANTHROPIC_BASE_URL || "").replace(
    /\/$/,
    "",
  );
  const withV1 = !baseUrl ? "" : baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;
  out.OPENAI_API_KEY = apiKey;
  out.OPENAI_BASE_URL = withV1;
  // Also expose LLM_* — some OpenCode plugins prefer them.
  out.LLM_API_KEY = apiKey;
  out.LLM_BASE_URL = withV1;

  const modelId =
    input.model ||
    src.BROKK_OPENCODE_MODEL ||
    src.LLM_MODEL ||
    "auto";
  // Strip a leading provider/ if the operator already passed omni/…
  const bareModel = modelId.includes("/") ? modelId.split("/").slice(1).join("/") : modelId;

  const mcpBrokk = src.BROKK_MCP_COMMAND?.trim();
  const mcpBlock = mcpBrokk
    ? {
        brokk: {
          type: "local",
          command: mcpBrokk.split(/\s+/),
          enabled: true,
          environment: {
            BROKK_API_URL: src.BROKK_API_URL || "http://api:8787",
            BROKK_API_SECRET: src.BROKK_API_SECRET || "",
            BROKK_PROJECT_ID: src.BROKK_PROJECT_ID || "",
          },
        },
      }
    : undefined;

  const config = {
    $schema: "https://opencode.ai/config.json",
    model: `omni/${bareModel}`,
    provider: {
      omni: {
        npm: "@ai-sdk/openai-compatible",
        name: "CCL Omni",
        options: {
          baseURL: withV1,
          apiKey,
        },
        models: {
          [bareModel]: { name: bareModel },
        },
      },
    },
    ...(mcpBlock ? { mcp: mcpBlock } : {}),
  };
  out.OPENCODE_CONFIG_CONTENT = JSON.stringify(config);
  out.OPENCODE_DISABLE_AUTOUPDATE = "1";
  out.OPENCODE_PERMISSION = JSON.stringify({ "*": "allow" });

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
    inputTokens: n(u.inputTokens ?? u.input_tokens ?? u.tokensIn),
    outputTokens: n(u.outputTokens ?? u.output_tokens ?? u.tokensOut),
    cacheReadTokens: n(u.cacheReadTokens ?? u.cache_read_input_tokens),
    cacheCreationTokens: n(u.cacheWriteTokens ?? u.cache_creation_input_tokens),
  };
}

/** Parse one OpenCode `--format json` line into AgentEvents. Exported for tests. */
export function handleOpenCodeJsonLine(
  line: string,
  emit: (e: AgentEvent) => void,
  state: {
    sessionId: string | null;
    resultText: string;
    usage: TurnUsage;
    toolIds: Map<string, string>;
  },
): void {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }

  if (typeof raw.sessionID === "string") state.sessionId = raw.sessionID;
  if (typeof raw.sessionId === "string") state.sessionId = raw.sessionId;

  const type = typeof raw.type === "string" ? raw.type : "";
  const part = (raw.part ?? raw.properties) as Record<string, unknown> | undefined;

  if (raw.usage || (part && (part as { usage?: unknown }).usage)) {
    state.usage = mapUsage(
      (raw.usage ?? (part as { usage?: Record<string, unknown> }).usage) as Record<string, unknown>,
    );
    emit({ type: "usage", usage: state.usage });
  }

  if (type === "text" || (part && part.type === "text")) {
    const textPart = type === "text" ? part : part;
    const text =
      (typeof textPart?.text === "string" && textPart.text) ||
      (typeof raw.text === "string" && raw.text) ||
      "";
    if (text) {
      state.resultText = text;
      emit({ type: "text_delta", text });
    }
    return;
  }

  if (type === "tool_use" || (part && part.type === "tool")) {
    const toolPart = part ?? {};
    const id = String(toolPart.id ?? raw.id ?? `oc-${state.toolIds.size}`);
    const name = String(toolPart.tool ?? toolPart.name ?? raw.tool ?? "tool");
    const input =
      (toolPart.state as { input?: Record<string, unknown> } | undefined)?.input ??
      (toolPart.input as Record<string, unknown> | undefined) ??
      {};
    state.toolIds.set(id, name);
    emit({ type: "tool_use", id, name, input });
    const status = (toolPart.state as { status?: string } | undefined)?.status;
    const output =
      (toolPart.state as { output?: string } | undefined)?.output ??
      (toolPart.state as { error?: string } | undefined)?.error;
    if (status === "completed" || status === "error") {
      emit({
        type: "tool_result",
        toolUseId: id,
        ok: status !== "error",
        preview: typeof output === "string" ? output.slice(0, 500) : status,
      });
    }
    return;
  }

  if (type === "step_start" || type === "step_finish") {
    emit({ type: "status", phase: type, detail: part ?? {} });
  }
}

export async function runOpenCodeCliTurn(input: CliTurnInput): Promise<CliTurnOutcome> {
  const emit = input.emit ?? (() => {});
  const env = buildOpenCodeCliEnv(input);

  // Ensure config dir exists under Brokk HOME (OpenCode may also write sessions there).
  try {
    await mkdir(join(env.HOME, ".config", "opencode"), { recursive: true });
    await writeFile(
      join(env.HOME, ".config", "opencode", "opencode.json"),
      env.OPENCODE_CONFIG_CONTENT,
      "utf8",
    );
  } catch {
    // OPENCODE_CONFIG_CONTENT alone is enough when the write fails.
  }

  const model =
    input.model ||
    process.env.BROKK_OPENCODE_MODEL ||
    process.env.LLM_MODEL ||
    "auto";
  const bareModel = model.includes("/") ? model.split("/").slice(1).join("/") : model;

  const prompt =
    input.appendSystem && !input.resume
      ? `${input.appendSystem}\n\n---\n\n${input.prompt}`
      : input.prompt;

  const args = [
    "run",
    "--format",
    "json",
    "--auto",
    "--dir",
    input.cwd,
    "-m",
    `omni/${bareModel}`,
  ];
  if (input.resume) args.push("--session", input.resume);
  args.push(prompt);

  emit({ type: "status", phase: "opencode_start", detail: { model: `omni/${bareModel}` } });

  return await new Promise((resolve) => {
    const child = spawn(opencodeBin(), args, {
      cwd: input.cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const state = {
      sessionId: (input.resume as string | null) ?? null,
      resultText: "",
      usage: { ...ZERO_USAGE } as TurnUsage,
      toolIds: new Map<string, string>(),
    };
    let stderrTail = "";
    let settled = false;
    let aborted = false;

    const finish = (outcome: CliTurnOutcome) => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };

    const kill = () => {
      aborted = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref?.();
    };
    input.signal?.addEventListener("abort", kill, { once: true });
    const timer =
      input.timeoutMs && input.timeoutMs > 0 ? setTimeout(kill, input.timeoutMs) : null;
    timer?.unref?.();

    child.stderr.on("data", (d: Buffer) => {
      stderrTail = (stderrTail + d.toString()).slice(-4000);
    });

    const rl = createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      if (!line.trim()) return;
      handleOpenCodeJsonLine(line, emit, state);
    });

    child.on("error", (err) => {
      clearTimeout(timer ?? undefined);
      finish({
        ok: false,
        stop: "error",
        resultText: err.message,
        usage: state.usage,
        cliSessionId: state.sessionId,
        exitCode: null,
      });
    });

    child.on("close", (code) => {
      clearTimeout(timer ?? undefined);
      if (aborted) {
        finish({
          ok: false,
          stop: "aborted",
          resultText: state.resultText || "aborted",
          usage: state.usage,
          cliSessionId: state.sessionId,
          exitCode: code,
        });
        return;
      }
      const ok = code === 0;
      finish({
        ok,
        stop: ok ? "done" : "error",
        resultText:
          state.resultText ||
          (ok ? "" : stderrTail.trim() || `opencode exited ${code ?? "?"}`),
        usage: state.usage,
        cliSessionId: state.sessionId,
        exitCode: code,
      });
    });
  });
}
