/**
 * Ofício `ui` — varrer e criticar todas as telas de um app, numa passada.
 *
 * O trabalho já existe e está provado à mão: `ui-sweep.mjs` no washinn/mobile
 * monta a matriz a partir do spec (tela × papel × estado × tema × largura),
 * captura tudo e emite um `manifest.json` com a rubrica junto. O que faltava era
 * repetição — alguém lembrar de rodar, e alguém olhar as imagens depois.
 *
 * Aqui a passada roda na BANCADA, que é onde o app já está de pé com o agente
 * dentro. O Brokk não varre nem julga: entrega o briefing e espera o sentinela,
 * exatamente como o `bancada-driver` faz com card. O briefing É a interface.
 *
 * ⚠️ A parte mecânica (tela em branco, rolagem lateral, alvo < 44px) o script
 * resolve sozinho e devolve verde ou vermelho. O valor desta passada é a
 * CRÍTICA: o julgamento contra `design.hierarquia` e `design.voz`, que nenhuma
 * verificação de CSS alcança — já tentamos, e a versão mecânica acusou 247 de
 * 312 capturas corretas.
 */

import type { Store } from "@brokk/db";
import type { BancadaService } from "../bancada.js";
import type { AlvoCandidato, EstadoPassada, Oficio } from "./tipos.js";

/** O agente assina assim. Reconhecido em qualquer lugar da resposta — pedir
 *  "responda APENAS isto" é como se perde o relatório junto. */
const PRONTO = /BROKK-UI\s+(\S+)/;
/** E assim quando não deu. Sem isto, alvo que não consegue varrer fica em voo
 *  até o teto do sequenciador — uma hora de fila serial gasta esperando nada. */
const FALHOU = /BROKK-UI-FALHOU/;

const CADENCIA_HORAS = Number(process.env.BROKK_UI_CADENCIA_HORAS ?? 168) || 168;

export function briefingUi(app: string): string {
  return [
    `Varredura e crítica de telas do ${app}.`,
    "",
    "1. Rode `pnpm ui:sweep` contra o app que já está de pé nesta bancada.",
    "   O inventário sai de `assurance/spec.yaml` — não monte lista de rota à mão.",
    "",
    "2. Leia o `manifest.json` que ele emite. Ele traz, junto das capturas, a",
    "   rubrica do próprio produto em `design` (hierarquia, voz, temas, alvo de",
    "   toque). É contra ela que você julga — não contra gosto pessoal.",
    "",
    "3. Abra as IMAGENS e critique. O que o script já mede (tela em branco,",
    "   rolagem lateral, alvo pequeno) não precisa ser repetido: interessa o que",
    "   só se vê olhando — hierarquia que se perde num tema, tela cuja massa não",
    "   pede nada, faixa escura ausente ou duplicada, texto que confessa",
    "   bastidor, vazio desonesto.",
    "",
    "4. Escreva `assurance/critica-ui.md`: cada achado com a tela, o tema, a",
    "   regra da rubrica que ele contraria, e por que importa. Achado sem regra",
    "   correspondente é opinião — marque como tal ou descarte.",
    "",
    "Regras:",
    "- NÃO altere código de produto. Esta passada observa e escreve o relatório.",
    "- Compare os dois temas. É onde estão os achados que ninguém viu.",
    "- Ao terminar, responda com a linha: BROKK-UI assurance/critica-ui.md",
    "- Se não for possível varrer, explique e responda: BROKK-UI-FALHOU",
  ].join("\n");
}

export type UiDeps = {
  store: Store;
  bancadas: BancadaService;
  /** Projetos que têm spec com `design.prova_visual`. Lista explícita porque a
   *  tabela `projects` do Brokk ainda não sabe quais repos têm spec — descobrir
   *  isso é leitura no GitHub por projeto, e a fila não precisa disso para
   *  começar a rodar. */
  alvos: string[];
};

export function oficioUi(deps: UiDeps): Oficio {
  return {
    id: "ui",
    cadenciaHoras: CADENCIA_HORAS,

    async alvos(): Promise<AlvoCandidato[]> {
      const projetos = await deps.store.listProjects();
      return projetos
        .filter((p) => deps.alvos.includes(p.name))
        .map((p) => ({ alvo: p.name, prioridade: 0 }));
    },

    async iniciar(alvo: string): Promise<string> {
      const projeto = (await deps.store.listProjects()).find((p) => p.name === alvo);
      if (!projeto) throw new Error(`projeto desconhecido: ${alvo}`);
      const bancada = await deps.bancadas.ensure(projeto.id);
      const r = await deps.bancadas.agentSend(bancada, briefingUi(alvo));
      if (!r.ok) throw new Error(`bancada recusou o briefing: ${r.reason ?? "sem motivo"}`);
      return bancada.id;
    },

    async estado(passRef: string): Promise<EstadoPassada> {
      const bancada = await deps.store.getBancada(passRef);
      if (!bancada) return "desconhecida";
      const msgs = await deps.bancadas.agentMessages(bancada);
      const texto = msgs.map((m) => m.content ?? "").join("\n");
      if (PRONTO.test(texto)) return "concluida";
      if (FALHOU.test(texto)) return "falhou";
      return "rodando";
    },

    async colher(passRef: string): Promise<unknown> {
      const bancada = await deps.store.getBancada(passRef);
      if (!bancada) return null;
      const msgs = await deps.bancadas.agentMessages(bancada);
      const texto = msgs.map((m) => m.content ?? "").join("\n");
      const relatorio = PRONTO.exec(texto)?.[1] ?? null;
      return {
        app: bancada.workspaceName,
        relatorio,
        // A última fala do agente costuma trazer o resumo do que ele achou —
        // guardar aqui evita ter que abrir a bancada só para ler o desfecho.
        desfecho: (msgs.at(-1)?.content ?? "").slice(0, 2000),
      };
    },
  };
}
