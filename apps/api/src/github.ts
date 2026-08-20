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
  // runs the fleet's own reviewer.
  const appId = env.BROKK_GITHUB_APP_ID || env.EITRI_APP_ID;
  if (!appId) return null;

  // A chave pode vir INLINE ou por arquivo. O inline existe porque a API passou a
  // ser quem assina (abre PR, entrega credencial à bancada) e ela roda num app do
  // Coolify diferente do que tinha o volume com o .pem — exigir arquivo ali
  // significaria semear um volume à mão, que é como um segredo vira folclore.
  // `\n` escapado é aceito: é assim que uma chave PEM sobrevive a um campo de env.
  const inline = env.BROKK_GITHUB_APP_PRIVATE_KEY || env.EITRI_APP_PRIVATE_KEY;
  if (inline?.includes("PRIVATE KEY")) {
    return { appId, privateKey: inline.replace(/\\n/g, "\n") };
  }

  const keyFile = env.BROKK_GITHUB_APP_PRIVATE_KEY_FILE || env.EITRI_APP_PRIVATE_KEY_FILE;
  if (!keyFile) return null;
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

/** Find the installation that covers a repo's OWNER.
 *
 *  Existe porque a frota tem repositórios conectados ANTES de a coluna
 *  `installation_id` existir (ADR 0064): a linha vem nula e qualquer coisa que
 *  dependa dela — abrir PR, entregar credencial para a bancada — morre com um
 *  503 que parece "GitHub App não configurado" e não é. O forge escondia isso
 *  caindo num `insts[0]` global, que é justamente o que a threading por-org
 *  removeu. Aqui a busca é explícita e por dono. */
export async function findInstallationForOwner(
  auth: AppAuth,
  owner: string,
): Promise<string | null> {
  const jwt = mintJwt(auth);
  const list = await ghApi<{ id: number; account: { login: string } | null }[]>(
    "/app/installations",
    jwt,
  );
  const want = owner.toLowerCase();
  const hit = list.find((i) => (i.account?.login ?? "").toLowerCase() === want);
  return hit ? String(hit.id) : null;
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

/** Open a pull request with an installation token.
 *
 *  Returns the PR URL, or null when GitHub refuses because there is nothing to
 *  compare (the agent signed off without pushing anything) — that is a normal
 *  outcome of an honest "I couldn't do it", not an error to throw at the driver.
 */
export async function openPullRequest(
  token: string,
  input: { repoFullName: string; head: string; base: string; title: string; body: string },
): Promise<string | null> {
  const res = await fetch(`https://api.github.com/repos/${input.repoFullName}/pulls`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      title: input.title,
      head: input.head,
      base: input.base,
      body: input.body,
    }),
  });
  if (res.status === 422) return null; // no commits between base and head, or PR exists
  if (!res.ok) throw new Error(`github pulls → ${res.status}`);
  const pr = (await res.json()) as { html_url: string };
  return pr.html_url;
}
