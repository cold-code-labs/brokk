import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseAgentScreen, resumoDaTela } from "./screen.js";

/** Recorte real da tela devolvida pela AgentAPI em 20/08/2026 — com o padding
 *  de 67 colunas, o `\xa0` do alinhamento e o banner de boot. */
const TELA = [
  // Copiado literalmente da AgentAPI em 20/08/2026, glifos inclusive: a barra
  // do aviso de plano é `▎` (U+258E), que uma lista feita à mão deixou passar.
  " ▐▛███▛█   Claude Code v2.1.238                                    ",
  "▝▜██████▀  Sonnet 5 · Claude API                                   ",
  "  ▝▝ ▝▝    ~/app                                                   ",
  "                                                                   ",
  " ▎ Fable 5 is now a standard part of your Max plan                 ",
  " ▎ You can use up to 50% of your weekly usage limit on Fable 5. If ",
  "❯ Em src/pages/Login.tsx, troque o texto do botao                  ",
  "                                                                  ",
  "  Searched for 1 pattern, read 1 file                             ",
  "                                                                  ",
  "● Confirmado, é o botão de submit do login (linha 100).           ",
  "                                                                  ",
  "● Update(src/pages/Login.tsx)                                     ",
  "  ⎿  Added 1 line, removed 1 line                               ",
  "       97                />                                       ",
  "       98              </div>                                     ",
  "       99 -            <button type=\"submit\">Entrar</button>      ",
  "       99 +            <button type=\"submit\">ENTRAR AGORA</button>",
  "                                                                  ",
  "✻ Churned for 20s                                                 ",
].join("\n");

describe("tela do agente", () => {
  const blocos = parseAgentScreen(TELA);

  it("joga fora o banner de boot, que não diz nada sobre o trabalho", () => {
    const tudo = blocos.flatMap((b) => b.linhas).join(" ");
    assert.ok(!tudo.includes("Claude Code v"), tudo.slice(0, 120));
    assert.ok(!/[\u2580-\u259F]/.test(tudo), "sobrou arte ASCII do banner");
    assert.ok(!tudo.includes("Fable 5"), "sobrou o aviso de plano");
  });

  it("não repete o prompt do humano — ele já é uma bolha", () => {
    const tudo = blocos.flatMap((b) => b.linhas).join(" ");
    assert.ok(!tudo.includes("troque o texto do botao"), tudo.slice(0, 140));
  });

  it("tira o padding de 67 colunas — é ele que faz parecer log de servidor", () => {
    for (const b of blocos) {
      for (const l of b.linhas) assert.equal(l, l.replace(/\s+$/, ""), JSON.stringify(l));
    }
  });

  it("separa passo, detalhe e código em blocos distintos", () => {
    const tipos = blocos.map((b) => b.tipo);
    assert.ok(tipos.includes("passo"), JSON.stringify(tipos));
    assert.ok(tipos.includes("detalhe"), JSON.stringify(tipos));
    assert.ok(tipos.includes("codigo"), JSON.stringify(tipos));
  });

  it("não deixa o diff ser engolido pela frase de cima", () => {
    const codigo = blocos.find((b) => b.tipo === "codigo")!;
    assert.ok(codigo.linhas.some((l) => l.includes("ENTRAR AGORA")));
    assert.ok(!codigo.linhas.some((l) => l.includes("Confirmado")));
  });

  it("reconhece o rodapé de tempo como status, sem o glifo", () => {
    const status = blocos.find((b) => b.tipo === "status")!;
    assert.equal(status.linhas[0], "Churned for 20s");
  });

  it("tira o marcador do passo, mas mantém o texto inteiro", () => {
    const passo = blocos.find((b) => b.tipo === "passo")!;
    assert.equal(passo.linhas[0], "Confirmado, é o botão de submit do login (linha 100).");
  });

  it("não perde o que não reconhece", () => {
    const b = parseAgentScreen("uma frase qualquer que não casa com nada");
    assert.deepEqual(b, [{ tipo: "texto", linhas: ["uma frase qualquer que não casa com nada"] }]);
  });

  it("aguenta tela vazia sem estourar", () => {
    assert.deepEqual(parseAgentScreen(""), []);
    assert.deepEqual(parseAgentScreen("   \n  \n"), []);
  });

  it("resume pela última coisa que o agente disse", () => {
    assert.match(resumoDaTela(TELA), /Update|Confirmado/);
  });
});
