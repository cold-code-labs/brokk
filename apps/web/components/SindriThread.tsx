"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  AssistantRuntimeProvider,
  MessagePrimitive,
  ThreadPrimitive,
} from "@assistant-ui/react";
import { useAISDKRuntime } from "@assistant-ui/react-ai-sdk";
import { useChat, type UIMessage } from "@ai-sdk/react";
import {
  BrokkChatTransport,
  type BrokkSendExtras,
} from "../lib/brokk-chat-transport";

export type SindriThreadApi = {
  send: (text: string) => Promise<void>;
  stop: () => void;
  status: string;
};

type Props = {
  sessionId: string;
  initialMessages: UIMessage[];
  resume?: boolean;
  getExtras: () => BrokkSendExtras;
  onApi?: (api: SindriThreadApi) => void;
  onStatus?: (status: string) => void;
  onPhase?: (phase: string) => void;
  onError?: (message: string) => void;
  onTitle?: (title: string) => void;
};

function DiffPart({ data }: { data: unknown }) {
  const d = (data ?? {}) as { text?: string; shortstat?: string };
  return (
    <div className="sindri-diff-card">
      <strong>Working tree</strong>
      <p>{d.shortstat || d.text || "changes"}</p>
    </div>
  );
}

function UserMessage() {
  return (
    <MessagePrimitive.Root className="sindri-msg is-user">
      <div className="sindri-bubble">
        <MessagePrimitive.Parts />
      </div>
    </MessagePrimitive.Root>
  );
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="sindri-msg is-assistant">
      <div className="sindri-bubble">
        <MessagePrimitive.Parts
          components={{
            data: {
              by_name: {
                "sindri-diff": ({ data }) => <DiffPart data={data} />,
              },
            },
          }}
        />
      </div>
    </MessagePrimitive.Root>
  );
}

export function SindriThread({
  sessionId,
  initialMessages,
  resume = false,
  getExtras,
  onApi,
  onStatus,
  onPhase,
  onError,
  onTitle,
}: Props) {
  const getExtrasRef = useRef(getExtras);
  getExtrasRef.current = getExtras;
  const sessionRef = useRef(sessionId);
  sessionRef.current = sessionId;

  const transport = useMemo(
    () =>
      new BrokkChatTransport({
        getSessionId: () => sessionRef.current,
        getExtras: () => getExtrasRef.current(),
      }),
    [],
  );

  const chat = useChat({
    id: sessionId,
    messages: initialMessages,
    transport,
    resume,
    onData: (part) => {
      if (part.type === "data-sindri-status") {
        const data = part.data as { phase?: string };
        if (data?.phase) onPhase?.(String(data.phase));
      }
    },
    onError: (err) => onError?.(err.message || String(err)),
  });

  // Title arrives as message-metadata on the stream — watch chat messages meta lightly.
  useEffect(() => {
    for (const m of chat.messages) {
      const title = (m.metadata as { title?: string } | undefined)?.title;
      if (title) onTitle?.(title);
    }
  }, [chat.messages, onTitle]);

  const runtime = useAISDKRuntime(chat, {
    joinStrategy: "none",
    onResume: async () => {
      await chat.resumeStream?.();
    },
  });

  useEffect(() => {
    onStatus?.(chat.status);
  }, [chat.status, onStatus]);

  const send = useCallback(
    async (text: string) => {
      await chat.sendMessage({ text });
    },
    [chat],
  );

  useEffect(() => {
    onApi?.({
      send,
      stop: () => chat.stop(),
      status: chat.status,
    });
  }, [onApi, send, chat]);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root className="sindri-aui-thread">
        <ThreadPrimitive.Viewport className="sindri-aui-viewport sindri-thread-content">
          <ThreadPrimitive.Empty>
            <div className="sindri-empty">Diga o que quer mudar no app.</div>
          </ThreadPrimitive.Empty>
          <ThreadPrimitive.Messages
            components={{
              UserMessage,
              AssistantMessage,
            }}
          />
          <ThreadPrimitive.ScrollToBottom className="sindri-scroll-bottom" />
        </ThreadPrimitive.Viewport>
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}
