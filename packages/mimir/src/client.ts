// ─────────────────────────────────────────────────────────────────────────────
// MÍMIR model client. One entry point — mimirComplete — that the triador, the
// enhancer and the planner all call. Dispatches to the Max seat (`claude -p`,
// routed through headroom) or an OpenAI-compatible endpoint, per MimirConfig.
// ─────────────────────────────────────────────────────────────────────────────

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { MimirConfig } from "./config.js";
import { MimirError } from "./errors.js";

const exec = promisify(execFile);

export interface CompleteOpts {
  /** System framing (combined into the prompt for claude). */
  system?: string;
  user: string;
  model: string;
  /** Ask the provider for strict JSON (OpenAI json_object; claude is prompted). */
  json?: boolean;
  maxTokens?: number;
}

export interface CompleteResult {
  text: string;
  usage?: { inputTokens: number; outputTokens: number; cacheReadTokens: number };
}

/** The `claude -p --output-format json` envelope (only the fields we read). */
interface ClaudeEnvelope {
  subtype?: string;
  is_error?: boolean;
  result?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

interface ChatCompletion {
  choices?: { message?: { content?: string } }[];
}

export async function mimirComplete(config: MimirConfig, opts: CompleteOpts): Promise<CompleteResult> {
  return config.provider === "claude" ? claudeComplete(config, opts) : openaiComplete(config, opts);
}

async function claudeComplete(config: MimirConfig, opts: CompleteOpts): Promise<CompleteResult> {
  const prompt = opts.system ? `${opts.system}\n\n${opts.user}` : opts.user;
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (config.anthropicBaseUrl) env.ANTHROPIC_BASE_URL = config.anthropicBaseUrl;
  if (config.authToken) {
    // Gateway mode: authenticate to the LLM gateway (LiteLLM → Ratatoskr), which
    // injects the real subscription credential. Seat token / API key must be
    // absent — both outrank ANTHROPIC_AUTH_TOKEN and would break gateway auth.
    env.ANTHROPIC_AUTH_TOKEN = config.authToken;
    delete env.ANTHROPIC_API_KEY;
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
  } else {
    // Legacy: drive the Max seat directly via the OAuth token.
    env.CLAUDE_CODE_OAUTH_TOKEN = config.oauthToken;
    delete env.ANTHROPIC_API_KEY; // force the subscription auth path
  }

  let stdout: string;
  try {
    ({ stdout } = await exec(
      config.claudeBin,
      ["-p", prompt, "--model", opts.model, "--output-format", "json"],
      { env, maxBuffer: 1024 * 1024 * 16, timeout: 180_000 },
    ));
  } catch (e) {
    throw new MimirError(`claude -p falhou: ${(e as Error).message.slice(0, 200)}`, 502);
  }

  let envelope: ClaudeEnvelope;
  try {
    envelope = JSON.parse(stdout) as ClaudeEnvelope;
  } catch {
    throw new MimirError("claude -p devolveu um envelope inválido", 502);
  }
  if (envelope.is_error || envelope.subtype !== "success") {
    throw new MimirError(`claude retornou erro (${envelope.subtype ?? "desconhecido"})`, 502);
  }
  const u = envelope.usage ?? {};
  return {
    text: String(envelope.result ?? ""),
    usage: {
      inputTokens: u.input_tokens ?? 0,
      outputTokens: u.output_tokens ?? 0,
      cacheReadTokens: u.cache_read_input_tokens ?? 0,
    },
  };
}

async function openaiComplete(config: MimirConfig, opts: CompleteOpts): Promise<CompleteResult> {
  const messages: { role: string; content: string }[] = [];
  if (opts.system) messages.push({ role: "system", content: opts.system });
  messages.push({ role: "user", content: opts.user });
  const body = JSON.stringify({
    model: opts.model,
    messages,
    ...(opts.json ? { response_format: { type: "json_object" } } : {}),
    max_completion_tokens: opts.maxTokens ?? 1500,
  });

  // When pointed at the CCL gateway, this routes to the SHARED Max seat, which
  // 429s when busy. Retry with backoff (honouring Retry-After) so a single
  // planner/triage/enhance call rides out a busy window instead of hard-failing.
  // Mímir calls aren't streamed, so retrying before any output is safe.
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const maxAttempts = 6;
  let res: Response | undefined;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let r: Response;
    try {
      r = await fetch(`${config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
        body,
      });
    } catch (e) {
      if (attempt === maxAttempts - 1) throw new MimirError(`gateway inalcançável: ${String(e).slice(0, 150)}`, 502);
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    if (r.ok) {
      res = r;
      break;
    }
    const retryable = r.status === 429 || r.status === 529 || (r.status >= 500 && r.status < 600);
    const text = await r.text().catch(() => "");
    if (!retryable || attempt === maxAttempts - 1) {
      console.error("[mimir] openai", r.status, text.slice(0, 300));
      throw new MimirError(`OpenAI ${r.status}`, r.status);
    }
    const retryAfter = Number(r.headers.get("retry-after"));
    const backoff = Math.min(
      16_000,
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1500 * 2 ** attempt,
    );
    await sleep(backoff);
  }
  if (!res) throw new MimirError("OpenAI: sem resposta após retries", 502);
  const json = (await res.json().catch(() => null)) as ChatCompletion | null;
  return { text: json?.choices?.[0]?.message?.content ?? "" };
}

/** Best-effort JSON extraction from a model reply (handles ```json fences/prose). */
export function extractJson<T>(raw: string): T | null {
  const tryParse = (s: string): T | null => {
    try {
      return JSON.parse(s) as T;
    } catch {
      return null;
    }
  };
  const direct = tryParse(raw.trim());
  if (direct) return direct;
  const m = raw.match(/\{[\s\S]*\}/);
  return m ? tryParse(m[0]) : null;
}
