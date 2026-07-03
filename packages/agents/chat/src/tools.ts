// ─────────────────────────────────────────────────────────────────────────────
// Sindri's tool layer = the shared hands (@brokk/afl: read/write/edit/list_dir +
// bash) PLUS Brokk-domain tools that the kernel deliberately does NOT carry:
//
//   create_card / list_cards  — capture follow-ups or hand work to the forge
//   plan_work                 — decompose a big intent via Mímir into backlog cards
//
// The generic file/bash tools live in afl (dependency-pure). The domain tools need
// @brokk/db (the store) + a host-injected planner, so they live here and compose
// on top of afl's executor by fall-through (composeExecutors). See NORTH-STAR §10.
// ─────────────────────────────────────────────────────────────────────────────

import type { Store } from "@brokk/db";
import {
  composeExecutors,
  FS_TOOL_DEFS,
  makeFsExecutor,
  resolveEnclave,
  type PartialExecutor,
  type ToolDef,
  type ToolExecutor,
} from "@brokk/afl";

// shellEnv lives in afl now; re-exported for callers that still import it from here.
export { shellEnv } from "@brokk/afl";

export interface ToolContext {
  /** The working checkout the tools operate in. */
  cwd: string;
  /** The Brokk project this session belongs to (for domain tools). */
  projectId: string;
  store: Store;
  /** Default base branch for cards spun off to the forge. */
  baseBranch: string;
  /** Called whenever a domain tool mutates Brokk state, so the host can surface it. */
  onDomainEvent?: (e: { kind: string; detail: unknown }) => void;
  /** Host-provided planner bridge (the `plan_work` tool): decompose an intent via
   *  Mímir into proposed backlog cards. Injected by the Sindri app (which owns the
   *  planner config + gateway); absent in contexts without a planner. */
  planWork?: (intent: string) => Promise<{ ok: boolean; content: string }>;
}

/** The Brokk-domain tool definitions, layered after afl's generic hands. */
const DOMAIN_TOOL_DEFS: ToolDef[] = [
  {
    name: "create_card",
    description:
      "Create a Brokk card (task) in this project's backlog. Use to capture follow-up work or to hand a well-scoped task to the autonomous forge.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        body: { type: "string" },
        enqueue: {
          type: "boolean",
          description: "If true, queue it immediately so Brokkr forges it to a PR.",
        },
      },
      required: ["title"],
    },
  },
  {
    name: "list_cards",
    description: "List this project's Brokk cards, optionally filtered by status.",
    input_schema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          description: "backlog | queued | running | review | done | failed | cancelled",
        },
      },
    },
  },
  {
    name: "plan_work",
    description:
      "Decompose a LARGER, multi-part request into an ordered set of well-scoped work cards using Mímir (the strong planner), and drop them into this project's backlog as PROPOSED cards for human approval. Use this when the user asks for something substantial — spanning multiple files, layers, or features — instead of a single small change (for a small change, use create_card). The cards do NOT execute until a human approves them. If the request is ambiguous, the planner may return clarifying questions for you to relay to the user.",
    input_schema: {
      type: "object",
      properties: {
        intent: {
          type: "string",
          description: "The full request to plan, in the user's own words and language.",
        },
      },
      required: ["intent"],
    },
  },
];

/** The full tool set Sindri offers: afl's hands first, then the domain tools. */
export const TOOL_DEFS: ToolDef[] = [...FS_TOOL_DEFS, ...DOMAIN_TOOL_DEFS];

/** Partial executor for the Brokk-domain tools (store + planner bound). Returns
 *  `null` for non-domain tools so afl's fs executor handles them. */
function makeDomainExecutor(ctx: ToolContext): PartialExecutor {
  return async (name, input) => {
    try {
      switch (name) {
        case "create_card": {
          const task = await ctx.store.insertTask({
            projectId: ctx.projectId,
            title: String(input.title),
            body: String(input.body ?? ""),
            status: input.enqueue ? "queued" : "backlog",
            baseBranch: ctx.baseBranch,
            createdBy: "sindri",
          });
          ctx.onDomainEvent?.({ kind: "card_created", detail: { id: task.id, enqueued: !!input.enqueue } });
          return {
            ok: true,
            content: `created card ${task.id} "${task.title}" (${task.status})`,
          };
        }
        case "list_cards": {
          const status = input.status ? (String(input.status) as never) : undefined;
          const cards = await ctx.store.listTasks({ projectId: ctx.projectId, status });
          if (!cards.length) return { ok: true, content: "(no cards)" };
          const out = cards
            .slice(0, 50)
            .map((c) => `- [${c.status}] ${c.title} (${c.id.slice(0, 8)})${c.prUrl ? ` → ${c.prUrl}` : ""}`)
            .join("\n");
          return { ok: true, content: out };
        }
        case "plan_work": {
          if (!ctx.planWork) return { ok: false, content: "planning is not available in this context" };
          const intent = String(input.intent ?? "").trim();
          if (!intent) return { ok: false, content: "plan_work needs an intent" };
          return await ctx.planWork(intent);
        }
        default:
          return null; // not a domain tool — let afl's fs executor try
      }
    } catch (e) {
      return { ok: false, content: `tool ${name} failed: ${(e as Error).message}` };
    }
  };
}

/** Build the executor bound to one session's checkout + project: afl's generic
 *  hands composed with the Brokk-domain tools. */
export function makeExecutor(ctx: ToolContext): ToolExecutor {
  return composeExecutors(
    makeFsExecutor({ cwd: ctx.cwd, enclave: resolveEnclave({ checkoutRoot: ctx.cwd }) }),
    makeDomainExecutor(ctx),
  );
}
