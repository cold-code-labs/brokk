/**
 * @brokk/afl — the heart. The shared execution substrate every Brokk agent runs
 * on: the native Anthropic Messages gateway client + the config that points it at
 * the CCL gateway (LiteLLM → Ratatoskr). Dependency-light by law — no @brokk/db,
 * no gh, no cards. The hands, not the persona. See docs/NORTH-STAR.md §5, §10.
 *
 * Phase 1 of the @brokk/chat → @brokk/afl extraction: gateway + types + config.
 * Still to land (once decoupled from @brokk/db): the tool-loop (loop.ts) and the
 * generic tool layer (fs + bash + shellEnv). Naming cleanup pending too
 * (ChatConfig → AflConfig, SindriEvent → AgentEvent).
 */

export { type ChatConfig, loadChatConfig, resolveModel } from "./config.js";
export { GatewayError, streamAssistant } from "./gateway.js";
export {
  clip,
  composeExecutors,
  FS_TOOL_DEFS,
  type FsToolContext,
  makeFsExecutor,
  safePath,
  shellEnv,
} from "./tools.js";
export type {
  ChatTurnMessage,
  ContentBlock,
  PartialExecutor,
  SindriEvent,
  TextBlock,
  ThinkingBlock,
  ToolDef,
  ToolExecutor,
  ToolResult,
  ToolResultBlock,
  ToolUseBlock,
  TurnUsage,
} from "./types.js";
