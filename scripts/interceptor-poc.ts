// Stream interceptor POC (#4). Proves the seam: a tool_use block that arrives
// mid-turn with an obvious model artifact (a whole file body wrapped in a ```tsx
// fence) is corrected the instant it finalizes — BEFORE the loop would append it,
// run the tool, verify, and pay a model heal to notice. Uses the real SSE mock
// gateway, so it exercises the real streamAssistant parse path.
//
//   node --experimental-transform-types scripts/interceptor-poc.ts

import { streamAssistant, type MessagesRequest } from "../packages/afl/src/gateway.ts";
import { makeToolUseInterceptor, defaultCorrectors } from "../packages/afl/src/correctors.ts";
import type { ToolUseBlock } from "../packages/afl/src/types.ts";
import { MockGateway, mockCfg } from "../evals/mock-gateway.ts";

let fail = 0;
const ok = (name: string, cond: boolean, got?: unknown) => {
  console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : `  got=${JSON.stringify(got)}`}`);
  if (!cond) fail++;
};

const FENCED = "```tsx\nexport const A = () => <div/>;\n```";
const CLEAN = "export const A = () => <div/>;";

const gw = new MockGateway();
const url = await gw.start();
const cfg = mockCfg(url);

const req: MessagesRequest = {
  model: "mock-haiku",
  system: "s",
  messages: [{ role: "user", content: [{ type: "text", text: "make the file" }] }],
  tools: [],
  maxTokens: 256,
};
const round = () => [{
  blocks: [{ type: "tool_use" as const, id: "t1", name: "write_file", input: { path: "A.tsx", content: FENCED } }],
  stopReason: "tool_use",
}];

// Control: no interceptor → the fenced body passes through unchanged (today's behaviour).
gw.load(round());
const base = await streamAssistant(cfg, req, () => {});
const baseContent = (base.blocks[0] as ToolUseBlock).input.content;
ok("control: without interceptor the ```fence``` survives (would break the build)", baseContent === FENCED, baseContent);
ok("control: no corrections recorded", base.corrections === undefined);

// With the default corrector → the fence is stripped mid-stream, note recorded.
gw.load(round());
const t0 = Date.now();
const fixed = await streamAssistant(cfg, req, () => {}, undefined, makeToolUseInterceptor(defaultCorrectors));
const ms = Date.now() - t0;
const fixedContent = (fixed.blocks[0] as ToolUseBlock).input.content;
ok("interceptor: fence stripped at finalize (write_file.content)", fixedContent === CLEAN, fixedContent);
ok("interceptor: correction note recorded", Array.isArray(fixed.corrections) && fixed.corrections.length === 1, fixed.corrections);

await gw.stop();
console.log(
  fail === 0
    ? `\nALL PASS — obvious artifact corrected mid-stream in ${ms}ms with 0 extra model tokens (vs a tool-run + verify + model-heal cycle to catch the same).`
    : `\n${fail} FAIL`,
);
process.exit(fail ? 1 : 0);
