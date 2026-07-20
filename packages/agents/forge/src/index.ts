/**
 * @brokk/forge — Brokkr, the autonomous build agent. Persona (system prompt) +
 * its task/heal prompts + the engine that forges a card to completion over the
 * @brokk/afl kernel (NO Agent SDK). Implements core's AgentEngine port, so the
 * runner app hosts it unchanged. The first second-consumer of afl's generic
 * agent-loop primitive — the validating case the kernel was extracted for.
 * See docs/NORTH-STAR.md §5, §7, §9, §10.
 */

export {
  ClaudeCliEngine,
  type ClaudeCliEngineOptions,
  CursorCliEngine,
  type CursorCliEngineOptions,
} from "./cli-engine.js";
export { ForgeEngine, type ForgeEngineOptions } from "./engine.js";
export { buildHealPrompt, buildPrompt, DEFAULT_SYSTEM_PROMPT } from "./prompts.js";
export { MIGRATION_TOOL_DEF, makeMigrationExecutor, type MigrationToolContext } from "./tools.js";
