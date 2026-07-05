/**
 * HeimdallAgentClient — Sindri's client for Heimdall's scoped Agent API.
 *
 * This is the SCOPED path: it presents HEIMDALL_AGENT_TOKEN against the
 * allow-listed /api/agent/* proxies on the Heimdall web app, never the internal
 * god-token and never the raw control-plane API. Each method performs one infra
 * mutation on behalf of a confirmed Sindri tool call and returns a tool-result
 * (`{ ok, content }`) ready to hand straight back to the model.
 */

interface EnvResult {
  ok?: boolean;
  app?: string;
  key?: string;
  target?: string;
  redeployRecommended?: boolean;
  error?: string;
}

interface RedeployResult {
  ok?: boolean;
  app?: string;
  error?: string;
}

interface RouteResult {
  ok?: boolean;
  route?: { host?: string; upstream?: string };
  error?: string;
}

interface JobResult {
  ok?: boolean;
  app?: string;
  name?: string;
  schedule?: string;
  endpoint?: string;
  redeployRecommended?: boolean;
  error?: string;
}

export interface RegisterJobInput {
  app: string;
  name: string;
  schedule: string;
  path?: string;
  method?: string;
  node?: string;
  enabled?: boolean;
}

export interface RegisterRouteInput {
  host: string;
  upstream: string;
  node?: string;
  kind?: string;
  enabled?: boolean;
}

export class HeimdallAgentClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const text = await res.text().catch(() => "");
    let json: unknown = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { error: text };
    }
    if (!res.ok) {
      const msg = (json as { error?: string }).error || `HTTP ${res.status}`;
      throw new Error(msg);
    }
    return json as T;
  }

  async setEnv(
    app: string,
    key: string,
    value: string,
    opts?: { target?: string; buildtime?: boolean },
  ): Promise<{ ok: boolean; content: string }> {
    try {
      const r = await this.post<EnvResult>("/api/agent/env", {
        app,
        key,
        value,
        target: opts?.target === "preview" ? "preview" : "production",
        buildtime: opts?.buildtime === true ? true : undefined,
      });
      const tail = r.redeployRecommended ? " — redeploy the app for it to take effect" : "";
      return { ok: true, content: `set env \`${key}\` on ${r.app} [${r.target}]${tail}` };
    } catch (e) {
      return { ok: false, content: `set_env failed: ${(e as Error).message}` };
    }
  }

  async redeploy(app: string): Promise<{ ok: boolean; content: string }> {
    try {
      const r = await this.post<RedeployResult>("/api/agent/redeploy", { app });
      return { ok: true, content: `triggered redeploy of ${r.app}` };
    } catch (e) {
      return { ok: false, content: `redeploy failed: ${(e as Error).message}` };
    }
  }

  async registerRoute(input: RegisterRouteInput): Promise<{ ok: boolean; content: string }> {
    try {
      const r = await this.post<RouteResult>("/api/agent/routes", input);
      return {
        ok: true,
        content: `route registered: ${r.route?.host} → ${r.route?.upstream} (publishes in ~30s)`,
      };
    } catch (e) {
      return { ok: false, content: `register_route failed: ${(e as Error).message}` };
    }
  }

  async registerJob(input: RegisterJobInput): Promise<{ ok: boolean; content: string }> {
    try {
      const r = await this.post<JobResult>("/api/agent/jobs", input);
      const tail = r.redeployRecommended
        ? " — first job for this app: redeploy so it picks up JOBS_SHARED_SECRET"
        : "";
      return {
        ok: true,
        content: `job "${r.name}" scheduled (${r.schedule}) → ${r.endpoint}${tail}`,
      };
    } catch (e) {
      return { ok: false, content: `register_job failed: ${(e as Error).message}` };
    }
  }
}
