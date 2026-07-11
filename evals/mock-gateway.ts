// A scripted stand-in for the LLM gateway: speaks exactly the SSE dialect
// packages/afl/src/gateway.ts parses. Each queued MockRound becomes one
// /v1/messages response; the request bodies are captured for assertions.

import http from "node:http";
import type { AddressInfo } from "node:net";

export type MockBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature?: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

export interface MockRound {
  blocks: MockBlock[];
  stopReason: string; // "end_turn" | "tool_use" | ...
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  /** Optional inspection hook — receives the parsed request body for this round. */
  onRequest?: (body: any) => void;
}

export class MockGateway {
  readonly requests: any[] = [];
  readonly headers: http.IncomingHttpHeaders[] = [];
  private script: MockRound[] = [];
  private server?: http.Server;
  private cursor = 0;

  /** Queue the scripted rounds (in request order). Repeats the LAST round if the
   *  loop asks for more rounds than scripted (useful for max_rounds tests). */
  load(rounds: MockRound[]): void {
    this.script = rounds;
    this.cursor = 0;
    this.requests.length = 0;
  }

  async start(): Promise<string> {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
        this.requests.push(body);
        this.headers.push(req.headers);
        const round =
          this.script[Math.min(this.cursor, this.script.length - 1)] ??
          ({ blocks: [{ type: "text", text: "mock exhausted" }], stopReason: "end_turn" } as MockRound);
        this.cursor++;
        round.onRequest?.(body);
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(sse(round));
      });
    });
    await new Promise<void>((r) => this.server!.listen(0, "127.0.0.1", r));
    const { port } = this.server!.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => this.server?.close(() => r()));
  }
}

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Serialize one MockRound into the SSE stream shape the afl parser expects. */
function sse(round: MockRound): string {
  let out = frame("message_start", {
    message: {
      usage: {
        input_tokens: round.inputTokens ?? 100,
        cache_read_input_tokens: round.cacheReadTokens ?? 0,
        cache_creation_input_tokens: round.cacheCreationTokens ?? 0,
      },
    },
  });

  round.blocks.forEach((b, index) => {
    if (b.type === "text") {
      out += frame("content_block_start", { index, content_block: { type: "text", text: "" } });
      // Split into two deltas to exercise accumulation.
      const mid = Math.ceil(b.text.length / 2);
      for (const piece of [b.text.slice(0, mid), b.text.slice(mid)]) {
        if (piece) out += frame("content_block_delta", { index, delta: { type: "text_delta", text: piece } });
      }
    } else if (b.type === "thinking") {
      out += frame("content_block_start", { index, content_block: { type: "thinking", thinking: "" } });
      out += frame("content_block_delta", { index, delta: { type: "thinking_delta", thinking: b.thinking } });
      if (b.signature)
        out += frame("content_block_delta", { index, delta: { type: "signature_delta", signature: b.signature } });
    } else {
      out += frame("content_block_start", {
        index,
        content_block: { type: "tool_use", id: b.id, name: b.name },
      });
      const json = JSON.stringify(b.input);
      const mid = Math.ceil(json.length / 2);
      for (const piece of [json.slice(0, mid), json.slice(mid)]) {
        if (piece)
          out += frame("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: piece } });
      }
    }
    out += frame("content_block_stop", { index });
  });

  out += frame("message_delta", {
    delta: { stop_reason: round.stopReason },
    usage: { output_tokens: round.outputTokens ?? 50 },
  });
  out += frame("message_stop", {});
  return out;
}

/** AflConfig pointed at a mock gateway instance. */
export function mockCfg(baseUrl: string) {
  return {
    gatewayUrl: baseUrl,
    authToken: "eval",
    authKind: "bearer" as const,
    anthropicVersion: "2023-06-01",
    models: { haiku: "mock-haiku", sonnet: "mock-sonnet", opus: "mock-opus" },
    maxTokens: 512,
    maxRounds: 8,
    compactInputTokens: 0,
    turnTokenBudget: 0,
  };
}
