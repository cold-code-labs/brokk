// ─────────────────────────────────────────────────────────────────────────────
// Browser client for the read-only Studio (ADR 0012), through the same-origin
// /api proxy. Reads only: overview → tables → a page of rows. Provisioning and
// editing land in later phases.
// ─────────────────────────────────────────────────────────────────────────────

const BASE = (process.env.NEXT_PUBLIC_BROKK_API_URL || "/api") + "/studio";

export interface StudioOverview {
  connected: boolean;
  hauldrProject: string;
  database?: string;
  tableCount?: number;
  /** Why it's not connected: "studio-disabled" | "no-database" | "unreachable". */
  reason?: string;
  error?: string;
}

export interface StudioTable {
  name: string;
  rows: number;
}

export interface StudioColumn {
  name: string;
  type: string;
  nullable: boolean;
}

export interface StudioRows {
  table: string;
  columns: StudioColumn[];
  rows: Record<string, unknown>[];
  hasMore: boolean;
  limit: number;
  offset: number;
}

/** Build a concise message from a failed response. Drops HTML error pages
 *  (proxy/CDN 5xx during a redeploy) and truncates, so the panel never renders a
 *  raw error page — just a short, human line. */
async function failMessage(res: Response): Promise<string> {
  const body = (await res.text().catch(() => "")).trim();
  const looksHtml = /^<(?:!doctype|html)/i.test(body);
  let detail = "";
  if (body && !looksHtml) {
    try {
      detail = String((JSON.parse(body) as { error?: unknown }).error ?? body);
    } catch {
      detail = body;
    }
    detail = detail.slice(0, 200);
  } else if (res.status >= 502 && res.status <= 504) {
    detail = "serviço indisponível (talvez subindo)";
  }
  return `${res.status}${detail ? ` — ${detail}` : ""}`;
}

async function j<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(await failMessage(res));
  return (await res.json()) as T;
}

export const studio = {
  overview: (previewId: string) => j<StudioOverview>(`/${previewId}/overview`),
  tables: (previewId: string) =>
    j<{ tables: StudioTable[] }>(`/${previewId}/tables`).then((r) => r.tables),
  rows: (previewId: string, table: string, opts?: { limit?: number; offset?: number }) =>
    j<StudioRows>(
      `/${previewId}/tables/${encodeURIComponent(table)}?limit=${opts?.limit ?? 50}&offset=${opts?.offset ?? 0}`,
    ),
};
