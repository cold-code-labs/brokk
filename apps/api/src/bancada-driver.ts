/**
 * O motor de cards, agora dentro da bancada (ADR 0100).
 *
 * Isto substitui o `apps/forge`: em vez de o Brokk manter worktree, rodar o
 * agente no próprio processo e supervisionar o build, ele **entrega o card ao
 * agente que já vive na bancada** e observa. O trabalho acontece onde o dev
 * server está rodando — a mesma máquina que o navegador verifica.
 *
 * O ciclo, por card:
 *
 *   queued → garante a bancada → manda o briefing ao agente → observa →
 *   o agente empurra a branch e assina `BROKK-DONE <branch>` → abre o PR →
 *   review
 *
 * Por que um sentinela e não "o agente parou de falar": um agente ocioso e um
 * agente que terminou são o mesmo `stable` na API. O sentinela é a única
 * afirmação explícita de conclusão que temos — e se ele não vier dentro do
 * teto, o card falha DIZENDO isso, em vez de ficar preso em `running` para
 * sempre (que era exatamente o estado em que a esteira antiga apodrecia).
 */

import type { Task } from "@brokk/core";
import type { Store } from "@brokk/db";
import type { BancadaService } from "./bancada.js";

/** O agente assina a conclusão com esta linha. Reconhecida em qualquer lugar da
 *  resposta — pedir "responda APENAS isto" é como se perde o relatório. */
const DONE = /BROKK-DONE\s+(\S+)/;

export interface BancadaDriverDeps {
  store: Store;
  bancadas: BancadaService;
  /** Abre o PR da branch que o agente empurrou. Null = sem GitHub App: o driver
   *  ainda leva o card até o push, e para em `review` sem PR. */
  openPr?: (input: {
    repoFullName: string;
    head: string;
    base: string;
    title: string;
    body: string;
  }) => Promise<string | null>;
  /** Teto de tempo para um card. Estourou = falha explicada. */
  timeoutMs?: number;
  intervalMs?: number;
}

/** O briefing que vai ao agente. Tudo que ele precisa saber, incluindo COMO
 *  dizer que terminou — o contrato de conclusão é parte do pedido, não um
 *  detalhe de implementação nosso. */
export function briefing(task: Task, branch: string, base: string): string {
  const linhas = [
    `Card do Brokk: ${task.title}`,
    "",
    task.body?.trim() || "(sem descrição)",
  ];
  if (task.acceptance?.trim()) {
    linhas.push("", `Critério de aceite: ${task.acceptance.trim()}`);
  }
  linhas.push(
    "",
    "Como trabalhar aqui:",
    `- Você está na bancada deste projeto, com o dev server rodando. Verifique no navegador o que mudar.`,
    `- Trabalhe na branch \`${branch}\` (crie a partir de \`${base}\`).`,
    "- Commit e push quando terminar. A credencial de git é brokerada: só use `git push`, não configure token.",
    `- Ao terminar, responda com a linha: BROKK-DONE ${branch}`,
    "- Se não for possível concluir, explique o motivo e NÃO escreva a linha acima.",
  );
  return linhas.join("\n");
}

/** Branch de trabalho do card. Estável (deriva do id) para que uma retomada
 *  encontre o que já foi empurrado. */
export function cardBranch(task: Task): string {
  const slug = task.title
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `brokk/${slug || "card"}-${task.id.slice(0, 8)}`;
}

export function startBancadaDriver(deps: BancadaDriverDeps): { stop: () => void } {
  const interval = deps.intervalMs ?? 20_000;
  const timeoutMs = deps.timeoutMs ?? 60 * 60_000;

  const tick = async () => {
    // 1. Cards esperando: entra um por projeto por vez (a bancada é uma máquina
    //    só; dois cards no mesmo checkout brigam pelo mesmo push).
    const queued = await deps.store.listTasks({ status: "queued" });
    for (const task of queued) {
      if (task.owner === "human") continue;
      try {
        await dispatch(deps, task);
      } catch (err) {
        console.warn(`[driver] card ${task.id}:`, err instanceof Error ? err.message : err);
      }
    }

    // 2. Cards em voo: o agente já recebeu o briefing.
    const running = await deps.store.listTasks({ status: "running" });
    for (const task of running) {
      try {
        await observe(deps, task, timeoutMs);
      } catch (err) {
        console.warn(`[driver] observando ${task.id}:`, err instanceof Error ? err.message : err);
      }
    }
  };

  const timer = setInterval(() => void tick().catch(() => {}), interval);
  timer.unref?.();
  void tick().catch(() => {});
  return { stop: () => clearInterval(timer) };
}

async function dispatch(deps: BancadaDriverDeps, task: Task): Promise<void> {
  const project = await deps.store.getProject(task.projectId);
  if (!project) return;

  // Uma bancada por projeto está trabalhando por vez.
  const inFlight = await deps.store.listTasks({ projectId: task.projectId, status: "running" });
  if (inFlight.length > 0) return;

  const bancada = await deps.bancadas.ensure(task.projectId);
  if (bancada.status !== "ready") return; // ainda subindo — tenta no próximo tick

  const base = task.baseBranch || project.baseBranch || "dev";
  const branch = cardBranch(task);
  const ok = await deps.bancadas.agentSend(bancada, briefing(task, branch, base));
  if (!ok) return;

  const run = await deps.store.insertRun({
    taskId: task.id,
    status: "running",
    branch,
    startedAt: new Date(),
    model: project.model,
  });
  await deps.store.transitionTask(task.id, "running", {
    actor: "bancada-driver",
    reason: `briefing entregue ao agente da bancada ${bancada.workspaceName}`,
    extra: { branch },
  });
  console.log(`[driver] ${task.id} → ${bancada.workspaceName} (run ${run.id}, branch ${branch})`);
}

async function observe(deps: BancadaDriverDeps, task: Task, timeoutMs: number): Promise<void> {
  const bancada = await deps.store.getBancadaByLane(task.projectId, "dev");
  if (!bancada) return;

  const runs = await deps.store.listRunsByTask(task.id);
  const run = runs[0];
  const started = run?.startedAt ? new Date(run.startedAt).getTime() : Date.now();

  const messages = await deps.bancadas.agentMessages(bancada).catch(() => []);
  const done = [...messages].reverse().find((m) => m.role === "agent" && DONE.test(m.content));

  if (!done) {
    if (Date.now() - started > timeoutMs) {
      await fail(deps, task, run?.id, "o agente não sinalizou conclusão dentro do teto de tempo");
    }
    return;
  }

  const branch = DONE.exec(done.content)![1]!;
  const project = await deps.store.getProject(task.projectId);
  const repo = project ? await deps.store.getRepository(project.repositoryId) : null;
  const base = task.baseBranch || project?.baseBranch || "dev";

  let prUrl: string | null = null;
  if (repo && deps.openPr) {
    prUrl = await deps.openPr({
      repoFullName: repo.fullName,
      head: branch,
      base,
      title: task.title,
      // O corpo carrega a origem para o Eitri e para o monitor de PR casarem o
      // card depois — sem isso um merge não fecha nada.
      body: `${task.body ?? ""}\n\n---\nForjado na bancada do Brokk · card \`${task.id}\``,
    }).catch((err) => {
      console.warn(`[driver] PR de ${task.id}:`, err instanceof Error ? err.message : err);
      return null;
    });
  }

  if (run) {
    await deps.store.updateRun(run.id, {
      status: "succeeded",
      endedAt: new Date(),
      prUrl,
      branch,
    });
  }
  await deps.store.transitionTask(task.id, "review", {
    actor: "bancada-driver",
    reason: prUrl ? `PR aberto: ${prUrl}` : "agente concluiu; PR não foi aberto (sem GitHub App)",
    extra: { branch, ...(prUrl ? { prUrl } : {}) },
  });
  console.log(`[driver] ${task.id} → review${prUrl ? ` (${prUrl})` : ""}`);
}

async function fail(
  deps: BancadaDriverDeps,
  task: Task,
  runId: string | undefined,
  reason: string,
): Promise<void> {
  if (runId) {
    await deps.store.updateRun(runId, { status: "failed", endedAt: new Date(), error: reason });
  }
  await deps.store.transitionTask(task.id, "failed", { actor: "bancada-driver", reason });
  console.warn(`[driver] ${task.id} falhou: ${reason}`);
}
