import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * GitHub App auth for Eitri's own bot identity. We sign a short-lived JWT with
 * the App's private key, exchange it for an installation access token (valid 1h,
 * cached), and post reviews with it — so they appear as `Eitri[bot]` and can
 * Approve / Request changes. No user account to manage.
 */
export interface AppAuth {
  appId: string;
  privateKey: string;
  installationId?: string;
}

export function loadAppAuth(env = process.env): AppAuth | null {
  const appId = env.EITRI_APP_ID;
  const keyFile = env.EITRI_APP_PRIVATE_KEY_FILE;
  if (!appId || !keyFile) return null;
  return { appId, privateKey: readFileSync(keyFile, "utf8"), installationId: env.EITRI_APP_INSTALLATION_ID };
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

function mintJwt(auth: AppAuth): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: auth.appId }));
  const data = `${header}.${payload}`;
  const sig = createSign("RSA-SHA256").update(data).sign(auth.privateKey);
  return `${data}.${b64url(sig)}`;
}

async function ghApi<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "eitri",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(`GitHub ${path} → ${res.status} ${await res.text().catch(() => "")}`);
  return (await res.json()) as T;
}

// Tokens cached PER installation id (ADR 0064): review a private repo of org A
// with A's installation token, org B's with B's — not one fleet token for all.
const tokenCache = new Map<string, { token: string; exp: number }>();
let fleetInstallationId: string | null = null;

async function firstInstallationId(auth: AppAuth): Promise<string> {
  if (fleetInstallationId) return fleetInstallationId;
  const insts = await ghApi<{ id: number }[]>("/app/installations", mintJwt(auth));
  if (!insts.length) throw new Error("Eitri App has no installations — install it on the repo");
  fleetInstallationId = String(insts[0]!.id);
  return fleetInstallationId;
}

/** A fresh installation token (cached until ~5 min before expiry). Pass the repo's
 *  installation id to review with the ORG's own installation; omit for fleet default. */
export async function getInstallationToken(auth: AppAuth, installationId?: string): Promise<string> {
  const id = installationId ?? auth.installationId ?? (await firstInstallationId(auth));
  const hit = tokenCache.get(id);
  if (hit && hit.exp > Date.now() + 5 * 60_000) return hit.token;
  const r = await ghApi<{ token: string; expires_at: string }>(
    `/app/installations/${id}/access_tokens`,
    mintJwt(auth),
    { method: "POST" },
  );
  tokenCache.set(id, { token: r.token, exp: new Date(r.expires_at).getTime() });
  return r.token;
}

/** Resolve the installation id for a repo: its stored installationId, else the
 *  installation on the repo's GitHub owner (per-org), else undefined (fleet). */
export async function installationIdForRepo(
  store: {
    getRepositoryByFullName: (
      f: string,
    ) => Promise<{ installationId: string | null } | null>;
    getInstallationByAccount: (a: string) => Promise<{ installationId: string } | null>;
  },
  repo: string,
): Promise<string | undefined> {
  const row = await store.getRepositoryByFullName(repo).catch(() => null);
  if (row?.installationId) return row.installationId;
  const owner = repo.split("/")[0] ?? "";
  const inst = owner ? await store.getInstallationByAccount(owner).catch(() => null) : null;
  return inst?.installationId ?? undefined;
}
