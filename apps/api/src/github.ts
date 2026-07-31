import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * GitHub App helper for the API (ADR 0064 · per-org GitHub). Unlike the forge's
 * single-installation minter, this keys installation tokens BY installation id so
 * each org's own installation is used for discovery + git ops. One app (Eitri),
 * many installations — the JWT is signed with the app private key; each
 * installation exchanges it for a scoped token (cached ~1h).
 */
export interface AppAuth {
  appId: string;
  privateKey: string;
}

export function loadAppAuth(env = process.env): AppAuth | null {
  // Prefer a DEDICATED public "Brokk connect" app (multi-tenant org installs);
  // fall back to the fleet's Eitri app so a single-app deploy still works. Keeping
  // them separable means the tenant-facing install app isn't the same one that
  // runs the fleet's own forge/reviewer.
  const appId = env.BROKK_GITHUB_APP_ID || env.EITRI_APP_ID;
  const keyFile = env.BROKK_GITHUB_APP_PRIVATE_KEY_FILE || env.EITRI_APP_PRIVATE_KEY_FILE;
  if (!appId || !keyFile) return null;
  try {
    return { appId, privateKey: readFileSync(keyFile, "utf8") };
  } catch {
    return null;
  }
}

export function githubAppReady(env = process.env): boolean {
  return loadAppAuth(env) !== null;
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
      "User-Agent": "brokk-api",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub ${path} → ${res.status} ${await res.text().catch(() => "")}`);
  }
  return (await res.json()) as T;
}

// Installation tokens cached per installation id (not module-global like the forge).
const tokenCache = new Map<string, { token: string; exp: number }>();

/** A fresh installation token for a specific installation (cached until ~5m pre-expiry). */
export async function getInstallationToken(auth: AppAuth, installationId: string): Promise<string> {
  const hit = tokenCache.get(installationId);
  if (hit && hit.exp > Date.now() + 5 * 60_000) return hit.token;
  const jwt = mintJwt(auth);
  const r = await ghApi<{ token: string; expires_at: string }>(
    `/app/installations/${installationId}/access_tokens`,
    jwt,
    { method: "POST" },
  );
  tokenCache.set(installationId, { token: r.token, exp: new Date(r.expires_at).getTime() });
  return r.token;
}

export interface InstallationInfo {
  id: string;
  accountLogin: string | null;
  accountType: string | null;
  suspended: boolean;
}

/** Read an installation's account (org/user) — used by the setup callback. */
export async function getInstallation(auth: AppAuth, installationId: string): Promise<InstallationInfo> {
  const jwt = mintJwt(auth);
  const r = await ghApi<{
    id: number;
    account: { login: string; type: string } | null;
    suspended_at: string | null;
  }>(`/app/installations/${installationId}`, jwt);
  return {
    id: String(r.id),
    accountLogin: r.account?.login ?? null,
    accountType: r.account?.type ?? null,
    suspended: Boolean(r.suspended_at),
  };
}

export interface InstallationRepo {
  fullName: string;
  owner: string;
  name: string;
  defaultBranch: string;
  description: string;
  isArchived: boolean;
  isPrivate: boolean;
}

/** Every repo the installation grants access to (paginated). This is the per-org
 *  authorized-repo surface — replaces the fleet `gh repo list`. */
export async function listInstallationRepositories(
  auth: AppAuth,
  installationId: string,
): Promise<InstallationRepo[]> {
  const token = await getInstallationToken(auth, installationId);
  const out: InstallationRepo[] = [];
  for (let page = 1; page <= 20; page++) {
    const r = await ghApi<{
      total_count: number;
      repositories: Array<{
        full_name: string;
        owner: { login: string };
        name: string;
        default_branch: string;
        description: string | null;
        archived: boolean;
        private: boolean;
      }>;
    }>(`/installation/repositories?per_page=100&page=${page}`, token);
    for (const repo of r.repositories) {
      out.push({
        fullName: repo.full_name,
        owner: repo.owner?.login ?? repo.full_name.split("/")[0]!,
        name: repo.name,
        defaultBranch: repo.default_branch || "main",
        description: repo.description ?? "",
        isArchived: repo.archived,
        isPrivate: repo.private,
      });
    }
    if (r.repositories.length < 100) break;
  }
  return out;
}

/** The app's slug + html_url — needed to build the install URL (github.com/apps/<slug>). */
export async function getAppMeta(auth: AppAuth): Promise<{ slug: string; htmlUrl: string }> {
  const jwt = mintJwt(auth);
  const r = await ghApi<{ slug: string; html_url: string }>("/app", jwt);
  return { slug: r.slug, htmlUrl: r.html_url };
}
