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

/** Expand `${VAR}` / `$VAR` in a config string from `env` (default: process.env).
 *  Unset / empty vars become "" — callers that need a live credential must check. */
export function expandEnv(value: string, env: NodeJS.ProcessEnv = process.env): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_m, braced, bare) => {
    const key = (braced ?? bare) as string;
    return env[key] ?? "";
  });
}

function expandRecord(
  rec: Record<string, string> | undefined,
  env: NodeJS.ProcessEnv,
): Record<string, string> | undefined {
  if (!rec) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(rec)) out[k] = expandEnv(v, env);
  return out;
}

/** Validate one raw entry; a string reason means "skip it". */
function validateEntry(entry: unknown, env: NodeJS.ProcessEnv): McpServerConfig | string {
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
  const url = e.url !== undefined ? expandEnv(e.url as string, env) : undefined;
  const command = e.command !== undefined ? expandEnv(e.command as string, env) : undefined;
  const headers = expandRecord(e.headers as Record<string, string> | undefined, env);
  const entryEnv = expandRecord(e.env as Record<string, string> | undefined, env);
  // Empty Authorization after expansion = operator pointed at a missing secret
  // (classic: BROKK_MCP_SERVERS still says Bearer ${HAULDR_TOKEN} after that
  // management key was retired). Refuse the entry loudly rather than mount a
  // server that will 401 on every call.
  if (headers) {
    for (const [hk, hv] of Object.entries(headers)) {
      if (/^authorization$/i.test(hk) && /^\s*Bearer\s*$/i.test(hv)) {
        return `server "${e.name}" Authorization expands to empty Bearer — set the referenced env or drop the server`;
      }
    }
  }
  return {
    name: e.name,
    transport: e.transport,
    command,
    args: e.args as string[] | undefined,
    env: entryEnv,
    url,
    headers,
    allowTools: e.allowTools as string[] | undefined,
    allowMutations: e.allowMutations === true,
  };
}

/** Parse the BROKK_MCP_SERVERS env (JSON array of McpServerConfig). Never
 *  throws: invalid/empty input → []; invalid entries are warned + skipped.
 *  String fields in url/headers/env/command expand `${VAR}` from `env`. */
export function parseMcpServers(
  raw: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): McpServerConfig[] {
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
    const cfg = validateEntry(entry, env);
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
