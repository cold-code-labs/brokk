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

/** The one server capability the executor needs — Client satisfies it, and
 *  tests hand in fakes. */
export interface McpCaller {
  callTool(params: { name: string; arguments: Record<string, unknown> }): Promise<unknown>;
}

/** Build the PartialExecutor over a set of connected servers. Owns only the
 *  `mcp__` prefix (null for everything else); within it, never throws — a
 *  transport error becomes an ok:false result the model can read. Output is
 *  clipped to the same 60k cap as the native tools. */
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
      const text = clip(flattenContent(res?.content) || "(no content)");
      return { ok: res?.isError !== true, content: text };
    } catch (e) {
      return { ok: false, content: `mcp ${parsed.server}: ${(e as Error).message}` };
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
   *  fails to connect or list is warned + skipped — the bridge never throws,
   *  a broken MCP config must not take the agent down. */
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
        console.warn(`mcp ${cfg.name}: connect failed — skipped (${(e as Error).message})`);
      }
    }
    return new McpToolProvider(clients, servers, toolDefs);
  }

  /** Close every client, best-effort — a hung server must not block shutdown. */
  async close(): Promise<void> {
    await Promise.allSettled(this.clients.map((c) => c.close()));
  }
}
