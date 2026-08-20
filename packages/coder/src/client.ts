import type {
  AgentMessage,
  AgentStatus,
  BuildStatus,
  BuildTransition,
  CoderAgent,
  CoderApp,
  CoderTemplate,
  CoderUser,
  CoderWorkspace,
  RichParameter,
} from "./types.js";

export interface CoderConfig {
  /** Base URL of the Coder deployment, e.g. https://coder.coldcodelabs.com. */
  url: string;
  /** Long-lived API token Brokk authenticates with (a Coder *service* token —
   *  the control plane is the only Coder client; humans never need an account
   *  to be served by Brokk). */
  token: string;
  /** Organization slug/id. Coder OSS ships exactly one, named `default`. */
  organization?: string;
  /** Per-request timeout. Workspace *builds* are polled, never awaited in one
   *  request, so this stays short on purpose. */
  timeoutMs?: number;
}

export class CoderError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly detail?: string,
  ) {
    super(message);
    this.name = "CoderError";
  }
}

/** Build states that mean "the job is over" — polling can stop. */
const SETTLED: ReadonlySet<BuildStatus> = new Set<BuildStatus>([
  "running",
  "stopped",
  "failed",
  "canceled",
  "deleted",
]);

export class CoderClient {
  private readonly base: string;
  private readonly org: string;
  private readonly timeoutMs: number;

  constructor(private readonly cfg: CoderConfig) {
    this.base = cfg.url.replace(/\/+$/, "");
    this.org = cfg.organization ?? "default";
    this.timeoutMs = cfg.timeoutMs ?? 20_000;
  }

  /** Raw request against the Coder API. Returns the parsed body, or throws a
   *  CoderError carrying the status — callers branch on 404 rather than on a
   *  message. */
  private async api<T>(
    method: string,
    path: string,
    body?: unknown,
    init?: { timeoutMs?: number },
  ): Promise<T> {
    const res = await this.raw(method, `/api/v2${path}`, body, init);
    const text = await res.text();
    if (!res.ok) {
      throw new CoderError(`coder ${method} ${path} → ${res.status}`, res.status, text.slice(0, 500));
    }
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /** Request against any Coder path (API or app proxy), carrying the session
   *  token. Exposed so the control plane can stream an app's response through
   *  without re-implementing auth. */
  async raw(
    method: string,
    path: string,
    body?: unknown,
    init?: { timeoutMs?: number; headers?: Record<string, string> },
  ): Promise<Response> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), init?.timeoutMs ?? this.timeoutMs);
    try {
      return await fetch(`${this.base}${path}`, {
        method,
        headers: {
          "Coder-Session-Token": this.cfg.token,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(init?.headers ?? {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  // ── identity ────────────────────────────────────────────────────────────────

  me(): Promise<CoderUser> {
    return this.api<CoderUser>("GET", "/users/me");
  }

  buildInfo(): Promise<{ version: string; dashboard_url: string }> {
    return this.api("GET", "/buildinfo");
  }

  // ── templates ───────────────────────────────────────────────────────────────

  templates(): Promise<CoderTemplate[]> {
    return this.api<CoderTemplate[]>("GET", `/organizations/${this.org}/templates`);
  }

  async templateByName(name: string): Promise<CoderTemplate | null> {
    try {
      return await this.api<CoderTemplate>(
        "GET",
        `/organizations/${this.org}/templates/${encodeURIComponent(name)}`,
      );
    } catch (err) {
      if (err instanceof CoderError && err.status === 404) return null;
      throw err;
    }
  }

  // ── workspaces ──────────────────────────────────────────────────────────────

  async workspace(id: string): Promise<CoderWorkspace | null> {
    try {
      return await this.api<CoderWorkspace>("GET", `/workspaces/${id}`);
    } catch (err) {
      if (err instanceof CoderError && err.status === 404) return null;
      throw err;
    }
  }

  /** Look a workspace up the way a human would: by owner and name. `me` is the
   *  token's own user. Null when it does not exist (or was deleted). */
  async workspaceByName(name: string, owner = "me"): Promise<CoderWorkspace | null> {
    try {
      return await this.api<CoderWorkspace>(
        "GET",
        `/users/${encodeURIComponent(owner)}/workspace/${encodeURIComponent(name)}`,
      );
    } catch (err) {
      if (err instanceof CoderError && err.status === 404) return null;
      throw err;
    }
  }

  createWorkspace(input: {
    name: string;
    templateId: string;
    parameters: RichParameter[];
    owner?: string;
    ttlMs?: number;
  }): Promise<CoderWorkspace> {
    const owner = input.owner ?? "me";
    return this.api<CoderWorkspace>(
      "POST",
      `/organizations/${this.org}/members/${encodeURIComponent(owner)}/workspaces`,
      {
        name: input.name,
        template_id: input.templateId,
        rich_parameter_values: input.parameters,
        ...(input.ttlMs ? { ttl_ms: input.ttlMs } : {}),
      },
      // Provisioning enqueues a terraform job; the POST itself returns as soon
      // as the build is queued, but a busy provisioner can take a while to
      // accept it.
      { timeoutMs: 60_000 },
    );
  }

  /** Queue a build. Passing `parameters` re-applies the recipe (that is how a
   *  bancada picks up a changed dev command without being recreated); passing
   *  `templateVersionId` upgrades the workspace to a new template version. */
  build(
    workspaceId: string,
    transition: BuildTransition,
    opts?: { parameters?: RichParameter[]; templateVersionId?: string; orphan?: boolean },
  ): Promise<{ id: string; status: BuildStatus }> {
    return this.api(
      "POST",
      `/workspaces/${workspaceId}/builds`,
      {
        transition,
        ...(opts?.parameters ? { rich_parameter_values: opts.parameters } : {}),
        ...(opts?.templateVersionId ? { template_version_id: opts.templateVersionId } : {}),
        ...(transition === "delete" && opts?.orphan ? { orphan: true } : {}),
      },
      { timeoutMs: 60_000 },
    );
  }

  /** Poll until the latest build settles. Returns the workspace as of the last
   *  poll — the caller decides whether `failed` is fatal, because a failed
   *  *start* still leaves a workspace worth inspecting. */
  async waitForBuild(
    workspaceId: string,
    opts?: { timeoutMs?: number; intervalMs?: number; signal?: AbortSignal },
  ): Promise<CoderWorkspace> {
    const deadline = Date.now() + (opts?.timeoutMs ?? 10 * 60_000);
    const interval = opts?.intervalMs ?? 3_000;
    let last: CoderWorkspace | null = null;
    while (Date.now() < deadline) {
      if (opts?.signal?.aborted) break;
      last = await this.workspace(workspaceId);
      if (!last) break;
      if (SETTLED.has(last.latest_build.status)) return last;
      await sleep(interval, opts?.signal);
    }
    if (!last) throw new CoderError(`workspace ${workspaceId} vanished while building`, 404);
    return last;
  }

  async deleteWorkspace(id: string, opts?: { orphan?: boolean }): Promise<void> {
    await this.build(id, "delete", { orphan: opts?.orphan });
  }

  // ── agents & apps ───────────────────────────────────────────────────────────

  /** First agent of the latest build — the templates Brokk ships declare exactly
   *  one (`main`). */
  static agentOf(ws: CoderWorkspace): CoderAgent | null {
    for (const r of ws.latest_build.resources ?? []) {
      const a = (r.agents ?? [])[0];
      if (a) return a;
    }
    return null;
  }

  static appOf(ws: CoderWorkspace, slug: string): CoderApp | null {
    const agent = CoderClient.agentOf(ws);
    return (agent?.apps ?? []).find((a) => a.slug === slug) ?? null;
  }

  /** Public URL of a workspace app, served **by path** — no wildcard DNS and no
   *  third-level certificate (the cost that stalled `<app>.brokk.…`). */
  appUrl(ws: CoderWorkspace, slug: string): string {
    const agent = CoderClient.agentOf(ws);
    const agentName = agent?.name ?? "main";
    return `${this.base}/@${ws.owner_name}/${ws.name}.${agentName}/apps/${slug}/`;
  }

  private appPath(ws: CoderWorkspace, slug: string, sub: string): string {
    const agent = CoderClient.agentOf(ws);
    const agentName = agent?.name ?? "main";
    const tail = sub.replace(/^\/+/, "");
    return `/@${ws.owner_name}/${ws.name}.${agentName}/apps/${slug}/${tail}`;
  }

  // ── the agent inside the workspace (AgentAPI) ───────────────────────────────

  /** Ask the in-workspace agent what it is doing. `unknown` when the app is not
   *  answering — a bancada that is still booting, or one whose startup failed. */
  async agentStatus(ws: CoderWorkspace, slug = AGENT_APP_SLUG): Promise<AgentStatus> {
    const res = await this.raw("GET", this.appPath(ws, slug, "status"), undefined, {
      timeoutMs: 10_000,
    });
    if (!res.ok) return "unknown";
    const body = (await res.json()) as { status?: string };
    return body.status === "stable" || body.status === "running" ? body.status : "unknown";
  }

  async agentMessages(ws: CoderWorkspace, slug = AGENT_APP_SLUG): Promise<AgentMessage[]> {
    const res = await this.raw("GET", this.appPath(ws, slug, "messages"), undefined, {
      timeoutMs: 20_000,
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { messages?: AgentMessage[] };
    return body.messages ?? [];
  }

  /** Send a turn to the agent. `type: "user"` is a prompt; `"raw"` is keystrokes
   *  fed to the TTY (how you answer an interactive prompt without a terminal). */
  async agentSend(
    ws: CoderWorkspace,
    content: string,
    opts?: { slug?: string; type?: "user" | "raw" },
  ): Promise<boolean> {
    const res = await this.raw(
      "POST",
      this.appPath(ws, opts?.slug ?? AGENT_APP_SLUG, "message"),
      { content, type: opts?.type ?? "user" },
      { timeoutMs: 30_000 },
    );
    return res.ok;
  }
}

/** Slug of the AgentAPI app the Claude Code module publishes (`ccw` = Claude
 *  Code Web). Brokk talks to the agent only through this. */
export const AGENT_APP_SLUG = "ccw";

/** Slug of the dev-server app — the hot preview a human looks at. */
export const PREVIEW_APP_SLUG = "bancada";

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    });
  });
}
