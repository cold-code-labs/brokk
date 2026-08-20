/**
 * Bancadas — the control plane's half of ADR 0100.
 *
 * Brokk decides and records; Coder runs. This module owns the decision: which
 * repo, which branch, which runtime recipe, which dev-lane backend, and who is
 * allowed to touch the result. It never runs a dev server, never holds a
 * checkout and never keeps a long-lived git credential anywhere near the code
 * being edited — the workspace *brokers* one, per push, through `gitCredential`.
 *
 * The row in `bancadas` is a handle, not a truth: whether a workspace is up is
 * always re-read from Coder (`refresh`).
 */

import { createHash, randomBytes } from "node:crypto";
import type { Bancada, BancadaStatus, RuntimeSpec } from "@brokk/core";
import type { Store } from "@brokk/db";
import {
  AGENT_APP_SLUG,
  CoderClient,
  PREVIEW_APP_SLUG,
  UnrunnableProject,
  bancadaParameters,
  workspaceName,
} from "@brokk/coder";
import type { CoderWorkspace } from "@brokk/coder";
import type { DataProvider } from "./lanes/data-provider.js";

/** Refused for a reason the caller can show a human — a 4xx, not a 500. */
export class BancadaRefused extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 | 422 | 503 = 422,
  ) {
    super(message);
    this.name = "BancadaRefused";
  }
}

export interface BancadaDeps {
  store: Store;
  coder: CoderClient;
  /** Provisions the dev-lane backend and returns the env the app boots with. */
  data: DataProvider;
  /** Name of the Coder template bancadas are cut from. */
  template: string;
  /** URL the *workspace* reaches Brokk on, to broker git credentials. Internal
   *  (service name on the shared docker network) — never the public host. */
  controlUrl: string;
  /** Mint a short-lived GitHub token for a repo. Null = no GitHub App wired,
   *  in which case a bancada can boot read-only from a public repo but cannot
   *  push. */
  mintGitToken?: (repoFullName: string) => Promise<string | null>;
  /** Janela de ociosidade do reaper, em ms. Usada só para derivar o TTL de
   *  segurança do lado do Coder. */
  idleMs?: number;
  /** Decide (and pin) how a project runs, when it has no runtime yet. Reads the
   *  repo's manifests off GitHub — no checkout, no LLM. Absent = a project with
   *  no pinned runtime is simply refused. */
  resolveRuntime?: (projectId: string) => Promise<RuntimeSpec | null>;
}

/** Hauldr project names allow only [a-z0-9_] and must start with a letter. Same
 *  rule the preview lane has always used — a bancada shares the `<app>_dev`
 *  backend with it on purpose, so the two never disagree about dev data. */
function hauldrLane(repoName: string, branch: string, baseBranch: string): string {
  const slug = branch.replace(/[^a-z0-9]+/gi, "-").replace(/(^-|-$)/g, "").toLowerCase() || "dev";
  const isDev = slug === "dev" || branch === baseBranch;
  return (isDev ? `${repoName}_dev` : `${repoName}_${slug}`).toLowerCase().replace(/[^a-z0-9_]/g, "_");
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export class BancadaService {
  constructor(private readonly deps: BancadaDeps) {}

  /** Open (or adopt) the bancada of a project's lane.
   *
   *  Idempotent by design: called by a human opening the screen and by the
   *  driver claiming a card, possibly at the same moment. Coder is asked what
   *  actually exists before anything is created — a row without a workspace is
   *  a common state (a failed provision leaves one), and re-creating over a
   *  live workspace would fork the same branch into two dev servers.
   */
  async ensure(
    projectId: string,
    opts?: { lane?: string; branch?: string; restart?: boolean },
  ): Promise<Bancada> {
    const project = await this.deps.store.getProject(projectId);
    if (!project) throw new BancadaRefused("project not found", 404);
    const repo = await this.deps.store.getRepository(project.repositoryId);
    if (!repo) throw new BancadaRefused("repository not found", 404);

    const lane = (opts?.lane ?? "dev").trim() || "dev";
    const branch = (opts?.branch ?? project.baseBranch ?? "dev").trim();
    // Um projeto sem runtime fixado não é uma recusa definitiva: descobrir como
    // ele roda custa duas leituras na API do GitHub. Só 10 dos 55 projetos da
    // frota tinham runtime quando isto foi escrito — recusar todos os outros
    // seria transformar uma decisão barata em trabalho manual.
    const runtime =
      (project.runtime as RuntimeSpec | null) ?? (await this.deps.resolveRuntime?.(projectId)) ?? null;
    if (!runtime?.dev) {
      throw new BancadaRefused(
        "não consegui descobrir como rodar este projeto (nada canônico nos manifestos) — " +
          "a bancada não adivinha o comando de dev",
      );
    }

    const name = workspaceName(project.name, lane);
    const { bancada } = await this.deps.store.ensureBancada({
      projectId,
      lane,
      branch,
      workspaceName: name,
      runtimeId: runtime.id,
    });

    // Coder is the authority on what exists.
    const existing = await this.deps.coder.workspaceByName(name);
    const buildStatus = existing?.latest_build.status;
    const alive = existing && (buildStatus === "running" || buildStatus === "starting" || buildStatus === "pending");
    if (alive && !opts?.restart) {
      return this.refresh(await this.deps.store.patchBancada(bancada.id, {
        workspaceId: existing.id,
        ownerName: existing.owner_name,
        branch,
      }));
    }

    // Everything below provisions, which means minting fresh material.
    const secret = randomBytes(32).toString("base64url");
    const lanes = hauldrLane(repo.name, branch, project.baseBranch ?? "dev");
    const env = await this.laneEnv(lanes);
    const gitToken = (await this.deps.mintGitToken?.(repo.fullName)) ?? "";

    let parameters;
    try {
      parameters = bancadaParameters({
        repo: repo.fullName,
        branch,
        runtime,
        env,
      });
    } catch (err) {
      if (err instanceof UnrunnableProject) throw new BancadaRefused(err.message);
      throw err;
    }
    parameters.push(
      { name: "brokk_url", value: this.deps.controlUrl },
      { name: "bancada_token", value: secret },
      { name: "git_token", value: gitToken },
    );

    await this.deps.store.patchBancada(bancada.id, {
      status: "provisioning",
      detail: null,
      tokenHash: sha256(secret),
      hauldrProject: lanes,
      branch,
      runtimeId: runtime.id,
    });

    const template = await this.deps.coder.templateByName(this.deps.template);
    if (!template) {
      throw new BancadaRefused(`template '${this.deps.template}' não existe no Coder`, 503);
    }

    let ws: CoderWorkspace;
    if (!existing) {
      ws = await this.deps.coder.createWorkspace({
        name,
        templateId: template.id,
        parameters,
        // Rede de segurança do lado do Coder: se o Brokk cair, o reaper cai
        // junto — e sem isto a bancada ficaria de pé indefinidamente. Folga
        // sobre o TTL do reaper, que é quem deve desligar no caso normal.
        ttlMs: this.deps.idleMs ? this.deps.idleMs * 4 : undefined,
      });
    } else {
      // A stopped/failed workspace is restarted with the CURRENT recipe — that
      // is how a changed dev command or a rotated key reaches a bancada without
      // destroying its disk.
      //
      // ⚠️ O Coder recusa uma build enquanto a anterior está em voo (409). Parar
      // e mandar subir na sequência parece certo e não é: o `stop` ainda está
      // rodando quando o `start` chega, e a bancada morre com um 500 sem
      // explicação — medido em 20/08/2026, no primeiro `restart` de verdade.
      if (alive) {
        await this.deps.coder.build(existing.id, "stop");
        await this.deps.coder.waitForBuild(existing.id, { timeoutMs: 3 * 60_000 });
      }
      await this.deps.coder.build(existing.id, "start", {
        parameters,
        templateVersionId: template.active_version_id,
      });
      ws = existing;
    }

    return this.refresh(
      await this.deps.store.patchBancada(bancada.id, {
        workspaceId: ws.id,
        ownerName: ws.owner_name,
        status: "provisioning",
      }),
    );
  }

  /** Re-read Coder and reconcile the row to what is actually running. The only
   *  place a bancada's status is written from observation. */
  async refresh(bancada: Bancada): Promise<Bancada> {
    if (!bancada.workspaceId) return bancada;
    const ws = await this.deps.coder.workspace(bancada.workspaceId);
    if (!ws) {
      return this.deps.store.patchBancada(bancada.id, {
        status: "failed",
        detail: "workspace não existe mais no Coder",
        workspaceId: null,
        previewUrl: null,
        agentUrl: null,
      });
    }

    const agent = CoderClient.agentOf(ws);
    const preview = CoderClient.appOf(ws, PREVIEW_APP_SLUG);
    const build = ws.latest_build.status;
    let status: BancadaStatus = "provisioning";
    let detail: string | null = null;

    if (build === "failed") {
      status = "failed";
      detail = ws.latest_build.job.error ?? "build falhou";
    } else if (build === "stopped" || build === "canceled") {
      status = "stopped";
    } else if (build === "deleted" || build === "deleting") {
      status = "deleting";
    } else if (agent?.lifecycle_state === "ready") {
      status = "ready";
    } else if (agent?.lifecycle_state === "start_error" || agent?.lifecycle_state === "start_timeout") {
      status = "failed";
      // The startup script's own failure line is inside the workspace; what the
      // control plane can honestly report is that it failed and where to look.
      detail = agent.health?.reason ?? "o startup da bancada falhou (veja o log do workspace)";
    }

    // ⚠️ Cinto além do suspensório: `ready` do agente só vale como "serve" com
    // o startup em modo blocking. Se um dia alguém voltar para non-blocking, o
    // healthcheck do próprio dev server segura a mentira aqui.
    if (status === "ready" && preview && preview.health === "initializing") {
      status = "provisioning";
    }

    return this.deps.store.patchBancada(bancada.id, {
      status,
      detail,
      ownerName: ws.owner_name,
      previewUrl: preview ? this.deps.coder.appUrl(ws, PREVIEW_APP_SLUG) : null,
      agentUrl: CoderClient.appOf(ws, AGENT_APP_SLUG)
        ? this.deps.coder.appUrl(ws, AGENT_APP_SLUG)
        : null,
    });
  }

  /** Stop the workspace but keep the disk (and the row). Restarting is cheap;
   *  re-cloning is not. */
  async stop(bancada: Bancada): Promise<Bancada> {
    if (bancada.workspaceId) await this.deps.coder.build(bancada.workspaceId, "stop");
    return this.deps.store.patchBancada(bancada.id, { status: "stopped" });
  }

  /** Destroy the workspace and forget it. The next `ensure` rebuilds from git —
   *  which is exactly why a bancada is allowed to be disposable. */
  async remove(bancada: Bancada): Promise<void> {
    if (bancada.workspaceId) {
      await this.deps.coder
        .deleteWorkspace(bancada.workspaceId)
        .catch(() => {
          /* already gone; the row must still go */
        });
    }
    await this.deps.store.deleteBancada(bancada.id);
  }

  // ── the agent inside ────────────────────────────────────────────────────────

  private async workspaceOf(bancada: Bancada): Promise<CoderWorkspace> {
    if (!bancada.workspaceId) throw new BancadaRefused("bancada não provisionada", 409);
    const ws = await this.deps.coder.workspace(bancada.workspaceId);
    if (!ws) throw new BancadaRefused("workspace não existe mais no Coder", 409);
    return ws;
  }

  async agentStatus(bancada: Bancada) {
    return this.deps.coder.agentStatus(await this.workspaceOf(bancada));
  }

  async agentMessages(bancada: Bancada) {
    return this.deps.coder.agentMessages(await this.workspaceOf(bancada));
  }

  /** Send a turn. Bumps activity so the idle reaper doesn't stop a bancada
   *  someone is actively talking to.
   *
   *  Se o CLI estiver parado numa tela de confirmação, a AgentAPI recusa com
   *  "failed to wait for screen to stabilize" — e reporta `stable` ao mesmo
   *  tempo, então não dá para saber antes de tentar. Nesse caso a gente aperta
   *  Enter e tenta UMA vez. Uma, não em laço: se a tela não é essa, insistir só
   *  digita lixo no terminal do agente. */
  async agentSend(bancada: Bancada, content: string): Promise<{ ok: boolean; reason?: string }> {
    const ws = await this.workspaceOf(bancada);
    let res = await this.deps.coder.agentSend(ws, content);
    if (!res.ok && /stabilize/i.test(res.reason ?? "")) {
      // ⚠️ NUNCA mandar Enter às cegas aqui. A tela em que o CLI trava é um menu
      // cuja opção destacada é "1. No, exit" — um Enter cego MATA o agente. Só
      // respondemos a uma tela que reconhecemos, e respondemos o que ela pede.
      const ultima = (await this.deps.coder.agentMessages(ws)).at(-1)?.content ?? "";
      if (/Yes, I accept/i.test(ultima)) {
        console.warn(`[bancada] ${bancada.workspaceName}: aviso de bypass na tela — aceitando`);
        await this.deps.coder.agentKey(ws, "2");
        await this.deps.coder.agentKey(ws, "\r");
        res = await this.deps.coder.agentSend(ws, content);
      } else {
        console.warn(
          `[bancada] ${bancada.workspaceName}: agente parado numa tela que não reconheço — ` +
            `não vou digitar no escuro. Últimos 120 chars: ${ultima.slice(-120)}`,
        );
      }
    }
    if (res.ok) await this.deps.store.touchBancada(bancada.id);
    return res;
  }

  // ── git, brokered ───────────────────────────────────────────────────────────

  /**
   * Hand a workspace a git credential, once, for the repo it was cut from.
   *
   * The workspace presents its own secret (issued at build time, never
   * persisted by us in the clear); we answer with a short-lived GitHub App
   * installation token. Nothing durable is ever written into the container, so
   * a bancada that outlives its token simply asks again — and a bancada that is
   * deleted takes its ability to push with it.
   */
  async gitCredential(secret: string): Promise<{ username: string; password: string; repo: string }> {
    const hash = sha256(secret);
    // The lookup IS the check: only a caller holding the plaintext can produce
    // the hash, and the column stores nothing else. There is no partial match to
    // time — a wrong secret is simply a miss.
    const bancada = await this.deps.store.getBancadaByTokenHash(hash);
    if (!bancada) throw new BancadaRefused("credencial desconhecida", 404);
    const project = await this.deps.store.getProject(bancada.projectId);
    const repo = project ? await this.deps.store.getRepository(project.repositoryId) : null;
    if (!repo) throw new BancadaRefused("repositório não encontrado", 404);
    const token = await this.deps.mintGitToken?.(repo.fullName);
    if (!token) throw new BancadaRefused("GitHub App não configurado", 503);
    await this.deps.store.touchBancada(bancada.id);
    return { username: "x-access-token", password: token, repo: repo.fullName };
  }

  // ── dev-lane backend ────────────────────────────────────────────────────────

  /** Env of the dev BaaS lane. A provider failure is NOT fatal: plenty of apps
   *  have no backend, and a bancada that boots without one is still worth more
   *  than a refusal. */
  private async laneEnv(lane: string): Promise<Record<string, string>> {
    try {
      const { env } = await this.deps.data.ensureEnv(lane);
      return env;
    } catch (err) {
      console.warn(`[bancada] lane ${lane} indisponível:`, err instanceof Error ? err.message : err);
      return {};
    }
  }
}
