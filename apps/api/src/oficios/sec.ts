/**
 * Ofício `sec` — o Svalinn cobrindo a varredura inteira de um repositório.
 *
 * O Brokk não varre nada aqui: comanda. A varredura já existe, roda a frota
 * toda noite e tem a receita, as engines e a retomada resolvidas. Duplicar
 * seria trocar uma coisa que funciona por uma para manter.
 *
 * Uma passada = a receita da frota num alvo (deepsec no agente `cursor` +
 * semgrep, gitleaks, trivy, rls, osv, checkov) até o alvo ficar quieto.
 */

import { estadoPassadaSec, getTargets, iniciarPassadaSec, type SvalinnClientOpts } from "../svalinn-client.js";
import type { AlvoCandidato, EstadoPassada, Oficio } from "./tipos.js";

/** Cadência da varredura. O disparo mensal do Svalinn usa 720h; aqui a fila é
 *  serial e cobre a frota inteira, então uma semana mantém o turno com trabalho
 *  sem re-varrer repositório parado. */
const CADENCIA_HORAS = Number(process.env.BROKK_SEC_CADENCIA_HORAS ?? 168) || 168;

export function oficioSec(svalinn: SvalinnClientOpts): Oficio {
  return {
    id: "sec",
    cadenciaHoras: CADENCIA_HORAS,

    async alvos(): Promise<AlvoCandidato[]> {
      // ⚠️ Inventário, NÃO o board: o board é triagem e só mostra alvo com
      // achado aberto — alvo limpo ou nunca varrido nunca entraria na fila.
      const alvos = await getTargets(svalinn);
      return alvos.map((t) => ({
        alvo: t.slug,
        // Palpite inicial de ordenação, nada mais: nunca varrido primeiro,
        // depois quem acumulou achado. Se vier tudo zerado, drena por FIFO.
        prioridade: (t.ultimaVarreduraEm ? 0 : 100) + Math.min(t.abertos, 50),
      }));
    },

    async iniciar(alvo: string): Promise<string> {
      const { passId } = await iniciarPassadaSec(svalinn, alvo);
      return passId;
    },

    async estado(passRef: string): Promise<EstadoPassada> {
      return (await estadoPassadaSec(svalinn, passRef)).estado;
    },

    async colher(passRef: string): Promise<unknown> {
      const s = await estadoPassadaSec(svalinn, passRef);
      return {
        alvo: s.slug,
        findingsAbertos: s.findingsAbertos,
        engines: s.runs.map((r) => ({ engine: r.engine, status: r.status })),
        falhas: s.runs.filter((r) => r.status === "failed").map((r) => r.engine),
      };
    },
  };
}
