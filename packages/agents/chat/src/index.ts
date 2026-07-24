/**
 * @brokk/chat — Sindri's runtime. The interactive half of the forge: a native
 * Anthropic Messages API agentic loop (Option B — our own tool layer, not the
 * Agent SDK) that works a real git checkout with the user, persists the whole
 * transcript, and streams live. Routed through the CCL gateway (LiteLLM →
 * Ratatoskr), so the request envelope is grey-light by construction.
 *
 * Sibling to Brokkr (autonomous card→PR), Mímir (intake), Eitri (review).
 */

export { type AflConfig, loadAflConfig, resolveModel, ANTHROPIC_DIRECT_URL } from "@brokk/afl";
export {
  type CliTurnHooks,
  type CliTurnInput,
  type CliTurnOutcome,
  claudeCliAvailable,
  runClaudeCliTurn,
  cursorCliAvailable,
  runCursorCliTurn,
  openCodeCliAvailable,
  runOpenCodeCliTurn,
} from "@brokk/afl";
export { buildSystemPrompt, SCOPE_RULES, type ContextInput } from "./context.js";
export {
  INBOX_DIR,
  attachmentContextBlock,
  inboxRelPath,
  normalizeInboxPaths,
  safeInboxFilename,
} from "./attachments.js";
export { GatewayError, streamAssistant } from "@brokk/afl";
export { runTurn, type RunTurnInput } from "./loop.js";
export { makeExecutor, TOOL_DEFS, type ToolContext } from "./tools.js";
export { dispatchSkill, INVOKE_SKILL_TOOL, pinnedSkillBlock, skillCatalogue, type Skill } from "./skills.js";
export {
  loadInstructionSkills,
  resolveSkillsDir,
  skillMetaList,
  type SkillMeta,
} from "./load-skills.js";
export type {
  ChatTurnMessage,
  ContentBlock,
  AgentEvent,
  TextBlock,
  ThinkingBlock,
  ToolDef,
  ToolExecutor,
  ToolResultBlock,
  ToolUseBlock,
  TurnUsage,
} from "@brokk/afl";

export {
  UiMessageBridge,
  agentEventToChunks,
  chatRowsToUIMessages,
  blocksToParts,
  type SindriMessageMetadata,
  type ChatRow,
} from "@brokk/afl";
