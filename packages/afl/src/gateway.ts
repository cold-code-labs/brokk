// ─────────────────────────────────────────────────────────────────────────────
// The model call. We speak the Anthropic Messages streaming protocol directly:
// POST /v1/messages with stream:true, parse the SSE event frames, and accumulate
// the assistant's content blocks (text / thinking / tool_use). Deltas are handed
// to onDelta as they arrive (for live UI); the resolved value is the FULL
// assistant message (blocks + stop_reason + usage) ready to persist and replay.
// ─────────────────────────────────────────────────────────────────────────────

import { type AflConfig, CLAUDE_CODE_MARKER, OAUTH_BETA } from "./config.js";
import type {
  ChatTurnMessage,
  ContentBlock,
  TextBlock,
  ThinkingBlock,
  ToolDef,
  ToolUseBlock,
  TurnUsage,
} from "./types.js";

export interface MessagesRequest {
  model: string;
  system: string;
  messages: ChatTurnMessage[];
  tools: ToolDef[];
  maxTokens: number;
  /** Extended thinking budget (tokens). Omit/0 = thinking off. */
  thinkingBudget?: number;
  /** Force a specific tool (e.g. to make the model conclude). Omit = auto. */
  toolChoice?: { type: "auto" } | { type: "tool"; name: string };
}

export interface AssistantResult {
  blocks: ContentBlock[];
  stopReason: string;
  usage: TurnUsage;
  /** Notes from the stream interceptor (#4 POC), when one is supplied — one entry
   *  per block it corrected. Empty/absent when no interceptor ran. */
  corrections?: string[];
}

/** Stream interceptor (#4, the v0 "LLM Suspense" lesson): inspect each assistant
 *  content block the instant it finalizes mid-turn — BEFORE the loop appends it —
 *  and optionally rewrite it, cheaply and deterministically (a hallucinated import
 *  path, a nonexistent icon), instead of paying a whole model heal to catch the
 *  obvious. Return null to leave the block untouched. This is the seam v0 puts a
 *  ~250ms deterministic autofixer on; here it stays opt-in (undefined = the live
 *  path is byte-identical to before). */
export type BlockInterceptor = (block: ContentBlock) => { block: ContentBlock; note: string } | null;

export type DeltaSink = (
  d:
    | { type: "text_delta"; text: string }
    | { type: "thinking_delta"; text: string },
) => void;

export class GatewayError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

/** Mutable accumulator for one streamed content block. */
type Building =
  | { kind: "text"; text: string }
  | { kind: "thinking"; thinking: string; signature: string }
  | { kind: "tool_use"; id: string; name: string; json: string };

export async function streamAssistant(
  cfg: AflConfig,
  req: MessagesRequest,
  onDelta: DeltaSink,
  signal?: AbortSignal,
  interceptor?: BlockInterceptor,
): Promise<AssistantResult> {
  // Fire the request with retry on transient failures (429/5xx). The Max seat is
  // SHARED (forge + Mímir + Eitri + Sindri), and the subscription rate-limiter
  // reserves `max_tokens` against the output-token window — so a busy window 429s
  // a big reservation. We back off AND adaptively shrink max_tokens (floor 1024)
  // so a turn rides out a busy seat instead of dying. Retry only happens BEFORE
  // any stream byte (the 429 lands on the initial response), so nothing duplicates.
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref?.());
  let maxTokens = req.maxTokens;
  let res: Response | undefined;
  const maxAttempts = 8;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const body: Record<string, unknown> = {
      model: req.model,
      max_tokens: maxTokens,
      stream: true,
      // Prompt caching only pays off on the direct-Anthropic (apikey) path. On the
      // CCL subscription seat (bearer → LiteLLM → Ratatoskr) the cache is WRITTEN but
      // never READ back — verified end-to-end: cache_creation_input_tokens>0 yet
      // cache_read_input_tokens is always 0, even for byte-identical back-to-back
      // requests, independent of LiteLLM vs Ratatoskr-direct, marker placement, or
      // prompt-caching beta headers. So on the seat cache_control is net-negative (it
      // pays the ~25% cache-write premium for zero read benefit). Emit it only under
      // apikey, where reads work; send a plain system string on the seat.
      system:
        cfg.authKind === "apikey"
          ? [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }]
          : cfg.authKind === "oauth"
            ? // Direct seat: Ratatoskr isn't in the loop, so WE prepend the genuine
              // Claude-Code identity marker as the first system block (the
              // subscription path validates it). Plain strings, no cache_control.
              [
                { type: "text", text: CLAUDE_CODE_MARKER },
                { type: "text", text: req.system },
              ]
            : req.system,
      messages: req.messages,
    };
    if (req.tools.length) body.tools = req.tools;
    if (req.toolChoice) body.tool_choice = req.toolChoice;
    if (req.thinkingBudget && req.thinkingBudget > 0) {
      body.thinking = { type: "enabled", budget_tokens: req.thinkingBudget };
    }

    let r: Response;
    try {
      r = await fetch(`${cfg.gatewayUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(cfg.authKind === "apikey"
            ? { "x-api-key": cfg.authToken }
            : { authorization: `Bearer ${cfg.authToken}` }),
          // The direct seat path needs the subscription OAuth beta flag that
          // Ratatoskr would otherwise inject upstream.
          ...(cfg.authKind === "oauth" ? { "anthropic-beta": OAUTH_BETA } : {}),
          "anthropic-version": cfg.anthropicVersion,
          accept: "text/event-stream",
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (e) {
      if (signal?.aborted) throw e;
      if (attempt === maxAttempts - 1) throw new GatewayError(`gateway unreachable: ${String(e)}`, 502);
      await sleep(1000 * 2 ** attempt);
      continue;
    }

    if (r.ok && r.body) {
      res = r;
      break;
    }

    const retryable = r.status === 429 || r.status === 529 || (r.status >= 500 && r.status < 600);
    const text = await r.text().catch(() => "");
    if (!retryable || attempt === maxAttempts - 1) {
      throw new GatewayError(`gateway ${r.status}: ${text.slice(0, 500)}`, r.status);
    }
    // Honour Retry-After when present, else exponential backoff.
    const retryAfter = Number(r.headers.get("retry-after"));
    const backoff = Math.min(
      16_000,
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1500 * 2 ** attempt,
    );
    if (r.status === 429 && maxTokens > 768) maxTokens = Math.max(768, Math.floor(maxTokens / 2));
    await sleep(backoff);
  }
  if (!res || !res.body) throw new GatewayError("gateway: no response after retries", 502);

  const usage: TurnUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
  let stopReason = "end_turn";
  const building = new Map<number, Building>();
  const finished: { index: number; block: ContentBlock }[] = [];
  const corrections: string[] = [];

  // Push a finalized block, first running it through the interceptor (#4). A
  // returned correction replaces the block and records a note; null passes through.
  const push = (index: number, block: ContentBlock) => {
    if (interceptor) {
      const c = interceptor(block);
      if (c) {
        finished.push({ index, block: c.block });
        corrections.push(c.note);
        return;
      }
    }
    finished.push({ index, block });
  };

  const handleEvent = (event: string, data: string) => {
    if (!data) return;
    let j: any;
    try {
      j = JSON.parse(data);
    } catch {
      return;
    }
    // cursor-api-proxy (and some gateways) emit only `data: {"type":...}` without
    // an SSE `event:` line. Anthropic itself sets both. Prefer the JSON type when
    // the frame defaulted to "message".
    if ((event === "message" || !event) && typeof j?.type === "string") {
      event = j.type;
    }
    switch (event) {
      case "message_start": {
        const u = j.message?.usage ?? {};
        usage.inputTokens += Number(u.input_tokens ?? 0);
        usage.cacheReadTokens += Number(u.cache_read_input_tokens ?? 0);
        usage.cacheCreationTokens += Number(u.cache_creation_input_tokens ?? 0);
        break;
      }
      case "content_block_start": {
        const cb = j.content_block ?? {};
        if (cb.type === "text") building.set(j.index, { kind: "text", text: cb.text ?? "" });
        else if (cb.type === "thinking")
          building.set(j.index, { kind: "thinking", thinking: cb.thinking ?? "", signature: "" });
        else if (cb.type === "tool_use")
          building.set(j.index, { kind: "tool_use", id: cb.id, name: cb.name, json: "" });
        break;
      }
      case "content_block_delta": {
        const b = building.get(j.index);
        const d = j.delta ?? {};
        if (!b) break;
        if (d.type === "text_delta" && b.kind === "text") {
          b.text += d.text ?? "";
          onDelta({ type: "text_delta", text: d.text ?? "" });
        } else if (d.type === "thinking_delta" && b.kind === "thinking") {
          b.thinking += d.thinking ?? "";
          onDelta({ type: "thinking_delta", text: d.thinking ?? "" });
        } else if (d.type === "signature_delta" && b.kind === "thinking") {
          b.signature += d.signature ?? "";
        } else if (d.type === "input_json_delta" && b.kind === "tool_use") {
          b.json += d.partial_json ?? "";
        }
        break;
      }
      case "content_block_stop": {
        const b = building.get(j.index);
        if (!b) break;
        if (b.kind === "text") push(j.index, { type: "text", text: b.text } as TextBlock);
        else if (b.kind === "thinking")
          push(j.index, { type: "thinking", thinking: b.thinking, signature: b.signature } as ThinkingBlock);
        else if (b.kind === "tool_use") {
          let input: Record<string, unknown> = {};
          try {
            input = b.json ? JSON.parse(b.json) : {};
          } catch {
            input = {};
          }
          push(j.index, { type: "tool_use", id: b.id, name: b.name, input } as ToolUseBlock);
        }
        building.delete(j.index);
        break;
      }
      case "message_delta": {
        if (j.delta?.stop_reason) stopReason = j.delta.stop_reason;
        if (j.usage?.output_tokens) usage.outputTokens += Number(j.usage.output_tokens);
        break;
      }
      case "error": {
        throw new GatewayError(`stream error: ${JSON.stringify(j.error ?? j).slice(0, 300)}`, 502);
      }
      default:
        break;
    }
  };

  // Parse the SSE byte stream into (event, data) frames separated by blank lines.
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, nl);
      buf = buf.slice(nl + 2);
      let event = "message";
      const dataLines: string[] = [];
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
      }
      handleEvent(event, dataLines.join("\n"));
    }
  }

  const blocks = finished.sort((a, b) => a.index - b.index).map((f) => f.block);
  return { blocks, stopReason, usage, corrections: corrections.length ? corrections : undefined };
}
