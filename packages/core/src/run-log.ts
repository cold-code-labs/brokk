/**
 * Pure fold of RunEvents → display entries for the Board Live run log.
 * Kept free of React so the coalesce rules (thinking deltas, tool pairing) can
 * be unit-tested with node:test.
 */

export type RunLogTool = {
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
};

export type RunLogToolResult = {
  tool_use_id?: string;
  ok?: boolean;
  preview?: string;
};

export type RunLogEntry =
  | { kind: "phase"; phase: Record<string, unknown> }
  | { kind: "log"; text: string; error: boolean }
  | { kind: "acceptance"; receipt: Record<string, unknown> }
  | { kind: "thinking"; text: string; live: boolean }
  | { kind: "text"; text: string }
  | { kind: "tool"; tool: RunLogTool; result?: RunLogToolResult };

type RunEventLike = { type: string; payload: unknown };

/** Fold a run's event stream into ordered, deduped log entries. */
export function foldRunLogEvents(events: ReadonlyArray<RunEventLike>): RunLogEntry[] {
  const resultById = new Map<string, RunLogToolResult>();
  for (const e of events) {
    if (e.type === "tool_result") {
      const p = e.payload as RunLogToolResult;
      if (p?.tool_use_id) resultById.set(p.tool_use_id, p);
    }
  }

  const out: RunLogEntry[] = [];
  /** tool ids already rendered from a message's content blocks */
  const seenTools = new Set<string>();
  let liveThinking = "";

  const flushLiveThinking = (finalize: boolean) => {
    if (!liveThinking.trim()) return;
    out.push({ kind: "thinking", text: liveThinking, live: !finalize });
    liveThinking = "";
  };

  for (const e of events) {
    const p = e.payload as Record<string, unknown> | null | undefined;

    if (e.type === "thinking") {
      const chunk = typeof p?.text === "string" ? p.text : "";
      if (chunk) liveThinking += chunk;
      continue;
    }

    if (e.type === "status") {
      flushLiveThinking(true);
      out.push({ kind: "phase", phase: (p ?? {}) as Record<string, unknown> });
      continue;
    }

    if (e.type === "log") {
      flushLiveThinking(true);
      const text =
        (typeof p?.verify === "string" && p.verify) ||
        (typeof p?.error === "string" && p.error) ||
        (typeof p === "string" ? p : "");
      if (text) out.push({ kind: "log", text: String(text), error: p?.level === "error" });
      continue;
    }

    if (e.type === "acceptance") {
      flushLiveThinking(true);
      out.push({ kind: "acceptance", receipt: (p ?? {}) as Record<string, unknown> });
      continue;
    }

    if (e.type === "message") {
      const c = (p as { content?: unknown; message?: { content?: unknown } } | null)?.content
        ?? (p as { message?: { content?: unknown } } | null)?.message?.content;
      const blocks: unknown[] = Array.isArray(c) ? c : [];

      const thinking = blocks
        .filter((b): b is { type: string; thinking?: string } =>
          !!b && typeof b === "object" && (b as { type?: string }).type === "thinking",
        )
        .map((b) => b.thinking ?? "")
        .join("")
        .trim();
      if (thinking) {
        // Finalized thinking on the message supersedes the live delta buffer.
        liveThinking = "";
        out.push({ kind: "thinking", text: thinking, live: false });
      } else {
        flushLiveThinking(true);
      }

      const text = blocks
        .filter((b): b is { type: string; text?: string } =>
          !!b && typeof b === "object" && (b as { type?: string }).type === "text",
        )
        .map((b) => b.text ?? "")
        .join("\n")
        .trim();
      if (text) out.push({ kind: "text", text });

      for (const b of blocks) {
        if (!b || typeof b !== "object") continue;
        const block = b as RunLogTool & { type?: string };
        if (block.type !== "tool_use") continue;
        if (block.id) seenTools.add(block.id);
        out.push({
          kind: "tool",
          tool: { id: block.id, name: block.name, input: block.input },
          result: block.id ? resultById.get(block.id) : undefined,
        });
      }
      continue;
    }

    if (e.type === "tool_use") {
      flushLiveThinking(true);
      const tool = p as RunLogTool | null;
      const id = tool?.id;
      if (id && seenTools.has(id)) continue; // already rendered via message
      if (id) seenTools.add(id);
      out.push({
        kind: "tool",
        tool: { id: tool?.id, name: tool?.name, input: tool?.input },
        result: id ? resultById.get(id) : undefined,
      });
    }
    // usage: noise for the operator feed
  }

  flushLiveThinking(false);
  return out;
}
