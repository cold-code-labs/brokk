// ─────────────────────────────────────────────────────────────────────────────
// Browser client for the session file viewer. The routes live on the Sindri
// runtime (/sessions/:id/fs/*) and are reached through the same /api/chat/* proxy
// the chat uses — so the base is /chat, keyed by sessionId. List + read for
// viewing/download; write for drag-drop upload straight into the checkout.
// ─────────────────────────────────────────────────────────────────────────────

const BASE = (process.env.NEXT_PUBLIC_BROKK_API_URL || "/api") + "/chat";

export interface FsEntry {
  name: string;
  type: "dir" | "file";
  size: number;
}

export interface FsList {
  /** false when the session has no checkout yet (no turn/preview run). */
  ready: boolean;
  path: string;
  entries: FsEntry[];
}

export interface FsFile {
  path: string;
  size: number;
  binary: boolean;
  truncated: boolean;
  content: string;
}

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

const q = (s: string) => encodeURIComponent(s);

export const files = {
  list: (sessionId: string, path?: string) =>
    j<FsList>(`/sessions/${sessionId}/fs/list?path=${q(path ?? "")}`),
  read: (sessionId: string, path: string) =>
    j<FsFile>(`/sessions/${sessionId}/fs/read?path=${q(path)}`),
  /** Direct URL for downloading the raw file (streamed as an attachment). */
  downloadUrl: (sessionId: string, path: string) =>
    `${BASE}/sessions/${sessionId}/fs/read?path=${q(path)}&raw=1`,
  /** Upload raw bytes to `path` (relative to the checkout root). */
  upload: async (sessionId: string, path: string, data: Blob): Promise<{ size: number; path?: string }> => {
    const res = await fetch(`${BASE}/sessions/${sessionId}/fs/write?path=${q(path)}`, {
      method: "POST",
      body: data,
    });
    if (!res.ok) throw new Error(await failMessage(res));
    return (await res.json()) as { size: number; path?: string };
  },
};

/** Basename safe for `.brokk/inbox/<name>` (mirrors @brokk/chat safeInboxFilename). */
export function safeInboxFilename(name: string): string {
  const base = (name ?? "").split(/[/\\]/).pop() ?? "";
  const cleaned = base
    .replace(/[^\w.\-+() ]+/g, "_")
    .replace(/^\.+/, "")
    .trim();
  const out = cleaned || "file";
  return out.slice(0, 180);
}

/** Relative checkout path for a composer attachment. */
export function inboxRelPath(filename: string): string {
  return `.brokk/inbox/${safeInboxFilename(filename)}`;
}
