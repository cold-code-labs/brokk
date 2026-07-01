#!/usr/bin/env tsx
// Resolve scout smoke — analisa um card real contra um checkout real (isolado:
// gateway + checkout → plano de resolução, sem api/db/chat).
//   set -a; . gw.env; set +a   # ANTHROPIC_AUTH_TOKEN
//   ANTHROPIC_BASE_URL=http://10.10.0.2:4000 pnpm dlx tsx scripts/resolve-smoke.ts <checkoutDir>
import { loadAflConfig } from "../packages/afl/src/config.js";
import { runResolve } from "../packages/agents/scout/src/resolve.js";

const cwd = process.argv[2] || process.cwd();
const cfg = loadAflConfig();
if (!cfg.authToken) { console.error("✗ ANTHROPIC_AUTH_TOKEN unset"); process.exit(2); }

const CARDS = [
  { title: "Atualizar número de WhatsApp da MagLink no sistema (substituir número pessoal do Vitão)", body: "O número de WhatsApp está hardcoded com o número pessoal; trocar pelo número oficial da MagLink." },
  { title: "Definir e configurar verso da sacola no mockup (default: replicar frente)", body: "Hoje o verso não é tratado; deixar como default o verso replicar a frente, com opção de divergir." },
];

for (const card of CARDS) {
  console.log(`\n🔎 ${card.title}\n`);
  const t0 = Date.now();
  const a = await runResolve({ cfg, cwd, repoFullName: "cold-code-labs/maglink", card, model: "sonnet", onProgress: (n) => process.stdout.write(`   · ${n}\n`) });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n   ── plano (${secs}s · mode=${a.mode}) ──`);
  console.log(`   abordagem: ${a.approach}`);
  for (const s of a.steps) console.log(`   ▸ ${s.title}  →  ${s.touches.join(", ")}`);
  if (a.questions.length) { console.log(`   ❓ dúvidas:`); for (const q of a.questions) console.log(`      - ${q}`); }
}
