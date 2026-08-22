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

/** Passou tempo suficiente desde a última conclusão deste par?
 *
 *  Par que nunca rodou está sempre vencido — é assim que a frota entra na fila
 *  na primeira noite sem ninguém enfileirar à mão. */
export function venceu(
  ultimaConclusao: string | null | undefined,
  cadenciaHoras: number,
  agoraMs: number,
): boolean {
  if (!ultimaConclusao) return true;
  const t = new Date(ultimaConclusao).getTime();
  if (!Number.isFinite(t)) return true;
  return agoraMs - t >= cadenciaHoras * 3_600_000;
}
