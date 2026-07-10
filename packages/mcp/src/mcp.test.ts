/**
 * The MCP bridge suite — the pure half of the bridge (config parsing, gating,
 * namespacing, result flattening, executor routing) tested with fakes, no live
 * MCP connection. The contract that must never go red: read-only by default,
 * foreign tool names fall through as null, and nothing here ever throws into
 * the loop. Run: `pnpm --filter @brokk/mcp test`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMcpServers } from "./config.js";
import {
  flattenContent,
  gateTools,
  makeMcpExecutor,
  type McpCaller,
  type McpToolInfo,
  namespaceTool,
  splitToolName,
  toToolDefs,
} from "./provider.js";

/** Run fn with console.warn muted (the parser warns on skipped entries). */
async function quiet<T>(fn: () => T | Promise<T>): Promise<T> {
  const orig = console.warn;
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    console.warn = orig;
  }
}

// ── parseMcpServers ─────────────────────────────────────────────────────────────

test("parseMcpServers: empty/undefined/garbage input → []", async () => {
  await quiet(() => {
    assert.deepEqual(parseMcpServers(undefined), []);
    assert.deepEqual(parseMcpServers(""), []);
    assert.deepEqual(parseMcpServers("   "), []);
    assert.deepEqual(parseMcpServers("not json"), []);
    assert.deepEqual(parseMcpServers('{"name":"x"}'), []); // object, not array
    assert.deepEqual(parseMcpServers("[]"), []);
  });
});

test("parseMcpServers: valid stdio + http entries survive with fields intact", () => {
  const raw = JSON.stringify([
    { name: "gh", transport: "stdio", command: "gh-mcp", args: ["--ro"], env: { A: "1" } },
    {
      name: "hauldr",
      transport: "http",
      url: "https://mcp.example.com",
      headers: { Authorization: "Bearer x" },
      allowTools: ["query"],
      allowMutations: true,
    },
  ]);
  const out = parseMcpServers(raw);
  assert.equal(out.length, 2);
  assert.equal(out[0].name, "gh");
  assert.equal(out[0].command, "gh-mcp");
  assert.deepEqual(out[0].args, ["--ro"]);
  assert.equal(out[0].allowMutations, false); // absent → false, read-only default
  assert.equal(out[1].url, "https://mcp.example.com");
  assert.deepEqual(out[1].allowTools, ["query"]);
  assert.equal(out[1].allowMutations, true);
});

test("parseMcpServers: invalid entries are skipped, valid ones kept", async () => {
  const raw = JSON.stringify([
    { name: "ok", transport: "stdio", command: "srv" },
    { name: "no-cmd", transport: "stdio" }, // stdio without command
    { name: "no-url", transport: "http" }, // http without url
    { transport: "stdio", command: "x" }, // missing name
    { name: "bad__name", transport: "stdio", command: "x" }, // __ breaks namespacing
    { name: "bad-transport", transport: "ws", url: "x" },
    { name: "ok", transport: "stdio", command: "dupe" }, // duplicate name
    "not an object",
  ]);
  const out = await quiet(() => parseMcpServers(raw));
  assert.equal(out.length, 1);
  assert.equal(out[0].command, "srv");
});

// ── gating ──────────────────────────────────────────────────────────────────────

const TOOLS: McpToolInfo[] = [
  { name: "read_thing", description: "reads", annotations: { readOnlyHint: true } },
  { name: "write_thing", description: "writes", annotations: { readOnlyHint: false } },
  { name: "unannotated", description: "who knows" },
];

test("gateTools: read-only by default — only readOnlyHint tools survive", () => {
  const out = gateTools({}, TOOLS);
  assert.deepEqual(out.map((t) => t.name), ["read_thing"]);
});

test("gateTools: allowMutations exposes everything", () => {
  const out = gateTools({ allowMutations: true }, TOOLS);
  assert.equal(out.length, 3);
});

test("gateTools: allowTools is an exact list and wins over both defaults", () => {
  const out = gateTools({ allowTools: ["write_thing", "missing"] }, TOOLS);
  assert.deepEqual(out.map((t) => t.name), ["write_thing"]);
  // and it RESTRICTS even under allowMutations
  const out2 = gateTools({ allowTools: ["read_thing"], allowMutations: true }, TOOLS);
  assert.deepEqual(out2.map((t) => t.name), ["read_thing"]);
});

// ── namespacing ─────────────────────────────────────────────────────────────────

test("namespaceTool/splitToolName round-trip, including __ in the tool name", () => {
  assert.equal(namespaceTool("gh", "list_prs"), "mcp__gh__list_prs");
  assert.deepEqual(splitToolName("mcp__gh__list_prs"), { server: "gh", tool: "list_prs" });
  // tool names may contain __ — split happens at the FIRST separator only
  assert.deepEqual(splitToolName(namespaceTool("gh", "repo__view")), {
    server: "gh",
    tool: "repo__view",
  });
});

test("splitToolName: null for foreign and malformed names", () => {
  assert.equal(splitToolName("read_file"), null);
  assert.equal(splitToolName("mcp__"), null);
  assert.equal(splitToolName("mcp__noseparator"), null);
  assert.equal(splitToolName("mcp____tool"), null); // empty server
  assert.equal(splitToolName("mcp__srv__"), null); // empty tool
});

test("toToolDefs: namespaced names, schema passthrough, safe defaults", () => {
  const defs = toToolDefs("gh", [
    { name: "q", description: "query", inputSchema: { type: "object", properties: {} } },
    { name: "bare" },
  ]);
  assert.equal(defs[0].name, "mcp__gh__q");
  assert.deepEqual(defs[0].input_schema, { type: "object", properties: {} });
  assert.equal(defs[1].description, "");
  assert.deepEqual(defs[1].input_schema, { type: "object" });
});

// ── result flattening ───────────────────────────────────────────────────────────

test("flattenContent: text joined, non-text noted, junk tolerated", () => {
  const out = flattenContent([
    { type: "text", text: "hello" },
    { type: "image", data: "…" },
    { type: "text", text: "world" },
    { weird: true },
  ]);
  assert.equal(out, "hello\n[image content]\nworld\n[unknown content]");
  assert.equal(flattenContent(undefined), "");
  assert.equal(flattenContent("nope"), "");
});

// ── executor ────────────────────────────────────────────────────────────────────

function fakeServers(caller: McpCaller): Map<string, McpCaller> {
  return new Map([["srv", caller]]);
}

test("executor: null for names outside the mcp__ prefix (fall-through)", async () => {
  const exec = makeMcpExecutor(fakeServers({ callTool: async () => ({}) }));
  assert.equal(await exec("read_file", {}), null);
  assert.equal(await exec("bash", { command: "ls" }), null);
});

test("executor: routes to the right server+tool and flattens the result", async () => {
  const calls: unknown[] = [];
  const exec = makeMcpExecutor(
    fakeServers({
      callTool: async (p) => {
        calls.push(p);
        return { content: [{ type: "text", text: "ok!" }] };
      },
    }),
  );
  const res = await exec("mcp__srv__do__thing", { a: 1 });
  assert.deepEqual(res, { ok: true, content: "ok!" });
  assert.deepEqual(calls, [{ name: "do__thing", arguments: { a: 1 } }]);
});

test("executor: isError → ok:false; thrown transport error → ok:false, no throw", async () => {
  const errExec = makeMcpExecutor(
    fakeServers({ callTool: async () => ({ isError: true, content: [{ type: "text", text: "boom" }] }) }),
  );
  assert.deepEqual(await errExec("mcp__srv__t", {}), { ok: false, content: "boom" });

  const throwExec = makeMcpExecutor(
    fakeServers({
      callTool: async () => {
        throw new Error("conn reset");
      },
    }),
  );
  assert.deepEqual(await throwExec("mcp__srv__t", {}), { ok: false, content: "mcp srv: conn reset" });
});

test("executor: unknown server / malformed name → ok:false, never null, never throw", async () => {
  const exec = makeMcpExecutor(fakeServers({ callTool: async () => ({}) }));
  const missing = await exec("mcp__ghost__t", {});
  assert.equal(missing?.ok, false);
  const malformed = await exec("mcp__nosep", {});
  assert.equal(malformed?.ok, false);
});

test("executor: clips output at the 60k cap like the native tools", async () => {
  const exec = makeMcpExecutor(
    fakeServers({
      callTool: async () => ({ content: [{ type: "text", text: "x".repeat(70_000) }] }),
    }),
  );
  const res = await exec("mcp__srv__big", {});
  assert.equal(res?.ok, true);
  assert.ok(res && res.content.length < 61_000);
  assert.match(res?.content ?? "", /truncated 10000 chars/);
});

test("executor: empty content → '(no content)' placeholder", async () => {
  const exec = makeMcpExecutor(fakeServers({ callTool: async () => ({ content: [] }) }));
  assert.deepEqual(await exec("mcp__srv__t", {}), { ok: true, content: "(no content)" });
});
