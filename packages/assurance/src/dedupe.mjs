// Segunda camada de dedupe — semântica.
//
// POR QUE EXISTE: medido no PoC (arte-one, 2026-08-06, lente arch.debt, duas
// passadas no MESMO commit): o fingerprint determinístico pegou 3 de 10. Achado
// gerado por agente não tem identidade estável — a mesma dívida do docs/STORAGE.md
// voltou com outro slug, outro título e outro id. Sem esta camada, o ledger da
// ADR 0087 não vale nada: achado triado como wontfix reaparece na run seguinte,
// que é exatamente a falha que o ledger existe para impedir.
//
// Barato por desenho: só roda quando já existe achado da MESMA lente no MESMO
// arquivo, e manda só títulos+resumos — não relê o repo.

import { runCursor, extractJson } from "./cursor.mjs"

const MAX_CANDIDATOS = 12

/**
 * @returns {Promise<{ matchedId: string|null, why: string }>}
 */
export async function dedupeSemantico({ cwd, candidate, existentes, model }) {
  const lista = existentes.slice(0, MAX_CANDIDATOS)
  if (!lista.length) return { matchedId: null, why: "nenhum achado prévio neste arquivo" }

  const prompt = `Você decide IDENTIDADE de achados de revisão. Dois achados são O MESMO
quando apontam o MESMO defeito subjacente, ainda que descritos com outras palavras,
outro recorte ou outra severidade. São DIFERENTES quando o fix de um não resolve o outro.

## Achado novo
- arquivo: ${candidate.filePath ?? "—"}
- título: ${candidate.title}
- corpo: ${String(candidate.body ?? "").slice(0, 900)}

## Achados já no ledger (mesmo arquivo, mesma lente)
${lista.map((e, i) => `${i}. [id=${e.id}] (status=${e.status}) ${e.title}\n   ${String(e.body ?? "").slice(0, 400)}`).join("\n")}

Responda SOMENTE com JSON: {"match_index": <número|null>, "why": "uma frase"}.
Na dúvida entre "mesmo" e "diferente", prefira MESMO — republicar um achado que o
humano já triou custa mais caro que agrupar dois parecidos.`

  try {
    const out = await runCursor({ cwd, prompt, model: model ?? "auto", timeoutMs: 4 * 60 * 1000 })
    const v = extractJson(out)
    const idx = v.match_index
    if (idx === null || idx === undefined || !Number.isInteger(idx) || !lista[idx]) {
      return { matchedId: null, why: String(v.why ?? "sem correspondência").slice(0, 200) }
    }
    return { matchedId: lista[idx].id, why: String(v.why ?? "").slice(0, 200) }
  } catch (e) {
    // Fail-open: em falha, trata como novo. Consequência conhecida e declarada —
    // pode republicar um suprimido. O caminho certo (fila de re-tentativa) fica
    // para a F1; um PoC não deve esconder o buraco.
    return { matchedId: null, why: `dedupe falhou (tratado como novo): ${e.message.slice(0, 120)}` }
  }
}
