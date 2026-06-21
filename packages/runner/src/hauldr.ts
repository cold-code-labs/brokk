/**
 * HauldrClient — HTTP client for the Hauldr control-plane.
 *
 * Implements the {@link Hauldr} port declared in `@brokk/core` so the preview
 * supervisor can provision and look up dev-preview Supabase-compatible projects
 * via GET/POST /v1/projects against HAULDR_CONTROL_URL.
 */
import type { Hauldr, HauldrProject } from "@brokk/core";

/** Wire format of GET/POST /v1/projects from the Hauldr control-plane.
 *  Field names may be snake_case or camelCase depending on the version. */
interface RawProject {
  name?: string;
  // Connection DB string
  database?: string;
  db?: string;
  db_url?: string;
  dbUrl?: string;
  // Auth (GoTrue / Supabase Auth)
  gotrue_url?: string;
  gotrueUrl?: string;
  auth_url?: string;
  // JWT / service-role key
  jwt_secret?: string;
  jwtSecret?: string;
  service_role_key?: string;
  anon_key?: string;
  // PostgREST
  postgrest_url?: string;
  postgrestUrl?: string;
  rest_url?: string;
  [key: string]: unknown;
}

function toHauldrProject(raw: RawProject): HauldrProject {
  return {
    database: raw.database ?? raw.db ?? "",
    gotrueUrl: raw.gotrue_url ?? raw.gotrueUrl ?? raw.auth_url ?? "",
    jwtSecret:
      raw.jwt_secret ?? raw.jwtSecret ?? raw.service_role_key ?? raw.anon_key ?? "",
    postgrestUrl: raw.postgrest_url ?? raw.postgrestUrl ?? raw.rest_url ?? "",
    dbUrl: raw.db_url ?? raw.dbUrl ?? "",
  };
}

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

  /** Fetch an existing Hauldr project by name. Throws on 404. */
  async getProject(name: string): Promise<HauldrProject> {
    const raw = await this.req<RawProject>(
      "GET",
      `/v1/projects/${encodeURIComponent(name)}`,
    );
    return toHauldrProject(raw);
  }

  /** Ensure the Hauldr project exists, creating it if necessary.
   *
   *  Flow: optimistic GET → if 404, POST to create → return result.
   *  Hauldr treats POST as idempotent on name conflicts (returns the existing
   *  project), so this is safe under concurrent calls.
   */
  async ensureProject(name: string): Promise<HauldrProject> {
    try {
      return await this.getProject(name);
    } catch (err: unknown) {
      // Only swallow 404; re-throw anything else
      if (!(err instanceof Error && err.message.includes("404"))) throw err;
    }
    const raw = await this.req<RawProject>("POST", "/v1/projects", { name });
    return toHauldrProject(raw);
  }
}
