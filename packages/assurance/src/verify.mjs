// Verificação adversarial (ADR 0087 §5). O verificador é instruído a REFUTAR e
// a errar para o lado de refutado — é o filtro que separa "recall-first na lente"
// de "ruído no PR". Sem ele, uma lente `heavy` de repo inteiro publica opinião.
//
// Lentes distintas por desenho: redundância pega alucinação, diversidade pega
// classe de erro. Aqui: existe-de-fato · importa · a prova é real.

import { runCursor, extractJson } from "./cursor.mjs"

const LENSES_DE_VERIFICACAO = [
  {
    id: "existe",
    ask: `O achado descreve algo que REALMENTE está no código? Abra o arquivo e a
faixa de linhas citada e confira. Arquivo inexistente, linha que não bate, símbolo
que não existe, comportamento que o código não tem → refutado.`,
  },
  {
    id: "importa",
    ask: `Assumindo que existe: isso causa dano real (falha em execução, risco,
custo de manutenção mensurável)? Preferência de estilo, nit, "poderia ser mais
elegante", ou algo que o framework já trata → refutado.`,
  },
  {
    id: "prova",
    ask: `A \`proof_ref\` é um controle negativo de verdade — algo que FALHA hoje e
PASSA depois do fix? Se a prova for vaga, circular, ou só "rodar os testes" →
refutado (ADR 0087 §3: sem prova, não é achado executável).`,
  },
]

const SCHEMA = `Responda SOMENTE com JSON: {"refuted": true|false, "why": "uma frase"}.`

async function umVoto({ cwd, finding, lente, model }) {
  const prompt = `Você é um verificador ADVERSARIAL. Sua função é DERRUBAR o achado abaixo.
Na dúvida, refute: um achado falso publicado custa mais que um achado real perdido.

## Achado
- lente: ${finding.lensId}
- título: ${finding.title}
- arquivo: ${finding.filePath ?? "—"}${finding.lineStart ? `:${finding.lineStart}` : ""}
- severidade: ${finding.severity}
- corpo: ${String(finding.body ?? "").slice(0, 1500)}
- prova alegada: ${finding.proofRef ?? "(nenhuma)"}

## Seu ângulo — "${lente.id}"
${lente.ask}

Você tem o repositório em \`.\` para conferir. Não modifique nada.
${SCHEMA}`
  try {
    const out = await runCursor({ cwd, prompt, model: model ?? "auto", timeoutMs: 5 * 60 * 1000 })
    const v = extractJson(out)
    return { lens: lente.id, refuted: v.refuted !== false, why: String(v.why ?? "").slice(0, 300) }
  } catch (e) {
    // Verificador que falha não absolve: conta como refutação (fail-closed).
    return { lens: lente.id, refuted: true, why: `verificador falhou: ${e.message.slice(0, 120)}` }
  }
}

/**
 * Sobrevive quem for confirmado por >= `minVotos` das lentes de verificação.
 * Retorna { survives, votes, confidence }.
 */
export async function verificar({ cwd, finding, model, minVotos = 2 }) {
  const votes = []
  for (const lente of LENSES_DE_VERIFICACAO) {
    votes.push(await umVoto({ cwd, finding, lente, model }))
  }
  const confirmados = votes.filter((v) => !v.refuted).length
  return {
    survives: confirmados >= minVotos,
    votes,
    confidence: Number((confirmados / LENSES_DE_VERIFICACAO.length).toFixed(2)),
  }
}
