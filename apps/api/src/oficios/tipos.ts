/**
 * O contrato de um ofício — o desenho inteiro da fila cabe aqui.
 *
 * Uma passada é **um alvo × um ofício**, do começo ao fim: `sec` é o Svalinn
 * cobrindo a varredura inteira de um repositório; `qa` será o catálogo inteiro
 * de cenários de um app. O sequenciador nunca sabe o que uma passada faz — ele
 * pede, pergunta e colhe. Ofício novo é uma implementação destes quatro verbos,
 * não um subsistema.
 *
 * A saída de `colher` é SEMPRE inerte: relatório, contagem, caminho de
 * artefato. Abrir PR, comentar e mergear são promoção, e promoção não é do
 * turno — um turno ruim não pode virar produção ruim sozinho.
 */

export type EstadoPassada = "rodando" | "concluida" | "falhou" | "desconhecida";

/** Um alvo candidato que o gerador do ofício devolve. */
export type AlvoCandidato = {
  /** A chave natural do ofício: slug do repositório ou do projeto. */
  alvo: string;
  /** Maior primeiro. O gerador dá o palpite inicial; a priorização por LLM
   *  (quando existir) reescreve depois. */
  prioridade?: number;
};

export interface Oficio {
  readonly id: string;

  /** Cadência do ofício em horas: quanto tempo depois de uma passada concluída
   *  o mesmo par volta a ser candidato. */
  readonly cadenciaHoras: number;

  /** Quem se aplica a este ofício agora. O sequenciador filtra por cadência
   *  usando o próprio histórico — o executor não precisa expor histórico. */
  alvos(): Promise<AlvoCandidato[]>;

  /** Dispara a passada inteira. Devolve a referência do executor. */
  iniciar(alvo: string): Promise<string>;

  /** Terminou? Só isso. */
  estado(passRef: string): Promise<EstadoPassada>;

  /** O que fica. Chamado uma vez, quando `estado` vira terminal. */
  colher(passRef: string): Promise<unknown>;
}

/** Quanto esperar antes de tentar de novo um par que FALHOU.
 *
 *  🔴 Medido em produção: sem isto, alvo que falha INSTANTANEAMENTE (repo vazio,
 *  alvo recusado pelo executor) volta para a fila a cada tick. O `portifolio-lp`
 *  acumulou 7 tentativas em 10 minutos e segurou o resto da fila atrás dele —
 *  a mesma armadilha que o loop do Svalinn já documentava ("não re-despacha
 *  sozinho, evita storm"). */
const RETRY_FALHA_HORAS = Number(process.env.BROKK_RETRY_FALHA_HORAS ?? 6) || 6;

/** Falhas terminais seguidas antes de o par deixar de ser tratado como
 *  transitório. Três: uma é ruído, duas é azar, três é padrão. */
const FALHAS_ATE_FREAR = 3;
/** Quanto a espera estica quando o freio entra. */
const FATOR_FREIO = 20;

/** Passou tempo suficiente desde a última TENTATIVA terminal deste par?
 *
 *  Par que nunca rodou está sempre vencido — é assim que a frota entra na fila
 *  na primeira noite sem ninguém enfileirar à mão.
 *
 *  ⚠️ A conta é sobre a última passada TERMINAL, não sobre a última concluída.
 *  Falha conta como tentativa: ela espera `RETRY_FALHA_HORAS` (mais curto que a
 *  cadência, para um problema transitório se resolver sozinho no mesmo dia) em
 *  vez de voltar imediatamente. */
export function venceu(
  ultima: { estado?: string; terminadaEm?: string | null } | null | undefined,
  cadenciaHoras: number,
  agoraMs: number,
  falhasSeguidas = 0,
): boolean {
  if (!ultima?.terminadaEm) return true;
  const t = new Date(ultima.terminadaEm).getTime();
  if (!Number.isFinite(t)) return true;
  let esperaHoras = cadenciaHoras;
  if (ultima.estado === "falhou") {
    esperaHoras = Math.min(RETRY_FALHA_HORAS, cadenciaHoras);
    // Freio para alvo que não tem conserto. O `portifolio-lp` é repositório
    // VAZIO: o clone falha, sempre vai falhar, e ele voltava à fila a cada 6h
    // acumulando linha morta no histórico — o retry curto existe para problema
    // TRANSITÓRIO, e três falhas seguidas dizem que este não é.
    // Não é banimento: se o repositório ganhar conteúdo, o par volta sozinho.
    if (falhasSeguidas >= FALHAS_ATE_FREAR) {
      esperaHoras = Math.max(cadenciaHoras, RETRY_FALHA_HORAS) * FATOR_FREIO;
    }
  }
  return agoraMs - t >= esperaHoras * 3_600_000;
}
