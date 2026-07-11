// ─────────────────────────────────────────────────────────────────────────────
// Stream correctors (#4 POC) — the deterministic rules a BlockInterceptor runs on
// a tool_use block the instant it finalizes mid-turn, catching an obvious model
// artifact for ~free instead of a whole model heal (the v0 "LLM Suspense" lesson).
//
// Opt-in: nothing here runs unless the caller passes an interceptor to
// streamAssistant. Each rule is pure and deterministic — given the same block it
// makes the same edit or none.
// ─────────────────────────────────────────────────────────────────────────────

import type { BlockInterceptor } from "./gateway.js";
import type { ToolUseBlock } from "./types.js";

/** A rule over a tool_use call: return a corrected input + note, or null. */
export type ToolUseRule = (
  name: string,
  input: Record<string, unknown>,
) => { input: Record<string, unknown>; note: string } | null;

/** Wrap tool-use rules into a BlockInterceptor. Non-tool_use blocks pass through;
 *  the first rule that fires wins. */
export function makeToolUseInterceptor(rules: ToolUseRule[]): BlockInterceptor {
  return (block) => {
    if (block.type !== "tool_use") return null;
    const tu = block as ToolUseBlock;
    const input = tu.input as Record<string, unknown>;
    for (const rule of rules) {
      const r = rule(tu.name, input);
      if (r) return { block: { ...tu, input: r.input }, note: r.note };
    }
    return null;
  };
}

// The file-body fields our fs tools write through: write_file.content and
// edit_file.new_string.
const BODY_FIELDS = ["content", "new_string"] as const;
const FENCE = /^\s*```[a-zA-Z0-9+-]*\n([\s\S]*?)\n```\s*$/;

/** Strip a markdown code fence the model wrapped a whole file body in
 *  (```tsx\n…\n```). A frequent LLM artifact that otherwise makes the file fail
 *  to compile — the canonical "obvious" error a mid-stream fixer should erase. */
export const stripCodeFenceRule: ToolUseRule = (name, input) => {
  if (!/^(write_file|create_file|edit_file)$/.test(name)) return null;
  for (const key of BODY_FIELDS) {
    const val = input[key];
    if (typeof val !== "string") continue;
    const m = FENCE.exec(val);
    if (m) return { input: { ...input, [key]: m[1] }, note: `stripped code fence from ${name}.${key}` };
  }
  return null;
};

/** The default rule set. Deliberately tiny — a POC seam, not a rules engine. */
export const defaultCorrectors: ToolUseRule[] = [stripCodeFenceRule];
