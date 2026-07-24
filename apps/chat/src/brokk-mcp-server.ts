// Brokk product MCP — stdio server OpenCode (and other clients) load so Chat
// can enqueue cards / inspect projects / previews without mixing Forge in-process.
// ADR 0073/0074: handoff to Forge is always a Brokk card/job.
//
// Env:
//   BROKK_API_URL      default http://api:8787
//   BROKK_API_SECRET   Bearer for mutating API
//   BROKK_PROJECT_ID   optional default project for enqueue_card

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const API = (process.env.BROKK_API_URL || "http://api:8787").replace(/\/$/, "");
const SECRET = process.env.BROKK_API_SECRET || "";
const DEFAULT_PROJECT = process.env.BROKK_PROJECT_ID || "";

async function api(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ ok: boolean; status: number; json: unknown }> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (SECRET) headers.Authorization = `Bearer ${SECRET}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: unknown = text;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* keep text */
  }
  return { ok: res.ok, status: res.status, json };
}

function textResult(payload: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2) }],
    isError,
  };
}

const server = new Server(
  { name: "brokk", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "enqueue_card",
      description:
        "Create a Brokk Forge card from a brief and enqueue it (Devin-class handoff). Returns taskId + status.",
      inputSchema: {
        type: "object",
        properties: {
          brief: { type: "string", description: "Work brief / acceptance criteria" },
          title: { type: "string" },
          projectId: { type: "string", description: "UUID; defaults to BROKK_PROJECT_ID" },
          repoFullName: { type: "string", description: "owner/repo if projectId omitted" },
          dedupeKey: { type: "string", description: "Idempotency key (e.g. svalinn:…)" },
          createdBy: { type: "string", default: "opencode" },
        },
        required: ["brief"],
      },
    },
    {
      name: "list_projects",
      description: "List Brokk projects visible to the API.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "get_preview",
      description: "Get live preview info for a project (port / status / branch).",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
        },
        required: ["projectId"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name;
  const args = (req.params.arguments ?? {}) as Record<string, unknown>;

  if (name === "list_projects") {
    const r = await api("GET", "/projects");
    return textResult(r.json, !r.ok);
  }

  if (name === "get_preview") {
    const projectId = String(args.projectId || "");
    if (!projectId) return textResult("projectId required", true);
    const r = await api("GET", `/previews?projectId=${encodeURIComponent(projectId)}`);
    return textResult(r.json, !r.ok);
  }

  if (name === "enqueue_card") {
    const brief = String(args.brief || "").trim();
    if (!brief) return textResult("brief required", true);
    const projectId = String(args.projectId || DEFAULT_PROJECT || "");
    const repoFullName = typeof args.repoFullName === "string" ? args.repoFullName : undefined;
    if (!projectId && !repoFullName) {
      return textResult("projectId or repoFullName required", true);
    }
    const r = await api("POST", "/ingress/cards", {
      brief,
      title: typeof args.title === "string" ? args.title : undefined,
      projectId: projectId || undefined,
      repoFullName,
      dedupeKey: typeof args.dedupeKey === "string" ? args.dedupeKey : undefined,
      createdBy: typeof args.createdBy === "string" ? args.createdBy : "opencode",
    });
    return textResult(r.json, !r.ok);
  }

  return textResult(`unknown tool: ${name}`, true);
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
