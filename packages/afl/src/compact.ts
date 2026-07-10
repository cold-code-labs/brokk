// ─────────────────────────────────────────────────────────────────────────────
// Transcript compaction (ADR 0027 §5.1). When a long-running loop's context
// approaches the window, the OLDER rounds are collapsed into one summary
// message so the agent keeps working with its recent state intact. The cut is
// always at an assistant-round boundary, so tool_use/tool_result pairs are
// never orphaned. Context-only: consumers that persist transcripts (Sindri)
// keep their full history — compaction rewrites the in-memory `messages` the
// next API round sees, never the store.
// ─────────────────────────────────────────────────────────────────────────────

import type { AflConfig } from "./config.js";
import { streamAssistant } from "./gateway.js";
import type { ChatTurnMessage } from "./types.js";

export interface CompactionResult {
  /** How many transcript messages were folded into the summary. */
  dropped: number;
  summary: string;
}

export interface CompactOptions {
  /** How many most-recent assistant rounds (with their tool results) survive
   *  verbatim. Default 2. */
  keepRecentRounds?: number;
  /** Summarizer model. Default cfg.models.haiku — a summary is cheap work. */
  model?: string;
  maxSummaryTokens?: number;
  signal?: AbortSignal;
}

const SUMMARY_SYSTEM =
  "You compress an AI coding-agent transcript. Produce a dense factual summary that lets the agent continue seamlessly. Preserve: the user's goal, decisions made, files/paths created or edited (and how), tool outcomes that matter, current state, and unresolved next steps. Plain text, no preamble.";

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** Flatten a transcript slice into readable lines for the summarizer. */
function renderForSummary(messages: ChatTurnMessage[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    for (const b of m.content) {
      if (b.type === "text") lines.push(`${m.role}: ${clip(b.text, 1500)}`);
      else if (b.type === "tool_use")
        lines.push(`assistant → ${b.name}(${clip(JSON.stringify(b.input), 400)})`);
      else if (b.type === "tool_result")
        lines.push(`  ↳ ${b.is_error ? "ERROR" : "ok"}: ${clip(b.content, 500)}`);
      // thinking blocks are internal — never fed to the summarizer
    }
  }
  return clip(lines.join("\n"), 100_000);
}

/**
 * Collapse everything but the last `keepRecentRounds` assistant rounds into one
 * summary user-message, IN PLACE. Returns null when there is nothing worth
 * compacting (short transcript) or the summarizer produced nothing.
 */
export async function compactTranscript(
  cfg: AflConfig,
  messages: ChatTurnMessage[],
  opts?: CompactOptions,
): Promise<CompactionResult | null> {
  const keep = Math.max(1, opts?.keepRecentRounds ?? 2);
  const assistantIdx = messages
    .map((m, i) => (m.role === "assistant" ? i : -1))
    .filter((i) => i >= 0);
  if (assistantIdx.length <= keep) return null;

  // Cut right BEFORE the first surviving assistant round: the tail then starts
  // with an assistant message whose tool_results (if any) follow inside the tail.
  const cut = assistantIdx[assistantIdx.length - keep]!;
  if (cut < 2) return null;

  const prefix = messages.slice(0, cut);
  const result = await streamAssistant(
    cfg,
    {
      model: opts?.model ?? cfg.models.haiku,
      system: SUMMARY_SYSTEM,
      messages: [{ role: "user", content: [{ type: "text", text: renderForSummary(prefix) }] }],
      tools: [],
      maxTokens: opts?.maxSummaryTokens ?? 1024,
    },
    () => {},
    opts?.signal,
  );
  const summary = result.blocks
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  if (!summary) return null;

  messages.splice(0, cut, {
    role: "user",
    content: [{ type: "text", text: `[Earlier conversation compacted — summary]\n${summary}` }],
  });
  return { dropped: prefix.length, summary };
}
