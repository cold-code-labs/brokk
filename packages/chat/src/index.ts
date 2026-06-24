/**
 * @brokk/chat — Sindri's runtime. The interactive half of the forge: a native
 * Anthropic Messages API agentic loop (Option B — our own tool layer, not the
 * Agent SDK) that works a real git checkout with the user, persists the whole
 * transcript, and streams live. Routed through the CCL gateway (LiteLLM →
 * Ratatoskr), so the request envelope is grey-light by construction.
 *
 * Sibling to Brokkr (autonomous card→PR), Mímir (intake), Eitri (review).
 */

export { type ChatConfig, loadChatConfig, resolveModel } from "./config.js";
export { buildSystemPrompt, type ContextInput } from "./context.js";
export { type DiscoveryBrief, runDiscovery, type RunDiscoveryInput } from "./discovery.js";
export { GatewayError, streamAssistant } from "./gateway.js";
export { runTurn, type RunTurnInput } from "./loop.js";
export { makeExecutor, TOOL_DEFS, type ToolContext } from "./tools.js";
export type {
  ChatTurnMessage,
  ContentBlock,
  SindriEvent,
  TextBlock,
  ThinkingBlock,
  ToolDef,
  ToolExecutor,
  ToolResultBlock,
  ToolUseBlock,
  TurnUsage,
} from "./types.js";
