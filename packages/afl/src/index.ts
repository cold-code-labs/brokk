/**
 * @brokk/afl — the heart. The shared execution substrate every Brokk agent runs
 * on: the native Anthropic Messages gateway client + the config that points it at
 * the CCL gateway (LiteLLM → Ratatoskr). Dependency-light by law — no @brokk/db,
 * no gh, no cards. The hands, not the persona. See docs/NORTH-STAR.md §5, §10.
 *
 * Extraction history: the gateway + types + config came over from @brokk/chat,
 * then the generic agent-loop primitive (`runAgentLoop`) + the generic tool layer
 * (fs + bash + shellEnv) landed during the forge build. The config + event types
 * carry persona-neutral names (AflConfig, AgentEvent) — the kernel knows no Sindri.
 */

export {
  type CliTurnHooks,
  type CliTurnInput,
  type CliTurnOutcome,
  claudeCliAvailable,
  runClaudeCliTurn,
} from "./claude-cli.js";
export { cursorCliAvailable, runCursorCliTurn } from "./cursor-cli.js";
export {
  buildOpenHandsCliEnv,
  openHandsCliAvailable,
  runOpenHandsCliTurn,
} from "./openhands-cli.js";
export { type CompactionResult, type CompactOptions, compactTranscript } from "./compact.js";
export {
  type AflConfig,
  loadAflConfig,
  resolveModel,
  ANTHROPIC_DIRECT_URL,
  CLAUDE_CODE_MARKER,
  OAUTH_BETA,
} from "./config.js";
export {
  type AssistantResult,
  type BlockInterceptor,
  type DeltaSink,
  GatewayError,
  type MessagesRequest,
  streamAssistant,
} from "./gateway.js";
export {
  type ToolUseRule,
  defaultCorrectors,
  makeToolUseInterceptor,
  stripCodeFenceRule,
} from "./correctors.js";
export {
  type AgentLoopHooks,
  type AgentLoopOptions,
  type AgentLoopResult,
  type AgentLoopStop,
  runAgentLoop,
} from "./loop.js";
export {
  BrokeredEnclave,
  type BrokeredEnclaveOpts,
  type ExecEnclave,
  type ExecOpts,
  type ExecResult,
  LocalEnclave,
  localEnclave,
  needsCreds,
  resolveEnclave,
  RunscEnclave,
  type RunscEnclaveOpts,
  shellEnv,
  SplitEnclave,
} from "./enclave.js";
export {
  clip,
  composeExecutors,
  FS_READONLY_TOOL_DEFS,
  FS_TOOL_DEFS,
  type FsToolContext,
  makeFsExecutor,
  safePath,
} from "./tools.js";
export type {
  ChatTurnMessage,
  ContentBlock,
  PartialExecutor,
  AgentEvent,
  TextBlock,
  ThinkingBlock,
  ToolDef,
  ToolExecutor,
  ToolResult,
  ToolResultBlock,
  ToolUseBlock,
  TurnUsage,
} from "./types.js";

export { UiMessageBridge, agentEventToChunks, type SindriMessageMetadata } from "./ui-message-bridge.js";
export { chatRowsToUIMessages, blocksToParts, type ChatRow } from "./blocks-to-ui-message.js";
