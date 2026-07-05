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
  /** Host-injected infra-intent bridges (the set_env / redeploy_app /
   *  register_route / register_job tools). Each performs ONE scoped mutation via
   *  Heimdall's Agent API (the scoped agent token, never the god-token) and
   *  returns a tool-result. Injected by the Sindri app when HEIMDALL_AGENT_URL +
   *  HEIMDALL_AGENT_TOKEN are set; absent otherwise (the tools then report that
   *  infra actions are unavailable). Mutations are confirmation-gated at the tool
   *  layer — see the `confirm` flag in makeDomainExecutor. */
  infra?: {
    setEnv(
      app: string,
      key: string,
      value: string,
      opts?: { target?: string; buildtime?: boolean },
    ): Promise<{ ok: boolean; content: string }>;
    redeploy(app: string): Promise<{ ok: boolean; content: string }>;
    registerRoute(input: {
      host: string;
      upstream: string;
      node?: string;
      kind?: string;
      enabled?: boolean;
    }): Promise<{ ok: boolean; content: string }>;
    registerJob(input: {
      app: string;
      name: string;
      schedule: string;
      path?: string;
      method?: string;
      node?: string;
      enabled?: boolean;
    }): Promise<{ ok: boolean; content: string }>;
  };
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
  {
    name: "set_env",
    description:
      "Set an environment variable on a DEPLOYED app via the control plane (Heimdall). This is the runtime/prod value — the code that READS the var is a normal edit, this sets the VALUE. MUTATING + INFRA: first show the user exactly what will change (app, key, and for a secret say the value is set but not echoed), get their explicit approval, and only THEN call again with confirm:true. Without confirm:true it returns a dry-run preview and applies nothing. A runtime env change takes effect on the next deploy (use redeploy_app after).",
    input_schema: {
      type: "object",
      properties: {
        app: { type: "string", description: 'app name or slug, e.g. "maglink"' },
        key: { type: "string", description: "the env var name" },
        value: { type: "string", description: "the value to set" },
        target: { type: "string", description: '"production" (default) or "preview"' },
        buildtime: {
          type: "boolean",
          description: "set true if the var is needed at build time, not just runtime",
        },
        confirm: {
          type: "boolean",
          description: "must be true to APPLY; omit/false to get a dry-run preview first",
        },
      },
      required: ["app", "key", "value"],
    },
  },
  {
    name: "redeploy_app",
    description:
      "Trigger a redeploy of a deployed app via the control plane (Heimdall). Use after set_env so the app picks up the new value. MUTATING: confirm with the user first, then call with confirm:true.",
    input_schema: {
      type: "object",
      properties: {
        app: { type: "string", description: 'app name or slug, e.g. "maglink"' },
        confirm: { type: "boolean", description: "must be true to APPLY; omit for a preview" },
      },
      required: ["app"],
    },
  },
  {
    name: "register_route",
    description:
      "Register or update a custom Traefik route (host → upstream) for a multi-port / compose app whose mapping the deploy engine can't infer, via Heimdall. MUTATING + INFRA: confirm the host and upstream with the user, then call with confirm:true. The host-side reconciler publishes it within ~30s.",
    input_schema: {
      type: "object",
      properties: {
        host: { type: "string", description: "public hostname, e.g. app.coldcodelabs.com" },
        upstream: { type: "string", description: "where traffic goes, e.g. http://container:port" },
        node: { type: "string", description: 'which node owns the route (default "ymir")' },
        confirm: { type: "boolean", description: "must be true to APPLY; omit for a preview" },
      },
      required: ["host", "upstream"],
    },
  },
  {
    name: "register_job",
    description:
      "Register (or update) a scheduled job (cron) for an app via Heimdall. The job calls the app's /api/jobs/<name> route on the schedule. The app MUST expose that route and verify the JOBS_SHARED_SECRET header — write that route in code first (a normal edit/PR) if it doesn't exist. MUTATING + INFRA: show the user the app, job name, schedule and endpoint, get approval, then call with confirm:true. The FIRST job registered for an app also sets JOBS_SHARED_SECRET and needs a redeploy_app to activate.",
    input_schema: {
      type: "object",
      properties: {
        app: { type: "string", description: 'app name or slug, e.g. "maglink"' },
        name: {
          type: "string",
          description: "stable job name — becomes the /api/jobs/<name> path segment",
        },
        schedule: {
          type: "string",
          description: 'cron expression, e.g. "0 3 * * *" for daily at 03:00',
        },
        path: {
          type: "string",
          description: "optional endpoint path override; defaults to /api/jobs/<name>",
        },
        node: { type: "string", description: 'which node runs the job (default "ymir")' },
        confirm: { type: "boolean", description: "must be true to APPLY; omit for a preview" },
      },
      required: ["app", "name", "schedule"],
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
        case "set_env": {
          if (!ctx.infra) return { ok: false, content: "infra actions are not available in this context" };
          const app = String(input.app ?? "").trim();
          const key = String(input.key ?? "").trim();
          const value = String(input.value ?? "");
          if (!app || !key) return { ok: false, content: "set_env needs app and key" };
          const target = input.target === "preview" ? "preview" : "production";
          if (input.confirm !== true) {
            const mask = value.length <= 4 ? "••••" : `${value.slice(0, 2)}••••(${value.length} chars)`;
            return {
              ok: true,
              content: `PREVIEW (nothing applied): set env \`${key}\`=${mask} on app "${app}" [${target}]. Show this to the user and call set_env again with confirm:true ONLY after they approve.`,
            };
          }
          const res = await ctx.infra.setEnv(app, key, value, {
            target,
            buildtime: input.buildtime === true,
          });
          if (res.ok) ctx.onDomainEvent?.({ kind: "infra_mutation", detail: { action: "set_env", app, key } });
          return res;
        }
        case "redeploy_app": {
          if (!ctx.infra) return { ok: false, content: "infra actions are not available in this context" };
          const app = String(input.app ?? "").trim();
          if (!app) return { ok: false, content: "redeploy_app needs app" };
          if (input.confirm !== true) {
            return {
              ok: true,
              content: `PREVIEW (nothing applied): would trigger a redeploy of "${app}". Call redeploy_app again with confirm:true after the user approves.`,
            };
          }
          const res = await ctx.infra.redeploy(app);
          if (res.ok) ctx.onDomainEvent?.({ kind: "infra_mutation", detail: { action: "redeploy", app } });
          return res;
        }
        case "register_route": {
          if (!ctx.infra) return { ok: false, content: "infra actions are not available in this context" };
          const host = String(input.host ?? "").trim();
          const upstream = String(input.upstream ?? "").trim();
          if (!host || !upstream) return { ok: false, content: "register_route needs host and upstream" };
          if (input.confirm !== true) {
            return {
              ok: true,
              content: `PREVIEW (nothing applied): would route ${host} → ${upstream}. Call register_route again with confirm:true after the user approves.`,
            };
          }
          const res = await ctx.infra.registerRoute({
            host,
            upstream,
            node: input.node ? String(input.node) : undefined,
          });
          if (res.ok) ctx.onDomainEvent?.({ kind: "infra_mutation", detail: { action: "register_route", host } });
          return res;
        }
        case "register_job": {
          if (!ctx.infra) return { ok: false, content: "infra actions are not available in this context" };
          const app = String(input.app ?? "").trim();
          const name = String(input.name ?? "").trim();
          const schedule = String(input.schedule ?? "").trim();
          if (!app || !name || !schedule) return { ok: false, content: "register_job needs app, name and schedule" };
          const path = typeof input.path === "string" && input.path.trim() ? String(input.path).trim() : `/api/jobs/${name}`;
          if (input.confirm !== true) {
            return {
              ok: true,
              content: `PREVIEW (nothing applied): would schedule job "${name}" on app "${app}" — cron "${schedule}" → ${path}. Make sure the app exposes that route (verifying JOBS_SHARED_SECRET) first. Call register_job again with confirm:true after the user approves.`,
            };
          }
          const res = await ctx.infra.registerJob({
            app,
            name,
            schedule,
            path: typeof input.path === "string" && input.path.trim() ? String(input.path).trim() : undefined,
            node: input.node ? String(input.node) : undefined,
          });
          if (res.ok) ctx.onDomainEvent?.({ kind: "infra_mutation", detail: { action: "register_job", app, name } });
          return res;
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
