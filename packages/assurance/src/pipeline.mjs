// O pipeline da ADR 0087 §5:
//
//   lente(s) → normalize → fingerprint
//            → dedupe contra o LEDGER INTEIRO (não contra esta run)
//            → verificação adversarial (>= 2 de 3 lentes confirmam)
//            → rank por severidade × confiança
//            → publica o que cabe no orçamento; o resto CONTADO E VISÍVEL
//
// As duas regras não-negociáveis estão marcadas no código, porque as duas têm
// modo de falha conhecido e silencioso.

import { fingerprint } from "./fingerprint.mjs"
import { checkout, diffAgainst, runLensViaCursor } from "./cursor.mjs"
import { verificar } from "./verify.mjs"

const SEV_RANK = { critical: 0, high: 1, medium: 2, low: 3, info: 4 }

export async function runLens({
  lens, ledger, project, repoDir, ref = "HEAD", base, model,
  verify = true, budget, log = console.log,
}) {
  const runId = ledger.startRun({ project, repo: repoDir, lensId: lens.id, layer: lens.trigger })
  const wt = await checkout(repoDir, ref)
  const stats = {
    bruto: 0, novos: 0, recorrentes: 0, suprimidos: 0, regressoes: 0,
    refutados: 0, publicados: 0, cortados_por_orcamento: 0,
  }

  try {
    const context = { project, diff: "", stackHint: null }
    if (lens.scope === "diff") {
      if (!base) throw new Error(`lente ${lens.id} é scope:diff — passe --base <ref>`)
      context.diff = diffAgainst(repoDir, base).slice(0, 400_000)
      if (!context.diff.trim()) {
        log(`  (diff vazio contra ${base} — nada a revisar)`)
        ledger.endRun(runId, "done", stats)
        return { runId, publicados: [], stats }
      }
    }

    log(`  cursor-agent · lente ${lens.id} · ${lens.scope} · commit ${wt.commit.slice(0, 8)}`)
    const bruto = await runLensViaCursor({
      lens, cwd: wt.dir, context, model,
      onHeartbeat: () => log("  … agente trabalhando"),
    })
    stats.bruto = bruto.length
    log(`  ${bruto.length} achado(s) bruto(s)`)

    // ── dedupe contra o ledger inteiro ──────────────────────────────────────
    // REGRA: dedupe contra `seen`, NUNCA contra `confirmed`. Se o dedupe olhasse
    // só o que foi confirmado, todo achado que o verificador derrubou voltaria
    // na run seguinte e o loop nunca convergiria.
    const candidatos = []
    for (const raw of bruto) {
      const n = lens.normalize(raw)
      const f = {
        ...n,
        project, repo: repoDir, lensId: lens.id, axis: lens.axis,
        proofKind: lens.proof,
        fingerprint: fingerprint({ lensId: lens.id, rule: n.rule, filePath: n.filePath, title: n.title }),
      }
      const { verdict, id } = ledger.upsert(f, runId)
      stats[{ new: "novos", recurring: "recorrentes", suppressed: "suprimidos", regression: "regressoes" }[verdict]]++
      if (verdict === "suppressed") continue          // triado uma vez, calado para sempre
      if (verdict === "recurring") continue           // já está no painel; não republica
      candidatos.push({ ...f, id, verdict })
    }
    log(`  dedupe: ${stats.novos} novo(s) · ${stats.recorrentes} recorrente(s) · ${stats.suprimidos} suprimido(s) · ${stats.regressoes} regressão(ões)`)

    // ── verificação adversarial ─────────────────────────────────────────────
    const sobreviventes = []
    for (const c of candidatos) {
      if (!verify) { sobreviventes.push({ ...c, confidence: null }); continue }
      const v = await verificar({ cwd: wt.dir, finding: c, model })
      ledger.event(c.id, v.survives ? "verified" : "refuted", {
        actor: "verify", payload: v.votes,
      })
      if (!v.survives) {
        stats.refutados++
        ledger.triage(c.id, "false_positive", {
          actor: "verify",
          reason: `refutado ${v.votes.filter((x) => x.refuted).length}/3: ` +
                  v.votes.filter((x) => x.refuted).map((x) => `[${x.lens}] ${x.why}`).join(" · "),
        })
        log(`  ✗ refutado: ${c.title.slice(0, 70)}`)
        continue
      }
      sobreviventes.push({ ...c, confidence: v.confidence })
      log(`  ✓ confirmado (${v.confidence}): ${c.title.slice(0, 70)}`)
    }

    // ── rank + orçamento ────────────────────────────────────────────────────
    sobreviventes.sort((a, b) =>
      (SEV_RANK[a.severity] ?? 9) - (SEV_RANK[b.severity] ?? 9) ||
      (b.confidence ?? 0) - (a.confidence ?? 0))
    const teto = budget ?? lens.budget ?? 10
    const publicados = sobreviventes.slice(0, teto)
    stats.publicados = publicados.length
    // REGRA: nenhum corte silencioso. Truncar sem dizer lê como "cobrimos tudo".
    stats.cortados_por_orcamento = sobreviventes.length - publicados.length
    if (stats.cortados_por_orcamento > 0) {
      log(`  ⚠ orçamento ${teto}: ${stats.cortados_por_orcamento} achado(s) confirmado(s) NÃO publicado(s) (ficam no ledger como open)`)
    }

    ledger.endRun(runId, "done", stats)
    return { runId, publicados, stats }
  } catch (e) {
    ledger.endRun(runId, "error", { ...stats, erro: e.message })
    throw e
  } finally {
    await wt.cleanup()
  }
}
