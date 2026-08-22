/**
 * O sequenciador — uma passada por vez, do começo ao fim.
 *
 * Espelha o laço externo do `fleet-night-orchestrator` do Svalinn, que já roda
 * a frota inteira toda noite: percorre alvos, espera um terminar antes de
 * chamar o próximo, e retoma de onde parou. O que muda aqui é que o corpo do
 * laço deixa de ser "varrer" e passa a ser "o ofício que a linha pedir".
 *
 * Serial NÃO é conveniência. O teto do Cursor não é tamanho de prompt, é peso
 * estrutural × concorrência: dois pedidos pesados simultâneos devolvem 503
 * `structure_limit`. Com a passada inteira como unidade, não existe onde
 * encaixar a segunda — serial vira consequência do desenho, não regra a lembrar.
 *
 * O tick é idempotente e faz UM passo:
 *
 *   1. há passada em voo? → só pergunta se terminou. Se terminou, colhe e fecha.
 *   2. não há? → gera candidatos vencidos, enfileira, e começa a próxima.
 *
 * A guarda do passo 1 é o que garante o serial: enquanto houver uma rodando, o
 * tick nunca chega no passo 2.
 */

import type { Store } from "@brokk/db";
import type { Oficio } from "./oficios/tipos.js";
import { venceu } from "./oficios/tipos.js";

export interface SequenciadorDeps {
  store: Store;
  /** Os ofícios ligados. Um só (`sec`) já exercita o contrato inteiro. */
  oficios: Oficio[];
  intervalMs?: number;
  /** Teto por passada. Estourou = falha explicada, em vez de segurar a fila
   *  para sempre — foi assim que a esteira antiga do Brokk apodrecia. */
  timeoutMs?: number;
}

const INTERVALO_PADRAO = 30_000;
const TETO_PADRAO = 4 * 60 * 60_000;

/** Estourou o teto? Passada sem `iniciadaEm` nunca estourou (acabou de sair). */
export function estourouTeto(
  iniciadaEm: string | null,
  tetoMs: number,
  agoraMs: number,
): boolean {
  if (!iniciadaEm) return false;
  const t = new Date(iniciadaEm).getTime();
  if (!Number.isFinite(t)) return false;
  return agoraMs - t >= tetoMs;
}

/** Ordena candidatos: maior prioridade primeiro, empate resolvido pelo nome
 *  (estável — duas rodadas com a mesma entrada dão a mesma ordem). */
export function ordenarCandidatos<T extends { alvo: string; prioridade?: number }>(
  candidatos: T[],
): T[] {
  return [...candidatos].sort(
    (a, b) => (b.prioridade ?? 0) - (a.prioridade ?? 0) || a.alvo.localeCompare(b.alvo),
  );
}

/** UM passo do sequenciador. Exportado para ser exercitado direto: "é serial"
 *  é afirmação que só vale se der para provar chamando. */
export async function passo(deps: SequenciadorDeps): Promise<void> {
  const teto = deps.timeoutMs ?? TETO_PADRAO;
  const porId = new Map(deps.oficios.map((o) => [o.id, o]));
  {
    // ── 1. Há passada em voo? Só ela importa. ────────────────────────────────
    const emVoo = await deps.store.passadaEmVoo();
    if (emVoo) {
      const oficio = porId.get(emVoo.oficio);
      if (!oficio) {
        await deps.store.fecharPassada(emVoo.id, "falhou", {
          erro: `ofício desligado: ${emVoo.oficio}`,
        });
        return;
      }
      if (estourouTeto(emVoo.iniciadaEm, teto, Date.now())) {
        await deps.store.fecharPassada(emVoo.id, "falhou", {
          erro: `estourou o teto de ${Math.round(teto / 60_000)}min`,
        });
        console.warn(`[seq] ${emVoo.oficio}/${emVoo.alvo}: teto estourado`);
        return;
      }
      if (!emVoo.passRef) {
        await deps.store.fecharPassada(emVoo.id, "falhou", { erro: "sem passRef" });
        return;
      }
      const estado = await oficio.estado(emVoo.passRef);
      if (estado === "rodando") return;
      if (estado === "concluida") {
        const artefato = await oficio.colher(emVoo.passRef).catch(() => null);
        await deps.store.fecharPassada(emVoo.id, "concluida", { artefato });
        console.log(`[seq] ${emVoo.oficio}/${emVoo.alvo}: concluída`);
      } else {
        await deps.store.fecharPassada(emVoo.id, "falhou", { erro: `estado ${estado}` });
        console.warn(`[seq] ${emVoo.oficio}/${emVoo.alvo}: ${estado}`);
      }
      return; // um passo por tick — a próxima começa no tick seguinte
    }

    // ── 2. Fila vazia de execução: gerar e começar. ──────────────────────────
    await gerar(deps);

    const proxima = await deps.store.proximaPassadaPendente();
    if (!proxima) return;
    const oficio = porId.get(proxima.oficio);
    if (!oficio) {
      await deps.store.fecharPassada(proxima.id, "falhou", {
        erro: `ofício desligado: ${proxima.oficio}`,
      });
      return;
    }
    try {
      const passRef = await oficio.iniciar(proxima.alvo);
      await deps.store.marcarPassadaRodando(proxima.id, passRef);
      console.log(`[seq] ${proxima.oficio}/${proxima.alvo}: iniciada (${passRef})`);
    } catch (err) {
      // Falha ao INICIAR fecha a linha em vez de deixá-la pendente para sempre.
      // O gerador reenfileira no próximo ciclo de cadência; o que não pode é a
      // fila travar num alvo que o executor recusa.
      const msg = err instanceof Error ? err.message : String(err);
      await deps.store.fecharPassada(proxima.id, "falhou", { erro: msg });
      console.warn(`[seq] ${proxima.oficio}/${proxima.alvo}: não iniciou — ${msg}`);
    }
  }
}

export function startSequenciador(deps: SequenciadorDeps): { stop: () => void } {
  const intervalo = deps.intervalMs ?? INTERVALO_PADRAO;
  const tick = () => passo(deps).catch((e) => console.warn("[seq]", e));
  const timer = setInterval(() => void tick(), intervalo);
  timer.unref?.();
  void tick();
  return { stop: () => clearInterval(timer) };
}

/** Enfileira o que venceu. Idempotente: `enfileirarPassada` devolve null quando
 *  já há uma aberta para o par, então rodar a cada tick não duplica. */
async function gerar(deps: SequenciadorDeps): Promise<void> {
  const agora = Date.now();
  for (const oficio of deps.oficios) {
    let candidatos;
    try {
      candidatos = ordenarCandidatos(await oficio.alvos());
    } catch (err) {
      // Gerador cego não pode derrubar o turno: o que já está na fila continua.
      console.warn(`[seq] gerador ${oficio.id}:`, err instanceof Error ? err.message : err);
      continue;
    }
    for (const c of candidatos) {
      const ultima = await deps.store.ultimaPassadaTerminal(oficio.id, c.alvo);
      if (!venceu(ultima, oficio.cadenciaHoras, agora)) continue;
      await deps.store.enfileirarPassada({
        oficio: oficio.id,
        alvo: c.alvo,
        prioridade: c.prioridade ?? 0,
      });
    }
  }
}
