#!/usr/bin/env node
// CLI do PoC — ADR 0087.
//
//   assurance lenses
//   assurance doctor
//   assurance run   --project arte-one --repo ~/ccl/arte-one --lens arch.debt
//   assurance run   --project arte-one --repo ~/ccl/arte-one --lens review.correctness --base main
//   assurance list  --project arte-one [--status open]
//   assurance triage <id> --status wontfix --reason "..."
//   assurance stats --project arte-one

import path from "node:path"
import { homedir } from "node:os"
import { Ledger } from "../src/ledger.mjs"
import { LENSES, getLens } from "../src/lenses/index.mjs"
import { runLens } from "../src/pipeline.mjs"
import { cursorAvailable, agentBin } from "../src/cursor.mjs"

function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith("--")) {
      const k = a.slice(2)
      const v = argv[i + 1]?.startsWith("--") || argv[i + 1] === undefined ? true : argv[++i]
      out[k] = v
    } else out._.push(a)
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const cmd = args._[0]
const ledgerPath = args.ledger || path.join(homedir(), ".local/share/brokk-assurance/ledger.db")
const expand = (p) => (p?.startsWith("~") ? path.join(homedir(), p.slice(1)) : p)

function table(rows, cols) {
  if (!rows.length) return "(vazio)"
  const w = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length)))
  const line = (vals) => vals.map((v, i) => String(v ?? "").padEnd(w[i])).join("  ")
  return [line(cols), line(w.map((n) => "─".repeat(n))), ...rows.map((r) => line(cols.map((c) => r[c])))].join("\n")
}

switch (cmd) {
  case "lenses": {
    console.log(table(
      Object.values(LENSES).map((l) => ({
        id: l.id, axis: l.axis, scope: l.scope, trigger: l.trigger,
        proof: l.proof, cost: l.cost, budget: l.budget,
      })),
      ["id", "axis", "scope", "trigger", "proof", "cost", "budget"],
    ))
    break
  }

  case "doctor": {
    const c = cursorAvailable()
    console.log(`cursor-agent : ${agentBin()}`)
    console.log(`engine       : ${c.ok ? "✅ pronta (Cursor API)" : `❌ ${c.why}`}`)
    console.log(`ledger       : ${ledgerPath}`)
    const l = new Ledger(ledgerPath); l.close()
    console.log(`sqlite       : ✅ ok`)
    process.exit(c.ok ? 0 : 1)
  }

  case "run": {
    const lens = getLens(args.lens)
    const project = args.project || path.basename(expand(args.repo) ?? "")
    const repo = expand(args.repo)
    if (!repo) throw new Error("--repo é obrigatório")
    const ledger = new Ledger(ledgerPath)
    console.log(`▸ ${lens.label} — ${project}`)
    const { stats, publicados } = await runLens({
      lens, ledger, project, repoDir: repo,
      ref: args.ref || "HEAD",
      base: args.base,
      model: args.model,
      verify: args["no-verify"] !== true,
      budget: args.budget ? Number(args.budget) : undefined,
    })
    console.log("\n" + table([stats], Object.keys(stats)))
    if (publicados.length) {
      console.log("\nPublicados:")
      console.log(table(
        publicados.map((p) => ({
          id: p.id.slice(0, 8), sev: p.severity, conf: p.confidence ?? "—",
          file: (p.filePath ?? "—").slice(-42), title: p.title.slice(0, 68),
        })),
        ["id", "sev", "conf", "file", "title"],
      ))
    }
    ledger.close()
    break
  }

  case "list": {
    const ledger = new Ledger(ledgerPath)
    const rows = ledger.list({ project: args.project, status: args.status, lensId: args.lens })
    console.log(table(
      rows.map((r) => ({
        id: r.id.slice(0, 8), lens: r.lens_id, sev: r.severity, status: r.status,
        seen: r.seen_count, file: (r.file_path ?? "—").slice(-38), title: r.title.slice(0, 62),
      })),
      ["id", "lens", "sev", "status", "seen", "file", "title"],
    ))
    ledger.close()
    break
  }

  case "triage": {
    const ledger = new Ledger(ledgerPath)
    const short = args._[1]
    const row = ledger.list({ limit: 500 }).find((r) => r.id.startsWith(short))
    if (!row) throw new Error(`nenhum finding começando com ${short}`)
    ledger.triage(row.id, args.status, { reason: args.reason, actor: args.actor || process.env.USER })
    console.log(`✔ ${row.id.slice(0, 8)} → ${args.status}`)
    ledger.close()
    break
  }

  case "stats": {
    const ledger = new Ledger(ledgerPath)
    const rows = ledger.acceptRates(args.project).map((r) => ({
      lens: r.lens_id, publicados: r.published, aceitos: r.accepted, rejeitados: r.rejected,
      accept_rate: r.published ? `${Math.round((r.accepted / r.published) * 100)}%` : "—",
    }))
    console.log(table(rows, ["lens", "publicados", "aceitos", "rejeitados", "accept_rate"]))
    ledger.close()
    break
  }

  default:
    console.log(`assurance — PoC ADR 0087 (lentes de asseguração, engine Cursor API)

  lenses                              lista o registro de lentes
  doctor                              checa engine + ledger
  run --project P --repo DIR --lens L [--base REF] [--budget N] [--no-verify]
  list --project P [--status open]
  triage <id8> --status wontfix --reason "..."
  stats --project P                   accept_rate por lente
`)
    process.exit(cmd ? 1 : 0)
}
