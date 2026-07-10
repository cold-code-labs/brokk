/**
 * @brokk/mcp — the MCP bridge (ADR 0027 §4.1). Operator-configured MCP servers
 * (BROKK_MCP_SERVERS) surface as tools in Afl's loop: names namespaced
 * `mcp__<server>__<tool>`, read-only by default with per-server mutation
 * opt-in, and a PartialExecutor that composes with the native hands and never
 * throws into the loop. Dependency-light: the official SDK + @brokk/afl types.
 */

export { type McpServerConfig, parseMcpServers } from "./config.js";
export {
  flattenContent,
  gateTools,
  makeMcpExecutor,
  type McpCaller,
  type McpToolInfo,
  McpToolProvider,
  namespaceTool,
  splitToolName,
  toToolDefs,
} from "./provider.js";
