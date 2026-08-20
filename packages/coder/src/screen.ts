/**
 * A tela do agente, virada em blocos que dá para desenhar.
 *
 * O que a AgentAPI devolve NÃO é markdown: é o **buffer do terminal** do CLI,
 * com largura fixa (67 colunas), padding de espaços até o fim de cada linha,
 * arte ASCII no banner de boot, `●` para cada passo, `⎿` para o resultado de um
 * passo e trechos de diff com número de linha na frente.
 *
 * Jogar isso cru num `<pre>` é o que fazia o chat parecer um log de servidor.
 * Aqui a tela vira uma lista de blocos tipados; quem desenha decide o estilo.
 *
 * Deliberadamente conservador: o que não se reconhece vira `texto`, nunca some.
 * Um parser que engole o que não entendeu é pior que um `<pre>`.
 */

export type BlocoTipo = "texto" | "passo" | "detalhe" | "codigo" | "status";

export interface Bloco {
  tipo: BlocoTipo;
  /** Linhas do bloco, já sem o padding e sem o marcador. */
  linhas: string[];
}

/** O banner que o CLI imprime ao subir — arte ASCII, versão, aviso de plano.
 *  Aparece SEMPRE no topo da tela e não diz nada sobre o trabalho. */
// Faixa INTEIRA de block elements (U+2580–U+259F), não uma lista de glifos: a
// primeira versão enumerava à mão e deixou passar o `▎` (U+258E) que o CLI usa
// na barra lateral do aviso de plano — o banner vazava para a tela.
const ARTE = "[\\s\\u2580-\\u259F│╭╮╰╯─]";
const BANNER = new RegExp(
  // linha feita só de arte/espaço…
  `^${ARTE}*$` +
    // …ou arte seguida do texto do banner (a arte vem ANTES da versão, então
    // ancorar em \s* não pega — foi assim que o banner vazou no primeiro teste).
    `|^${ARTE}*(Claude Code v|Sonnet |Opus |Fable |~/|You can use up to|you hit your limit|credits\\.|and select |Learn more|https://support|com/en/articles|WARNING: |In Bypass|This mode should|By proceeding|approval before)`,
);

/** `✻ Churned for 20s`, `✻ Cooked for 7s` — o rodapé de tempo do CLI. */
const STATUS = /^\s*[✻✳✽*]\s+\w.*\b(for|por)\s+\d+/;

/** Linha de diff/código: número de linha (com + ou -) e depois conteúdo. */
const CODIGO = /^\s{2,}\d+\s*[+-]?\s/;

/** O eco do prompt do humano, que o CLI reimprime na tela. Some: a mensagem do
 *  humano já é desenhada como bolha, e mostrar as duas é a mesma frase duas
 *  vezes na mesma conversa. */
const ECO = /^❯\s/;

/** Passo do agente. */
const PASSO = /^●\s+/;
/** Resultado pendurado num passo. */
const DETALHE = /^\s*⎿\s?/;

function limpa(linha: string): string {
  // \xa0 é o espaço rígido que o CLI usa para alinhar; vira espaço normal.
  return linha.replace(/ /g, " ").replace(/\s+$/, "");
}

/** Quebra a tela do agente em blocos. */
export function parseAgentScreen(bruto: string): Bloco[] {
  const linhas = (bruto ?? "").split("\n").map(limpa);
  const blocos: Bloco[] = [];
  let bannerAcabou = false;

  const empurra = (tipo: BlocoTipo, linha: string) => {
    const ultimo = blocos[blocos.length - 1];
    // Só junta com o anterior quando é continuação do MESMO tipo — assim um
    // trecho de código não é engolido pela frase acima dele.
    if (ultimo && ultimo.tipo === tipo && tipo !== "passo") {
      ultimo.linhas.push(linha);
      return;
    }
    blocos.push({ tipo, linhas: [linha] });
  };

  for (const linha of linhas) {
    if (!bannerAcabou) {
      // O banner some inteiro, mas só até a primeira linha de verdade: depois
      // disso uma linha em branco é uma linha em branco.
      if (linha === "" || BANNER.test(linha)) continue;
      bannerAcabou = true;
    }
    if (linha === "") {
      // Uma linha vazia FECHA o bloco corrente em vez de virar conteúdo — é o
      // que remove o mar de espaços do buffer do terminal.
      if (blocos.length && blocos[blocos.length - 1]!.linhas.length) {
        blocos.push({ tipo: "texto", linhas: [] });
      }
      continue;
    }
    if (ECO.test(linha)) continue;
    if (STATUS.test(linha)) empurra("status", linha.replace(/^\s*[✻✳✽*]\s+/, ""));
    else if (PASSO.test(linha)) empurra("passo", linha.replace(PASSO, ""));
    else if (DETALHE.test(linha)) empurra("detalhe", linha.replace(DETALHE, ""));
    else if (CODIGO.test(linha)) empurra("codigo", linha);
    else empurra("texto", linha);
  }

  return blocos.filter((b) => b.linhas.length > 0);
}

/** Uma linha só que resume o bloco mais recente — para chip/estado. */
export function resumoDaTela(bruto: string): string {
  const blocos = parseAgentScreen(bruto);
  for (let i = blocos.length - 1; i >= 0; i--) {
    const b = blocos[i]!;
    if (b.tipo === "passo" || b.tipo === "texto") return b.linhas.join(" ").slice(0, 120);
  }
  return "";
}
