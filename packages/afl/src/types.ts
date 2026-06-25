// ─────────────────────────────────────────────────────────────────────────────
// Sindri runtime types — the native Anthropic Messages API shapes we care about
// (content blocks, the tool contract) plus the live event stream we emit to the
// UI. We speak the Messages API DIRECTLY (Option B), not via the Agent SDK, so we
// own the tool layer, the transcript, and the streaming envelope end to end.
// ─────────────────────────────────────────────────────────────────────────────

/** Anthropic content blocks (the subset we produce/consume). `unknown`-friendly:
 *  blocks round-trip through the DB verbatim, so we keep them structurally loose. */
export type TextBlock = { type: "text"; text: string };
export type ThinkingBlock = { type: "thinking"; thinking: string; signature?: string };
export type ToolUseBlock = { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };
export type ToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
};
export type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock;

/** One message in the Messages API conversation. */
export interface ChatTurnMessage {
  role: "user" | "assistant";
  content: ContentBlock[];
}

/** A tool the model can call. `input_schema` is JSON Schema. */
export interface ToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/** The executor that runs one tool call and returns the text result. `ok=false`
 *  marks the result as an error to the model (is_error) without throwing. */
export type ToolExecutor = (
  name: string,
  input: Record<string, unknown>,
) => Promise<{ ok: boolean; content: string }>;

/** Token usage as the Messages API reports it. */
export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

/** Live events Sindri emits during a turn — fed to the SSE stream and (for the
 *  completed-message ones) mirrored from the persisted transcript on reconnect. */
export type SindriEvent =
  | { type: "status"; phase: string; detail?: unknown }
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; toolUseId: string; ok: boolean; preview: string }
  | { type: "message"; seq: number; role: "user" | "assistant"; blocks: ContentBlock[] }
  | { type: "usage"; usage: TurnUsage }
  | { type: "title"; title: string }
  | { type: "done" }
  | { type: "error"; message: string };
