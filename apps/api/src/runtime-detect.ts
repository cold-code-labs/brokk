/**
 * Detecção de runtime no control plane, sem checkout e sem LLM.
 *
 * O `fastPath` do Sleipnir (@brokk/core/runtime) só precisa de uma visão
 * READ-ONLY da árvore: lista de arquivos e o conteúdo de alguns manifestos. Isso
 * a API do GitHub entrega — então o Brokk decide como rodar um repositório
 * ANTES de existir qualquer máquina, o que resolve o ovo-e-galinha: sem runtime
 * não há bancada, e a bancada era o único lugar com checkout.
 *
 * Escopo honesto: isto resolve o caso canônico (Next, Vite, Astro… no root ou em
 * UM membro de workspace). Repositório fora do canônico continua `unsupported`,
 * com o motivo escrito — nunca um chute. A metade cara (o scout decidindo por
 * LLM) some junto com o Sindri; quando fizer falta, ela volta como uma tarefa
 * DENTRO da bancada, não como um daemon a mais.
 */

import type { DetectCtx, RuntimeSpec } from "@brokk/core";
import { buildDetectCtxFrom, fastPath, validateSpec } from "@brokk/core/runtime";

/** Manifestos que o resolver lê. Buscados sob demanda e memoizados: uma árvore
 *  de repositório grande não cabe em "leia tudo". */
const LAZY_LIMIT = 24;

export interface GithubReader {
  /** Caminhos do repositório, relativos à raiz (2 níveis bastam ao resolver). */
  tree(): Promise<string[]>;
  /** Conteúdo de um arquivo, ou null se não existir. */
  file(path: string): Promise<string | null>;
}

/** Leitor sobre a API do GitHub, autenticado com o token de instalação. */
export function githubReader(input: {
  token: string;
  repoFullName: string;
  ref: string;
}): GithubReader {
  const api = async <T>(path: string): Promise<T | null> => {
    const res = await fetch(`https://api.github.com${path}`, {
      headers: {
        Authorization: `Bearer ${input.token}`,
        Accept: "application/vnd.github+json",
      },
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  };

  return {
    async tree() {
      const t = await api<{ tree: { path: string; type: string }[]; truncated: boolean }>(
        `/repos/${input.repoFullName}/git/trees/${encodeURIComponent(input.ref)}?recursive=1`,
      );
      if (!t) return [];
      // O resolver olha 2 níveis; cortar aqui evita carregar a árvore inteira de
      // um monorepo só para descobrir que o app está em `apps/web`.
      return t.tree
        .filter((n) => n.type === "blob" && n.path.split("/").length <= 3)
        .map((n) => n.path);
    },
    async file(path) {
      const f = await api<{ content?: string; encoding?: string }>(
        `/repos/${input.repoFullName}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(input.ref)}`,
      );
      if (!f?.content) return null;
      return Buffer.from(f.content, f.encoding === "base64" ? "base64" : "utf8").toString("utf8");
    },
  };
}

/** Monta o `DetectCtx` puxando do GitHub o que o resolver pedir. As leituras são
 *  pré-carregadas (o contrato do `read` é síncrono) e limitadas — só manifestos,
 *  nunca código. */
export async function detectCtxFromGithub(reader: GithubReader): Promise<DetectCtx> {
  const files = await reader.tree();
  const manifests = files
    .filter((f) => /(^|\/)(package\.json|pnpm-workspace\.yaml|pnpm-lock\.yaml|yarn\.lock|package-lock\.json|bun\.lockb)$/.test(f))
    .slice(0, LAZY_LIMIT);
  const cache = new Map<string, string | null>();
  await Promise.all(
    manifests.map(async (path) => cache.set(path, await reader.file(path))),
  );
  return buildDetectCtxFrom({
    dir: ".",
    files,
    read: (rel) => cache.get(rel.replace(/^\.\//, "")) ?? null,
  });
}

/** Decide como rodar o repositório. Null = nada canônico foi reconhecido; quem
 *  chama transforma isso na recusa que o humano lê. */
export async function detectRuntime(reader: GithubReader): Promise<RuntimeSpec | null> {
  const ctx = await detectCtxFromGithub(reader);
  const spec = fastPath(ctx);
  if (!spec) return null;
  return validateSpec(spec, ctx);
}

/** Resolve e FIXA o runtime de um projeto. Idempotente: um projeto que já tem
 *  spec fixado é deixado em paz — a decisão é tomada uma vez e reusada, para que
 *  duas bancadas do mesmo projeto nunca subam com receitas diferentes. */
export async function resolveProjectRuntime(
  deps: {
    store: import("@brokk/db").Store;
    mintGitToken?: (repoFullName: string) => Promise<string | null>;
  },
  projectId: string,
): Promise<RuntimeSpec | null> {
  const project = await deps.store.getProject(projectId);
  if (!project) return null;
  if (project.runtime) return project.runtime as RuntimeSpec;
  const repo = await deps.store.getRepository(project.repositoryId);
  if (!repo) return null;
  const token = await deps.mintGitToken?.(repo.fullName);
  if (!token) return null;
  const spec = await detectRuntime(
    githubReader({ token, repoFullName: repo.fullName, ref: project.baseBranch || "main" }),
  );
  if (!spec) return null;
  await deps.store.setProjectRuntime(projectId, spec);
  console.log(`[runtime] ${project.name}: ${spec.id} (${spec.source})`);
  return spec;
}
