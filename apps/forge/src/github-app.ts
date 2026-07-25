import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * GitHub App auth for the forge's git operations (clone/fetch/push). We sign a
 * short-lived JWT with the Eitri App's private key and exchange it for an
 * installation access token (valid 1h, cached), used as GH_TOKEN so the
 * `gh auth git-credential` helper authenticates git over HTTPS. Durable by
 * design: the App private key doesn't expire like a classic PAT, so a stale PAT
 * never strands the forge again (the reason Wave 3 wired this in). Mirrors
 * apps/reviewer/src/github-app.ts — the reviewer already mints tokens this way.
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
  try {
    return { appId, privateKey: readFileSync(keyFile, "utf8"), installationId: env.EITRI_APP_INSTALLATION_ID };
  } catch {
    return null; // PEM unreadable → caller falls back to the ambient token
  }
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
      "User-Agent": "brokk-forge",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(`GitHub ${path} → ${res.status} ${await res.text().catch(() => "")}`);
  return (await res.json()) as T;
}

let cache: { token: string; exp: number } | null = null;

/** A fresh installation token (cached until ~5 min before expiry). */
export async function getInstallationToken(auth: AppAuth): Promise<string> {
  if (cache && cache.exp > Date.now() + 5 * 60_000) return cache.token;
  const jwt = mintJwt(auth);
  let installationId = auth.installationId;
  if (!installationId) {
    const insts = await ghApi<{ id: number }[]>("/app/installations", jwt);
    if (!insts.length) throw new Error("Eitri App has no installations — install it on the repo");
    installationId = String(insts[0]!.id);
  }
  const r = await ghApi<{ token: string; expires_at: string }>(
    `/app/installations/${installationId}/access_tokens`,
    jwt,
    { method: "POST" },
  );
  cache = { token: r.token, exp: new Date(r.expires_at).getTime() };
  return r.token;
}
