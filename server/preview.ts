import { createHmac } from "node:crypto";
import type { EnvironmentRecord } from "../shared/environment.ts";
import type { Config } from "./config.ts";
import { Problem } from "./store.ts";

type Status = { context: string; state: string; created_at: string };
type Repository = {
  full_name: string;
  archived: boolean;
  default_branch: string;
  id: number;
};
type Ref = { object: { sha: string } };
type Tree = { truncated: boolean; tree: { path: string }[] };
type Application = {
  name: string;
  uuid: string;
  description: string;
  git_repository: string;
  git_branch: string;
};
type DataProject = {
  status: string;
  services?: { auth?: { url?: string } };
  internal?: { jwtSecret?: string };
};
type Deployment = { deployment_uuid: string; status: string; commit: string };
const isDataReady = (data: DataProject) =>
  data.status === "ready" || data.status === "live";
type RawPullRequest = {
  number: number;
  html_url: string;
  title: string;
  head: { sha: string; repo?: { full_name: string } };
  base: { ref: string };
  state: string;
  draft: boolean;
};
export type PullRequest = {
  number: number;
  url: string;
  title: string;
  head: string;
  base: string;
  state: string;
  ciState: string;
  merged: boolean;
};
export interface PreviewProvider {
  prepare(
    env: EnvironmentRecord,
    save: (patch: Partial<EnvironmentRecord>) => Promise<EnvironmentRecord>,
  ): Promise<EnvironmentRecord>;
  inspect(env: EnvironmentRecord): Promise<Partial<EnvironmentRecord>>;
  deploy(env: EnvironmentRecord): Promise<string>;
  pullRequests(env: EnvironmentRecord): Promise<PullRequest[]>;
  merge(env: EnvironmentRecord, number: number, head: string): Promise<void>;
}
export const previewConfigured = (cfg: Config) => {
  const c = cfg.preview;
  return (
    [
      c.coolifyUrl,
      c.coolifyToken,
      c.project,
      c.server,
      c.githubApp,
      c.hauldrUrl,
      c.hauldrKey,
      c.githubToken,
      c.owner,
      c.template,
      c.domain,
      c.woodpeckerUrl,
      c.woodpeckerToken,
    ].every(Boolean) &&
    /^[a-zA-Z0-9-]+$/.test(c.owner) &&
    /^[a-z0-9.-]+$/.test(c.domain) &&
    Number.isInteger(c.maxProjects) &&
    c.maxProjects > 0 &&
    c.maxProjects <= 100
  );
};
export function environmentRecipe(
  cfg: Config,
  id: string,
  repository: string | null,
  input?: {
    slug: string;
    hostname?: string;
    productionUrl?: string;
    profile?: "static" | "application";
  },
) {
  const slug = input?.slug || `p-${id.slice(0, 8)}`;
  const reserved = [
    "brokk",
    "heimdall",
    "hauldr",
    "var",
    "logto",
    "coolify",
    "woodpecker",
    "bragi",
  ];
  if (!/^[a-z][a-z0-9-]{2,47}$/.test(slug) || reserved.includes(slug))
    throw new Problem(400, "Escolha uma identidade válida para este projeto.");
  const hostname = input?.hostname || `${slug}.${cfg.preview.domain}`;
  if (
    hostname !== `${slug}.${cfg.preview.domain}` &&
    (!cfg.preview.aliasDomain ||
      hostname !== `${slug}-preview.${cfg.preview.aliasDomain}`)
  )
    throw new Problem(
      400,
      "Use o endereço de preview permitido para este projeto.",
    );
  const repo = repository || `${cfg.preview.owner}/${slug}`;
  if (!new RegExp(`^${cfg.preview.owner}/[a-zA-Z0-9_.-]+$`).test(repo))
    throw new Problem(
      400,
      "O repositório precisa pertencer à organização autorizada.",
    );
  const productionUrl = input?.productionUrl || "";
  if (productionUrl) {
    const url = new URL(productionUrl);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      !cfg.preview.aliasDomain ||
      url.hostname !== `${slug}.${cfg.preview.aliasDomain}`
    )
      throw new Problem(400, "Use o endereço de produção deste projeto.");
  }
  return {
    slug,
    repository: repo,
    previewUrl: `https://${hostname}`,
    productionUrl,
    profile: input?.profile || "application",
  };
}
export function createPreviewProvider(cfg: Config): PreviewProvider {
  const c = cfg.preview;
  async function request<T = Record<string, unknown>>(
    base: string,
    key: string,
    path: string,
    method = "GET",
    body?: unknown,
    optional = false,
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetch(base + path, {
        method,
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
          "user-agent": "Brokk/2 (Cold Code Labs preview coordinator)",
          accept: "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(25000),
        redirect: "error",
      });
    } catch {
      throw new Problem(
        502,
        "O provedor não confirmou a ação. Verifique a preparação antes de repetir.",
      );
    }
    if (optional && response.status === 404) return null as T;
    if (!response.ok)
      throw new Problem(
        502,
        "O provedor recusou a ação. A administração precisa verificar a conexão.",
      );
    const raw = await response.text();
    return (raw ? JSON.parse(raw) : {}) as T;
  }
  const github = <T = Record<string, unknown>>(
    path: string,
    method = "GET",
    body?: unknown,
    optional = false,
  ) =>
    request<T>(
      "https://api.github.com",
      c.githubToken,
      path,
      method,
      body,
      optional,
    );
  const coolify = <T = Record<string, unknown>>(
    path: string,
    method = "GET",
    body?: unknown,
  ) => request<T>(c.coolifyUrl, c.coolifyToken, path, method, body);
  const hauldr = (
    path: string,
    method = "GET",
    body?: unknown,
    optional = false,
  ) =>
    request<DataProject>(
      c.hauldrUrl,
      c.hauldrKey,
      path,
      method,
      body,
      optional,
    );
  async function ci(repository: string, sha: string) {
    const result = await github<{ statuses: Status[] }>(
      `/repos/${repository}/commits/${sha}/status`,
    );
    const checks = (result.statuses || [])
      .filter((s) => s.context === "ci/woodpecker/push/woodpecker")
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    return checks[0]?.state || "pending";
  }
  const appMarker = (env: EnvironmentRecord) =>
    `Brokk project ${env.projectId} preview`;
  const appName = (env: EnvironmentRecord) => `${env.slug}-preview`;
  async function application(env: EnvironmentRecord) {
    const rows = await coolify<Application[]>("/applications");
    const matches = rows.filter((x) => x.name === appName(env));
    if (matches.length > 1)
      throw new Problem(
        409,
        "Há mais de uma aplicação com esta identidade. A administração precisa reconciliar.",
      );
    if (!matches.length) return null;
    const row = await coolify<Application>(`/applications/${matches[0].uuid}`);
    const repository = String(row.git_repository || "")
      .replace(/^https:\/\/github\.com\//, "")
      .replace(/\.git$/, "");
    if (
      row.description !== appMarker(env) ||
      repository !== env.repository ||
      row.git_branch !== "preview"
    )
      throw new Problem(409, "Este recurso não pertence à receita autorizada.");
    if (env.resources.application && env.resources.application !== row.uuid)
      throw new Problem(409, "A aplicação vinculada mudou.");
    return row;
  }
  return {
    async prepare(initial, save) {
      let env = initial;
      const persistedStep = initial.step;
      env = await save({
        step: "repository",
        detail: "Preparando o repositório e a branch de preview.",
      });
      let repo = await github<Repository>(
        `/repos/${env.repository}`,
        "GET",
        undefined,
        true,
      );
      if (!repo) {
        if (!env.resources.createRepository)
          throw new Problem(
            409,
            "O repositório autorizado não está acessível. A administração precisa verificar a conexão.",
          );
        if (persistedStep === "repository.creating") {
          await save({ step: persistedStep });
          throw new Problem(
            409,
            "A criação do repositório ainda não foi confirmada.",
          );
        }
        const tree = await github<Tree>(
          `/repos/${c.template}/git/trees/HEAD?recursive=1`,
        );
        if (
          tree.truncated ||
          tree.tree.some((x) => x.path.startsWith(".github/workflows/"))
        )
          throw new Problem(
            409,
            "A receita de repositório precisa usar somente Woodpecker.",
          );
        env = await save({ step: "repository.creating" });
        repo = await github<Repository>(
          `/repos/${c.template}/generate`,
          "POST",
          {
            owner: c.owner,
            name: env.repository.split("/")[1],
            private: true,
            description: appMarker(env),
          },
        );
        await github(`/repos/${env.repository}/actions/permissions`, "PUT", {
          enabled: false,
        });
        const pipeline =
          "when:\n  - event: [push, manual]\nsteps:\n  - name: check\n    image: node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43\n    commands:\n      - corepack enable\n      - corepack prepare pnpm@9.15.9 --activate\n      - pnpm install --frozen-lockfile\n      - pnpm build\n      - pnpm --if-present test\n";
        await github(
          `/repos/${env.repository}/contents/.woodpecker.yml`,
          "PUT",
          {
            message: "Configure self-hosted Woodpecker checks",
            content: Buffer.from(pipeline).toString("base64"),
          },
        );
      }
      if (repo.full_name !== env.repository || repo.archived)
        throw new Problem(
          409,
          "O repositório não está disponível para desenvolvimento.",
        );
      const registered = await request<{ active: boolean }>(
        c.woodpeckerUrl,
        c.woodpeckerToken,
        `/repos/lookup/${env.repository}`,
        "GET",
        undefined,
        true,
      );
      if (!registered?.active)
        await request(
          c.woodpeckerUrl,
          c.woodpeckerToken,
          `/repos?forge_remote_id=${repo.id}`,
          "POST",
        );
      const branch = await github<Ref>(
        `/repos/${env.repository}/git/ref/heads/preview`,
        "GET",
        undefined,
        true,
      );
      if (!branch) {
        const base = await github<Ref>(
          `/repos/${env.repository}/git/ref/heads/${encodeURIComponent(repo.default_branch)}`,
        );
        await github(`/repos/${env.repository}/git/refs`, "POST", {
          ref: "refs/heads/preview",
          sha: base.object.sha,
        });
      }
      const dataProject = `${env.slug.replaceAll("-", "_")}_dev`;
      env = await save({
        step: "data",
        detail: "Preparando o backend de desenvolvimento.",
      });
      let data = await hauldr(
        `/v1/projects/${dataProject}`,
        "GET",
        undefined,
        true,
      );
      if (!data) {
        if (persistedStep === "data.creating") {
          await save({ step: persistedStep });
          throw new Problem(
            409,
            "A criação do backend ainda não foi confirmada.",
          );
        }
        env = await save({ step: "data.creating" });
        data = await hauldr("/v1/projects", "POST", {
          name: dataProject,
          rest: true,
        });
      }
      env = await save({
        resources: { ...env.resources, dataProject },
        dataReady: isDataReady(data),
      });
      let app = await application(env);
      if (!app) {
        if (persistedStep === "application.creating") {
          await save({ step: persistedStep });
          throw new Problem(
            409,
            "A criação da aplicação ainda não foi confirmada.",
          );
        }
        env = await save({
          step: "application.creating",
          detail: "Preparando o endereço de preview.",
        });
        const port = "80";
        app = await coolify<Application>(
          "/applications/private-github-app",
          "POST",
          {
            project_uuid: c.project,
            server_uuid: c.server,
            environment_name: c.environment,
            github_app_uuid: c.githubApp,
            name: appName(env),
            description: appMarker(env),
            git_repository: env.repository,
            git_branch: "preview",
            build_pack: "dockerfile",
            dockerfile_location: "/Dockerfile",
            ports_exposes: port,
            domains: env.previewUrl.replace("https:", "http:"),
            instant_deploy: false,
          },
        );
        env = await save({
          resources: { ...env.resources, application: String(app.uuid) },
        });
      }
      env = await save({
        resources: { ...env.resources, application: String(app.uuid) },
      });
      await coolify(`/applications/${app.uuid}`, "PATCH", {
        description: appMarker(env),
        health_check_enabled: true,
        health_check_path: env.profile === "static" ? "/health" : "/api/health",
        health_check_port: "80",
        health_check_host: "127.0.0.1",
        health_check_scheme: "http",
        health_check_return_code: 200,
        limits_memory: "512M",
        limits_cpus: "1",
      });
      const vars: {
        key: string;
        value: string;
        is_buildtime: boolean;
        is_runtime: boolean;
        is_preview: boolean;
      }[] = [
        {
          key: "APP_ENV",
          value: "dev",
          is_buildtime: true,
          is_runtime: true,
          is_preview: false,
        },
      ];
      if (env.profile === "application" && isDataReady(data)) {
        const base = String(data.services?.auth?.url || "")
          .replace(/\/auth\/?$/, "")
          .replace(/^http:/, "https:");
        const secret = data.internal?.jwtSecret;
        if (!base || !secret)
          throw new Problem(
            409,
            "O backend não confirmou a configuração da aplicação.",
          );
        const header = Buffer.from(
          JSON.stringify({ alg: "HS256", typ: "JWT" }),
        ).toString("base64url");
        const now = Math.floor(Date.now() / 1000);
        const payload = Buffer.from(
          JSON.stringify({
            iss: "hauldr",
            role: "anon",
            iat: now,
            exp: now + 365 * 86400,
          }),
        ).toString("base64url");
        const signed = `${header}.${payload}`;
        const anon = `${signed}.${createHmac("sha256", secret).update(signed).digest("base64url")}`;
        for (const [key, value] of Object.entries({
          VITE_AUTH_MODE: "stub",
          VITE_APP_URL: env.previewUrl,
          VITE_HAULDR_URL: base,
          VITE_SUPABASE_URL: base,
          VITE_HAULDR_PROJECT_ID: dataProject,
          VITE_SUPABASE_PROJECT_ID: dataProject,
          VITE_HAULDR_PUBLISHABLE_KEY: anon,
          VITE_SUPABASE_ANON_KEY: anon,
        }))
          vars.push({
            key,
            value,
            is_buildtime: true,
            is_runtime: false,
            is_preview: false,
          });
      }
      await coolify(`/applications/${app.uuid}/envs/bulk`, "PATCH", {
        data: vars,
      });
      env = await save({
        state: "waiting",
        step:
          env.profile === "application" && !env.dataReady
            ? "data.waiting"
            : "prepared",
        detail:
          "Ambiente preparado. Aguardando código validado para publicar a preview.",
      });
      return env;
    },
    async inspect(env) {
      if (!env.resources.application) return {};
      const [app, data, branch] = await Promise.all([
        application(env),
        hauldr(`/v1/projects/${env.resources.dataProject}`),
        github<Ref>(`/repos/${env.repository}/git/ref/heads/preview`),
      ]);
      if (!app)
        throw new Problem(409, "A preview vinculada não foi encontrada.");
      const commit = String(branch.object.sha),
        ciState = await ci(env.repository, commit);
      const result: Partial<EnvironmentRecord> = {
        dataReady: isDataReady(data),
        ciState,
        commit,
      };
      if (env.resources.deployment) {
        const deployment = await coolify<Deployment>(
          `/deployments/${env.resources.deployment}`,
        );
        if (deployment.status === "failed" || deployment.status === "cancelled")
          return {
            ...result,
            state: "waiting",
            step: "deployment.failed",
            detail:
              "A publicação falhou. Confira o código e os checks antes de tentar novamente.",
          };
        if (
          deployment.status === "finished" &&
          deployment.commit === commit &&
          isDataReady(data)
        ) {
          try {
            const response = await fetch(
              env.previewUrl +
                (env.profile === "static" ? "/health" : "/api/health"),
              {
                signal: AbortSignal.timeout(7000),
                redirect: "error",
                headers: {
                  "user-agent":
                    "Mozilla/5.0 (compatible; ColdCodeLabs-Health/1.0)",
                },
              },
            );
            if (response.ok)
              return {
                ...result,
                state: "ready",
                step: "verified",
                detail: "Preview publicada e saudável.",
                deployedCommit: commit,
              };
          } catch {
            return {
              ...result,
              state: "waiting",
              detail:
                "Publicação concluída. Aguardando resposta saudável do endereço.",
            };
          }
        }
      }
      return result;
    },
    async deploy(env) {
      const app = await application(env);
      if (!app) throw new Problem(409, "Prepare o ambiente antes de publicar.");
      const branch = await github<Ref>(
        `/repos/${env.repository}/git/ref/heads/preview`,
      );
      if ((await ci(env.repository, branch.object.sha)) !== "success")
        throw new Problem(
          409,
          "O Woodpecker precisa aprovar o commit atual da preview.",
        );
      const data = await hauldr(`/v1/projects/${env.resources.dataProject}`);
      if (!isDataReady(data))
        throw new Problem(409, "O backend de dev ainda não está pronto.");
      const rows = await coolify<{ deployments: Deployment[] }>(
        `/deployments/applications/${app.uuid}?take=10`,
      );
      const previous = rows.deployments?.find(
        (d) =>
          d.commit === branch.object.sha &&
          ["queued", "in_progress", "finished"].includes(d.status),
      );
      if (previous) return String(previous.deployment_uuid);
      if (env.step === "deployment.unconfirmed")
        throw new Problem(
          409,
          "A publicação anterior ainda não foi confirmada.",
        );
      const result = await coolify<{ deployments: Deployment[] }>(
        `/deploy?uuid=${app.uuid}&force=false`,
      );
      const id = result.deployments?.[0]?.deployment_uuid;
      if (!id) throw new Problem(502, "A publicação não foi confirmada.");
      return String(id);
    },
    async pullRequests(env) {
      const rows = await github<RawPullRequest[]>(
        `/repos/${env.repository}/pulls?state=open&base=preview&per_page=30`,
      );
      return Promise.all(
        rows.map(async (r) => ({
          number: r.number,
          url: r.html_url,
          title: r.title,
          head: r.head.sha,
          base: r.base.ref,
          state: r.state,
          merged: false,
          ciState: await ci(env.repository, r.head.sha),
        })),
      );
    },
    async merge(env, number, head) {
      const pr = await github<RawPullRequest>(
        `/repos/${env.repository}/pulls/${number}`,
      );
      if (
        pr.base.ref !== "preview" ||
        pr.head.repo?.full_name !== env.repository ||
        pr.draft ||
        pr.head.sha !== head ||
        pr.state !== "open"
      )
        throw new Problem(
          409,
          "A entrega mudou ou não pertence à preview autorizada.",
        );
      if ((await ci(env.repository, head)) !== "success")
        throw new Problem(
          409,
          "O Woodpecker precisa aprovar esta revisão da entrega.",
        );
      const result = await github(
        `/repos/${env.repository}/pulls/${number}/merge`,
        "PUT",
        { sha: head, merge_method: "merge" },
      );
      if (!result.merged)
        throw new Problem(
          409,
          "A integração não foi confirmada. Atualize a entrega.",
        );
    },
  };
}
