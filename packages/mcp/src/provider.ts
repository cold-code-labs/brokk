// ─────────────────────────────────────────────────────────────────────────────
// The MCP bridge — surfaces operator-configured MCP servers as tools in Afl's
// loop (ADR 0027 §4.1). Names are namespaced `mcp__<server>__<tool>` so they
// can never collide with native tools, and the executor is a PartialExecutor
// that owns exactly that prefix — it composes with the fs/domain executors via
// `composeExecutors` fall-through.
//
// Trust model, same shellEnv spirit as the bash hand: read-only by default —
// a tool is only exposed if the server annotates it readOnlyHint — with
// mutation opt-in per server (allowMutations) or an exact allowTools list.
// And the bridge must never take the host down: a server that fails to connect
// or list is warned + skipped; a tool call that throws becomes an ok:false
// ToolResult, never an exception into the loop.
//
// The pure parts (gating, namespacing, ToolDef mapping, result flattening, the
// executor factory) are exported standalone so they unit-test without a live
// MCP connection; McpToolProvider is the thin stateful shell around them.
// ─────────────────────────────────────────────────────────────────────────────

import { clip, type PartialExecutor, type ToolDef } from "@brokk/afl";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServerConfig } from "./config.js";

const PREFIX = "mcp__";

/** The slice of an MCP tool listing the bridge cares about. */
export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; [k: string]: unknown };
}

/** Namespace a server's tool into the loop-facing name. */
export function namespaceTool(server: string, tool: string): string {
  return `${PREFIX}${server}__${tool}`;
}

/** Invert namespaceTool. Server names never contain `__` (enforced at parse),
 *  so we split at the FIRST separator — tool names may legally contain `__`.
 *  Returns null for anything that is not a well-formed mcp name. */
export function splitToolName(name: string): { server: string; tool: string } | null {
  if (!name.startsWith(PREFIX)) return null;
  const rest = name.slice(PREFIX.length);
  const sep = rest.indexOf("__");
  if (sep <= 0 || sep + 2 >= rest.length) return null;
  return { server: rest.slice(0, sep), tool: rest.slice(sep + 2) };
}

/** Apply a server's gate to its tool listing. Precedence: allowTools (exact
 *  list, by original name) > allowMutations (everything) > read-only default
 *  (only tools the server annotates readOnlyHint). Filtered tools simply do
 *  not exist for the model. */
export function gateTools(
  cfg: Pick<McpServerConfig, "allowTools" | "allowMutations">,
  tools: McpToolInfo[],
): McpToolInfo[] {
  if (cfg.allowTools) {
    const allow = new Set(cfg.allowTools);
    return tools.filter((t) => allow.has(t.name));
  }
  if (cfg.allowMutations) return tools;
  return tools.filter((t) => t.annotations?.readOnlyHint === true);
}

/** Map a server's (already gated) tools to afl ToolDefs with namespaced names. */
export function toToolDefs(server: string, tools: McpToolInfo[]): ToolDef[] {
  return tools.map((t) => ({
    name: namespaceTool(server, t.name),
    description: t.description ?? "",
    input_schema: t.inputSchema ?? { type: "object" },
  }));
}

/** Flatten a callTool result's content blocks to the text the model sees:
 *  text parts joined, non-text parts noted as `[<type> content]`. */
export function flattenContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      const b = block as { type?: string; text?: unknown };
      if (b?.type === "text" && typeof b.text === "string") return b.text;
      return `[${b?.type ?? "unknown"} content]`;
    })
    .join("\n");
}

/** True when an error / response body is an HTTP auth rejection (401/403).
 *  Used so we never flatten a credential failure into "(no content)". */
export function isAuthFailure(message: string): boolean {
  const m = message.toLowerCase();
  return (
    /\b401\b/.test(m) ||
    /\b403\b/.test(m) ||
    m.includes("unauthorized") ||
    m.includes("forbidden") ||
    m.includes("authentication") ||
    m.includes("invalid token") ||
    m.includes("invalid api key")
  );
}

/** Loud, retry-discouraging copy for a dead MCP credential. */
export function authFailureMessage(server: string, detail: string): string {
  const d = detail.trim() || "401/403";
  return (
    `mcp ${server}: AUTH FAILED (${d}). Credential rejected — fix BROKK_MCP_SERVERS ` +
    `headers (do not embed a retired HAULDR_TOKEN; expand \${ENV} from a live secret) ` +
    `or remove the server. Do not retry the same call.`
  );
}

/** The one server capability the executor needs — Client satisfies it, and
 *  tests hand in fakes. */
export interface McpCaller {
  callTool(params: { name: string; arguments: Record<string, unknown> }): Promise<unknown>;
}

/** Build the PartialExecutor over a set of connected servers. Owns only the
 *  `mcp__` prefix (null for everything else); within it, never throws — a
 *  transport error becomes an ok:false result the model can read. Auth
 *  failures (401/403) are spelled out so the agent cannot treat a dead token
 *  as an empty success. Output is clipped to the same 60k cap as native tools. */
export function makeMcpExecutor(servers: ReadonlyMap<string, McpCaller>): PartialExecutor {
  return async (name, input) => {
    if (!name.startsWith(PREFIX)) return null; // not ours — fall through
    const parsed = splitToolName(name);
    if (!parsed) return { ok: false, content: `malformed mcp tool name: ${name}` };
    const server = servers.get(parsed.server);
    if (!server) return { ok: false, content: `unknown mcp server: ${parsed.server}` };
    try {
      const res = (await server.callTool({ name: parsed.tool, arguments: input })) as {
        content?: unknown;
        isError?: boolean;
      };
      const flat = flattenContent(res?.content);
      const combined = `${flat}\n${res?.isError === true ? "isError" : ""}`;
      if (isAuthFailure(combined) || (res?.isError === true && isAuthFailure(flat))) {
        return { ok: false, content: authFailureMessage(parsed.server, flat || "isError") };
      }
      // Empty isError bodies used to become "(no content)" — silent death for a
      // 401 that only set the flag. Prefer a loud unknown-error over quiet ok.
      if (res?.isError === true && !flat.trim()) {
        return {
          ok: false,
          content: `mcp ${parsed.server}: tool returned isError with empty body — treat as failure (often a rejected credential)`,
        };
      }
      const text = clip(flat || "(no content)");
      return { ok: res?.isError !== true, content: text };
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      if (isAuthFailure(msg)) {
        return { ok: false, content: authFailureMessage(parsed.server, msg) };
      }
      return { ok: false, content: `mcp ${parsed.server}: ${msg}` };
    }
  };
}

/** Connected MCP servers exposed as afl tools. Construct via `connect`; hand
 *  `toolDefs` to the model and compose `executor` with the native executors. */
export class McpToolProvider {
  readonly toolDefs: ToolDef[];
  readonly executor: PartialExecutor;
  private readonly clients: Client[];

  private constructor(clients: Client[], servers: Map<string, McpCaller>, toolDefs: ToolDef[]) {
    this.clients = clients;
    this.toolDefs = toolDefs;
    this.executor = makeMcpExecutor(servers);
  }

  /** Connect each configured server and list+gate its tools. A server that
   *  fails to connect or list is skipped — the bridge never throws, a broken
   *  MCP config must not take the host down. Auth failures (401/403) log at
   *  error level with an explicit "do not call these tools" message so a dead
   *  Hauldr token cannot sit quietly while the agent keeps retrying. */
  static async connect(configs: McpServerConfig[]): Promise<McpToolProvider> {
    const clients: Client[] = [];
    const servers = new Map<string, McpCaller>();
    const toolDefs: ToolDef[] = [];
    for (const cfg of configs) {
      if (servers.has(cfg.name)) {
        console.warn(`mcp ${cfg.name}: duplicate server name — skipped`);
        continue;
      }
      try {
        const transport =
          cfg.transport === "stdio"
            ? new StdioClientTransport({
                command: cfg.command ?? "",
                args: cfg.args,
                // Merge onto the SDK's safe default env (PATH etc.) — passing
                // env alone would REPLACE it and break most server binaries.
                env: { ...getDefaultEnvironment(), ...cfg.env },
              })
            : new StreamableHTTPClientTransport(
                new URL(cfg.url ?? ""),
                cfg.headers ? { requestInit: { headers: cfg.headers } } : undefined,
              );
        const client = new Client({ name: "brokk", version: "0.0.0" });
        await client.connect(transport);
        // Tool listings paginate; walk every page before gating.
        const tools: McpToolInfo[] = [];
        let cursor: string | undefined;
        do {
          const page = await client.listTools(cursor ? { cursor } : undefined);
          tools.push(
            ...page.tools.map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema as Record<string, unknown>,
              annotations: t.annotations as McpToolInfo["annotations"],
            })),
          );
          cursor = page.nextCursor;
        } while (cursor);
        toolDefs.push(...toToolDefs(cfg.name, gateTools(cfg, tools)));
        clients.push(client);
        servers.set(cfg.name, client);
      } catch (e) {
        const msg = (e as Error).message ?? String(e);
        if (isAuthFailure(msg)) {
          // Fail LOUD — a skipped warn was the "tool morta, calado" failure mode
          // when Hauldr's Bearer 401'd: connect died, no tools mounted, agent
          // still believed the server existed from docs/memory.
          console.error(authFailureMessage(cfg.name, msg));
          console.error(
            `mcp ${cfg.name}: NOT mounted — remove it from BROKK_MCP_SERVERS or restore a valid credential`,
          );
        } else {
          console.warn(`mcp ${cfg.name}: connect failed — skipped (${msg})`);
        }
      }
    }
    return new McpToolProvider(clients, servers, toolDefs);
  }

  /** Close every client, best-effort — a hung server must not block shutdown. */
  async close(): Promise<void> {
    await Promise.allSettled(this.clients.map((c) => c.close()));
  }
}
