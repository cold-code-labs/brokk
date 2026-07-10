// ─────────────────────────────────────────────────────────────────────────────
// MÍMIR model client. One entry point — mimirComplete — that the triador, the
// enhancer and the planner all call. HTTP-only (ADR 0027): dispatches to the
// Anthropic Messages API (through the LLM gateway) or an OpenAI-compatible
// endpoint, per MimirConfig. The old `claude -p` CLI path is gone — no image
// carries the CLI, and shelling out for a one-shot completion was pure weight.
// ─────────────────────────────────────────────────────────────────────────────

import type { MimirConfig } from "./config.js";
import { MimirError } from "./errors.js";

export interface CompleteOpts {
  /** System framing (top-level `system` for claude; system message for OpenAI). */
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

interface ChatCompletion {
  choices?: { message?: { content?: string } }[];
}

/** Anthropic Messages response (only the fields we read). */
interface MessagesResponse {
  content?: { type: string; text?: string }[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

export async function mimirComplete(config: MimirConfig, opts: CompleteOpts): Promise<CompleteResult> {
  return config.provider === "claude" ? claudeComplete(config, opts) : openaiComplete(config, opts);
}

/**
 * POST with retry/backoff shared by both providers. When pointed at the CCL
 * gateway this routes to the SHARED Max seat, which 429s when busy — retry
 * (honouring Retry-After) so a single planner/triage/enhance call rides out a
 * busy window instead of hard-failing. Mímir calls aren't streamed, so
 * retrying before any output is safe.
 */
async function postWithRetry(url: string, headers: Record<string, string>, body: string): Promise<Response> {
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const maxAttempts = 6;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let r: Response;
    try {
      r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body });
    } catch (e) {
      if (attempt === maxAttempts - 1) throw new MimirError(`gateway inalcançável: ${String(e).slice(0, 150)}`, 502);
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    if (r.ok) return r;
    const retryable = r.status === 429 || r.status === 529 || (r.status >= 500 && r.status < 600);
    const text = await r.text().catch(() => "");
    if (!retryable || attempt === maxAttempts - 1) {
      console.error("[mimir]", r.status, text.slice(0, 300));
      throw new MimirError(`upstream ${r.status}`, r.status);
    }
    const retryAfter = Number(r.headers.get("retry-after"));
    const backoff = Math.min(
      16_000,
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1500 * 2 ** attempt,
    );
    await sleep(backoff);
  }
  throw new MimirError("upstream: sem resposta após retries", 502);
}

async function claudeComplete(config: MimirConfig, opts: CompleteOpts): Promise<CompleteResult> {
  const base = config.anthropicBaseUrl.replace(/\/$/, "");
  if (!base || !config.authToken) {
    throw new MimirError("mimir claude: ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN ausentes", 503);
  }
  const body = JSON.stringify({
    model: opts.model,
    max_tokens: opts.maxTokens ?? 2048,
    ...(opts.system ? { system: opts.system } : {}),
    messages: [{ role: "user", content: opts.user }],
  });
  const res = await postWithRetry(`${base}/v1/messages`, {
    Authorization: `Bearer ${config.authToken}`,
    "anthropic-version": "2023-06-01",
  }, body);
  const json = (await res.json().catch(() => null)) as MessagesResponse | null;
  const text = (json?.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("");
  const u = json?.usage ?? {};
  return {
    text,
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
  const res = await postWithRetry(`${config.baseUrl}/chat/completions`, {
    Authorization: `Bearer ${config.apiKey}`,
  }, body);
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
