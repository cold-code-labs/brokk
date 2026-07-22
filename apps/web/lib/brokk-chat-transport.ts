// Custom AI SDK ChatTransport for Sindri detached turns (POST start + GET reattach).

import {
  parseJsonEventStream,
  type ParseResult,
} from "@ai-sdk/provider-utils";
import {
  uiMessageChunkSchema,
  type ChatTransport,
  type UIMessage,
  type UIMessageChunk,
} from "ai";

const BASE = (process.env.NEXT_PUBLIC_BROKK_API_URL || "/api") + "/chat";

export type BrokkSendExtras = {
  skill?: string | null;
  attachments?: string[];
  attachmentUploads?: { name: string; dataBase64: string }[];
};

export type BrokkChatTransportOptions = {
  getSessionId: () => string;
  getExtras?: () => BrokkSendExtras;
  /** Default `/api/chat`. */
  apiBase?: string;
};

function processResponseStream(
  stream: ReadableStream<Uint8Array<ArrayBufferLike>>,
): ReadableStream<UIMessageChunk> {
  return parseJsonEventStream({
    stream,
    schema: uiMessageChunkSchema,
  }).pipeThrough(
    new TransformStream<ParseResult<UIMessageChunk>, UIMessageChunk>({
      async transform(chunk, controller) {
        if (!chunk.success) throw chunk.error;
        controller.enqueue(chunk.value);
      },
    }),
  );
}

function textFromUserMessage(message: UIMessage | undefined): string {
  if (!message) return "";
  return message.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("");
}

export class BrokkChatTransport implements ChatTransport<UIMessage> {
  private readonly apiBase: string;

  constructor(private readonly opts: BrokkChatTransportOptions) {
    this.apiBase = opts.apiBase ?? BASE;
  }

  async sendMessages({
    messages,
    abortSignal,
  }: Parameters<ChatTransport<UIMessage>["sendMessages"]>[0]): Promise<
    ReadableStream<UIMessageChunk>
  > {
    const sessionId = this.opts.getSessionId();
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    const text = textFromUserMessage(lastUser);
    if (!text.trim()) throw new Error("empty message");
    const extras = this.opts.getExtras?.() ?? {};

    const res = await fetch(`${this.apiBase}/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
      },
      body: JSON.stringify({
        text,
        skill: extras.skill ?? undefined,
        attachments: extras.attachments,
        attachmentUploads: extras.attachmentUploads,
      }),
      signal: abortSignal,
    });
    if (!res.ok || !res.body) {
      const err = await res.text().catch(() => "");
      throw new Error(`messages → ${res.status} ${err.slice(0, 200)}`);
    }
    return processResponseStream(res.body);
  }

  async reconnectToStream(
    options: Parameters<ChatTransport<UIMessage>["reconnectToStream"]>[0],
  ): Promise<ReadableStream<UIMessageChunk> | null> {
    const sessionId = options.chatId || this.opts.getSessionId();
    const signal = (options as { abortSignal?: AbortSignal }).abortSignal;
    const res = await fetch(`${this.apiBase}/sessions/${sessionId}/stream`, {
      headers: { accept: "text/event-stream" },
      signal,
    });
    if (res.status === 404 || res.status === 204) return null;
    if (!res.ok || !res.body) return null;
    return processResponseStream(res.body);
  }
}
