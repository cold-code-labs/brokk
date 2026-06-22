/**
 * HauldrClient — HTTP client for the Hauldr control-plane.
 *
 * Implements the {@link Hauldr} port declared in `@brokk/core` so the preview
 * supervisor can provision and look up dev-preview Supabase-compatible projects
 * via GET/POST /v1/projects against HAULDR_CONTROL_URL.
 */
import type { Hauldr, HauldrProject } from "@brokk/core";

/** A provisioned service block in the control-plane status response. */
interface RawService {
  url?: string | null;
  ready?: boolean;
}

/** Wire format of GET/POST /v1/projects from the Hauldr control-plane.
 *  The status (GET) response nests endpoints under `services` and secrets under
 *  `internal`; older/flat shapes are also tolerated. */
interface RawProject {
  name?: string;
  status?: string;
  database?: string;
  db?: string;
  db_url?: string;
  dbUrl?: string;
  // Flat (legacy) endpoint fields
  gotrue_url?: string;
  gotrueUrl?: string;
  auth_url?: string;
  jwt_secret?: string;
  jwtSecret?: string;
  service_role_key?: string;
  anon_key?: string;
  postgrest_url?: string;
  postgrestUrl?: string;
  rest_url?: string;
  // Status (current) shape
  services?: {
    auth?: RawService | null;
    rest?: RawService | null;
    realtime?: RawService | null;
  };
  internal?: {
    dbUrl?: string;
    jwtSecret?: string;
    migrateToken?: string;
    [key: string]: unknown;
  };
  migrate_token?: string;
  [key: string]: unknown;
}

function toHauldrProject(raw: RawProject): HauldrProject {
  const s = raw.services ?? {};
  const internal = raw.internal ?? {};
  return {
    database: raw.database ?? raw.db ?? "",
    gotrueUrl:
      s.auth?.url ?? raw.gotrue_url ?? raw.gotrueUrl ?? raw.auth_url ?? "",
    jwtSecret:
      internal.jwtSecret ??
      raw.jwt_secret ??
      raw.jwtSecret ??
      raw.service_role_key ??
      raw.anon_key ??
      "",
    postgrestUrl:
      s.rest?.url ?? raw.postgrest_url ?? raw.postgrestUrl ?? raw.rest_url ?? "",
    dbUrl: internal.dbUrl ?? raw.db_url ?? raw.dbUrl ?? "",
    migrateToken: internal.migrateToken ?? raw.migrate_token ?? "",
  };
}

/** A project is usable once its auth + rest services report ready. */
function isReady(raw: RawProject): boolean {
  return Boolean(raw.services?.auth?.ready && raw.services?.rest?.ready);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Thin HTTP client for the Hauldr control-plane.
 *
 *  HAULDR_CONTROL_URL  — base URL, e.g. https://api.hauldr.io
 *  HAULDR_TOKEN        — Bearer token
 *
 *  Both methods are idempotent: ensureProject creates the project on first call
 *  and returns the existing one on subsequent calls.
 */
export class HauldrClient implements Hauldr {
  constructor(
    private readonly controlUrl: string,
    private readonly token: string,
  ) {}

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.controlUrl}${path}`;
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Hauldr ${method} ${path} → ${res.status} ${text}`.trim());
    }
    return (await res.json()) as T;
  }

  private getRaw(name: string): Promise<RawProject> {
    return this.req<RawProject>("GET", `/v1/projects/${encodeURIComponent(name)}`);
  }

  /** Fetch an existing Hauldr project by name. Throws on 404. */
  async getProject(name: string): Promise<HauldrProject> {
    return toHauldrProject(await this.getRaw(name));
  }

  /** Ensure the Hauldr project exists AND is ready, creating it if necessary.
   *
   *  Provisioning is asynchronous: POST returns `{status:"provisioning"}` with no
   *  endpoints, and the data plane (PostgREST) must be explicitly requested
   *  (`rest:true`). So: optimistic GET → create if 404 → poll until auth+rest are
   *  ready, then return the populated endpoints. Falls back to a best-effort
   *  result if readiness times out (the preview still boots, just degraded).
   */
  async ensureProject(name: string): Promise<HauldrProject> {
    const enc = encodeURIComponent(name);
    let raw: RawProject | null = null;
    let exists = false;
    try {
      raw = await this.getRaw(name);
      exists = true;
      if (isReady(raw)) return toHauldrProject(raw);
    } catch (err: unknown) {
      if (!(err instanceof Error && err.message.includes("404"))) throw err;
    }

    if (!exists) {
      // Fresh project: create with the PostgREST data plane requested. Clients
      // that only need auth simply ignore the rest endpoint.
      await this.req("POST", "/v1/projects", { name, rest: true });
    } else {
      // Project exists but its compute is down — the expected state after an
      // idle preview backend was deprovisioned (DB kept). Bring the missing
      // sidecars back up; both endpoints are idempotent server-side.
      if (!raw?.services?.auth?.ready) {
        await this.req("POST", `/v1/projects/${enc}/services/auth`).catch(() => {});
      }
      if (!raw?.services?.rest?.ready) {
        await this.req("POST", `/v1/projects/${enc}/services/rest`).catch(() => {});
      }
    }

    // Poll until ready (auth + rest), ~3 min budget.
    let last: RawProject | null = raw;
    for (let i = 0; i < 60; i++) {
      last = await this.getRaw(name).catch(() => null);
      if (last && isReady(last)) return toHauldrProject(last);
      await sleep(3000);
    }
    // Timed out — return whatever we have so the preview can still start.
    return toHauldrProject(last ?? { name });
  }

  /** Drop the project's compute sidecars (rest first to release its DB
   *  connections, then auth) while keeping the database. Idempotent: a missing
   *  service is a no-op. */
  async deprovisionCompute(name: string): Promise<void> {
    const enc = encodeURIComponent(name);
    await this.req("DELETE", `/v1/projects/${enc}/services/rest`).catch(() => {});
    await this.req("DELETE", `/v1/projects/${enc}/services/auth`).catch(() => {});
  }
}
