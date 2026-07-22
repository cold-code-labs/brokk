import type { UIMessage } from "ai";
import type { Block, ChatMessage } from "./chat";

type Part = UIMessage["parts"][number];

export function sessionMessagesToUIMessages(messages: ChatMessage[]): UIMessage[] {
  return messages.map((m) => ({
    id: m.id || `seq-${m.seq}`,
    role: m.role,
    metadata: m.meta ?? undefined,
    parts: blocksToParts(m.blocks, m.meta),
  }));
}

export function blocksToParts(
  blocks: Block[],
  meta?: Record<string, unknown> | null,
): Part[] {
  const parts: Part[] = [];
  if (meta?.kind === "diff_summary") {
    const text = blocks
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("");
    parts.push({
      type: "data-sindri-diff",
      data: { text, files: meta.files ?? null, shortstat: meta.shortstat ?? null },
    } as Part);
  }
  for (const b of blocks) {
    if (b.type === "text") {
      parts.push({ type: "text", text: b.text, state: "done" });
    } else if (b.type === "thinking") {
      parts.push({ type: "reasoning", text: b.thinking, state: "done" });
    } else if (b.type === "tool_use") {
      parts.push({
        type: "dynamic-tool",
        toolName: b.name,
        toolCallId: b.id,
        state: "input-available",
        input: b.input,
      });
    } else if (b.type === "tool_result") {
      const prev = [...parts]
        .reverse()
        .find(
          (p) =>
            p.type === "dynamic-tool" &&
            (p as { toolCallId?: string }).toolCallId === b.tool_use_id,
        ) as
        | {
            type: "dynamic-tool";
            toolCallId: string;
            toolName: string;
            state: string;
            input: unknown;
          }
        | undefined;
      if (prev) {
        const idx = parts.indexOf(prev as Part);
        parts[idx] = {
          type: "dynamic-tool",
          toolName: prev.toolName,
          toolCallId: prev.toolCallId,
          state: b.is_error ? "output-error" : "output-available",
          input: prev.input,
          ...(b.is_error ? { errorText: b.content } : { output: b.content }),
        } as Part;
      } else {
        parts.push({
          type: "dynamic-tool",
          toolName: "tool",
          toolCallId: b.tool_use_id,
          state: b.is_error ? "output-error" : "output-available",
          input: {},
          ...(b.is_error ? { errorText: b.content } : { output: b.content }),
        } as Part);
      }
    }
  }
  return parts.length ? parts : [{ type: "text", text: "", state: "done" }];
}
