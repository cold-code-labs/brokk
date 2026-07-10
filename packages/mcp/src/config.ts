// ─────────────────────────────────────────────────────────────────────────────
// MCP server configuration — parsed from the BROKK_MCP_SERVERS env (a JSON
// array), the same operator-facing seam shape as the rest of the fleet config.
// Parsing is forgiving by design: a bad env var must never crash the host, so
// invalid JSON → [] and invalid entries are warned about and skipped, keeping
// the healthy servers alive. See docs/adr/0027 §4.1.
// ─────────────────────────────────────────────────────────────────────────────

/** One configured MCP server. Gating (allowTools/allowMutations) follows the
 *  shellEnv spirit: read-only by default, mutation opt-in per server. */
export interface McpServerConfig {
  /** Unique label; becomes the `mcp__<name>__…` tool-name prefix. No `__`. */
  name: string;
  transport: "stdio" | "http";
  /** stdio: the executable to spawn. Required for transport "stdio". */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** http: the Streamable HTTP endpoint. Required for transport "http". */
  url?: string;
  headers?: Record<string, string>;
  /** Exact allowlist of tool names (original, un-namespaced). Wins over both
   *  allowMutations and the read-only default. */
  allowTools?: string[];
  /** Expose every tool the server offers, mutating ones included. Default
   *  false: only tools annotated readOnlyHint are exposed. */
  allowMutations?: boolean;
}

const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isStrArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((s) => typeof s === "string");
const isStrRecord = (v: unknown): v is Record<string, string> =>
  typeof v === "object" && v !== null && !Array.isArray(v) &&
  Object.values(v).every((s) => typeof s === "string");

/** Validate one raw entry; a string reason means "skip it". */
function validateEntry(entry: unknown): McpServerConfig | string {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return "not an object";
  const e = entry as Record<string, unknown>;
  if (!isStr(e.name)) return "missing name";
  // `__` is the namespace separator in mcp__<server>__<tool> — a server name
  // containing it would make tool names unroutable.
  if (e.name.includes("__")) return `name "${e.name}" contains "__"`;
  if (e.transport !== "stdio" && e.transport !== "http") return `bad transport for "${e.name}"`;
  if (e.transport === "stdio" && !isStr(e.command)) return `stdio server "${e.name}" missing command`;
  if (e.transport === "http" && !isStr(e.url)) return `http server "${e.name}" missing url`;
  if (e.args !== undefined && !isStrArray(e.args)) return `server "${e.name}" has bad args`;
  if (e.env !== undefined && !isStrRecord(e.env)) return `server "${e.name}" has bad env`;
  if (e.headers !== undefined && !isStrRecord(e.headers)) return `server "${e.name}" has bad headers`;
  if (e.allowTools !== undefined && !isStrArray(e.allowTools)) return `server "${e.name}" has bad allowTools`;
  return {
    name: e.name,
    transport: e.transport,
    command: e.command as string | undefined,
    args: e.args as string[] | undefined,
    env: e.env as Record<string, string> | undefined,
    url: e.url as string | undefined,
    headers: e.headers as Record<string, string> | undefined,
    allowTools: e.allowTools as string[] | undefined,
    allowMutations: e.allowMutations === true,
  };
}

/** Parse the BROKK_MCP_SERVERS env (JSON array of McpServerConfig). Never
 *  throws: invalid/empty input → []; invalid entries are warned + skipped. */
export function parseMcpServers(raw: string | undefined): McpServerConfig[] {
  if (!raw?.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn("BROKK_MCP_SERVERS: invalid JSON — ignoring");
    return [];
  }
  if (!Array.isArray(parsed)) {
    console.warn("BROKK_MCP_SERVERS: expected a JSON array — ignoring");
    return [];
  }
  const out: McpServerConfig[] = [];
  for (const entry of parsed) {
    const cfg = validateEntry(entry);
    if (typeof cfg === "string") {
      console.warn(`BROKK_MCP_SERVERS: skipping entry (${cfg})`);
      continue;
    }
    if (out.some((c) => c.name === cfg.name)) {
      console.warn(`BROKK_MCP_SERVERS: skipping duplicate server "${cfg.name}"`);
      continue;
    }
    out.push(cfg);
  }
  return out;
}
