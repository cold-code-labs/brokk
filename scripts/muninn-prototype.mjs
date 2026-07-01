#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// Muninn — PROTOTYPE runnable proof (zero-dep, native fetch on node ≥20).
//
// Muninn is Huginn's twin raven: where Huginn (packages/agents/scout/discovery.ts)
// reads a REPO into a brief, Muninn reads a MEETING TRANSCRIPT (from Saga) into a
// list of classified `ajustes` — the front door to the same backlog→approve→plan→
// forge pipeline, fed by what a client SAID instead of by the code.
//
// This .mjs is the runnable PROOF over real transcripts. The durable seed is the
// TypeScript module packages/agents/scout/src/meeting.ts (runs on @brokk/afl); it
// shares this SYSTEM prompt + tool schema verbatim. Kept dep-free here only so it
// executes from ymir with no pnpm install, pointing at the gateway over WireGuard.
//
// Usage:
//   set -a; . scratchpad/gw.env; set +a          # ANTHROPIC_AUTH_TOKEN + model ids
//   ANTHROPIC_BASE_URL=http://10.10.0.2:4000 \
//   node scripts/muninn-prototype.mjs <transcript.md> "<meeting title>" [outfile.json]
// ─────────────────────────────────────────────────────────────────────────────

import { readFile, writeFile } from "node:fs/promises";

const GATEWAY = (process.env.ANTHROPIC_BASE_URL ?? "http://127.0.0.1:4000").replace(/\/$/, "");
const TOKEN = process.env.ANTHROPIC_AUTH_TOKEN ?? "";
const MODEL = process.env.ANTHROPIC_DEFAULT_SONNET_MODEL ?? "claude-sonnet-4-6";
const [transcriptPath, meetingTitle = "Reunião", outfile] = process.argv.slice(2);

if (!TOKEN) { console.error("✗ ANTHROPIC_AUTH_TOKEN unset — source the gateway env first"); process.exit(2); }
if (!transcriptPath) { console.error("✗ usage: muninn-prototype.mjs <transcript> <title> [out.json]"); process.exit(2); }

const SUBMIT_TOOL = {
  name: "submit_ajustes",
  description:
    "Entrega a lista final de ajustes acionáveis extraídos da reunião. Chame EXATAMENTE UMA VEZ, depois de ler a transcrição inteira.",
  input_schema: {
    type: "object",
    properties: {
      reuniao_resumo: { type: "string", description: "1-2 frases: que reunião foi esta e com quem." },
      ajustes: {
        type: "array",
        description: "Cada ajuste acionável no PRODUTO. Ignore papo social, comida, logística de feira, brincadeiras.",
        items: {
          type: "object",
          properties: {
            titulo: { type: "string", description: "Título curto, imperativo. Ex.: 'Etiqueta MagLink no fundo da sacola'." },
            o_que_pediram: { type: "string", description: "O que o cliente pediu, fiel à fala (parafraseie ou cite). Concreto." },
            area: { type: "string", enum: ["mockup", "crm", "ativacoes", "billing", "outro"], description: "Área do produto." },
            tipo: { type: "string", enum: ["bug", "ajuste", "feature", "epico"], description: "bug=defeito; ajuste=tweak pequeno (ex. prompt/default); feature=novo comportamento; epico=frente grande (várias telas/semanas)." },
            disposicao: { type: "string", enum: ["pronto", "discovery", "bloqueado", "deferido"], description: "pronto=escopo claro, é só fazer; discovery=precisa alinhar escopo antes; bloqueado=espera input externo (specs/decisão do cliente); deferido=combinado 'ver depois'." },
            vira_plano: { type: "boolean", description: "false = 1 card solto (ajustes simples/prontos). true = vira Plano com DAG de cards (discovery ou épico)." },
            nota: { type: "string", description: "Só p/ bloqueado/deferido: em que depende ou por que foi adiado. Vazio caso contrário." },
          },
          required: ["titulo", "o_que_pediram", "area", "tipo", "disposicao", "vira_plano"],
        },
      },
      fora_de_escopo: { type: "array", items: { type: "string" }, description: "O que você IGNOROU de propósito (papo fora do produto), para transparência." },
    },
    required: ["reuniao_resumo", "ajustes", "fora_de_escopo"],
  },
};

const SYSTEM = `Você é Muninn, o corvo-memória do Brokk. Onde Huginn sobrevoa o código, você lê o que foi DITO numa reunião de cliente e devolve os ajustes acionáveis.

Você recebe a transcrição de UMA reunião (pode ter ruído de fala, sobreposição, papo social). Sua tarefa:
1. Ler a transcrição inteira.
2. Extrair SÓ o que é acionável no PRODUTO — pedidos de mudança, bugs relatados, features, ajustes de comportamento. Um ajuste = uma tarefa fraseável.
3. Descartar tudo que não é trabalho: papo social, comida, logística da feira, brincadeiras, quem vai chegar que horas. Liste o que descartou em fora_de_escopo.
4. Classificar cada ajuste: area, tipo (bug/ajuste/feature/epico), disposicao (pronto/discovery/bloqueado/deferido), e vira_plano.

Regras de classificação:
- tipo=ajuste para tweaks pequenos (mudar um default, ajustar um prompt, trocar um texto/número hardcoded). tipo=epico para frentes grandes que são várias telas/semanas (ex.: um editor visual novo, automação de WhatsApp ponta-a-ponta) — épico NUNCA é "ajuste fino".
- disposicao=bloqueado quando depende de input externo que ainda não veio (specs técnicas do cliente, uma decisão de negócio dele). disposicao=deferido quando as partes disseram explicitamente "vemos depois / pós-feira".
- vira_plano=true SE tipo=epico OU disposicao=discovery (precisa quebrar em vários passos). vira_plano=false para ajustes simples e prontos (viram 1 card direto).
- NÃO crie ajuste para itens bloqueado/deferido de leve — inclua-os, mas com disposicao correta e uma nota; o pipeline os trata como nota, não como card.

Seja fiel: cada ajuste tem que estar ancorado em algo REAL que foi dito. Não invente. Não repita o mesmo ajuste. Responda em português. Chame submit_ajustes exatamente uma vez.`;

const transcript = await readFile(transcriptPath, "utf8");

const body = {
  model: MODEL,
  max_tokens: 8000,
  system: SYSTEM,
  tools: [SUBMIT_TOOL],
  tool_choice: { type: "tool", name: "submit_ajustes" },
  messages: [
    { role: "user", content: `Reunião: "${meetingTitle}".\n\nTranscrição a seguir. Extraia e classifique os ajustes.\n\n---\n${transcript}` },
  ],
};

console.log(`🐦‍⬛ Muninn → "${meetingTitle}"`);
console.log(`   transcript: ${transcriptPath} (${transcript.length} chars)`);
console.log(`   gateway: ${GATEWAY}   model: ${MODEL}\n`);

const t0 = Date.now();
const res = await fetch(`${GATEWAY}/v1/messages`, {
  method: "POST",
  headers: { authorization: `Bearer ${TOKEN}`, "anthropic-version": "2023-06-01", "content-type": "application/json" },
  body: JSON.stringify(body),
});
if (!res.ok) { console.error(`✗ gateway HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`); process.exit(1); }
const data = await res.json();
const secs = ((Date.now() - t0) / 1000).toFixed(1);

const toolUse = (data.content ?? []).find((b) => b.type === "tool_use" && b.name === "submit_ajustes");
if (!toolUse) { console.error(`✗ no submit_ajustes in response: ${JSON.stringify(data).slice(0, 400)}`); process.exit(1); }
const out = toolUse.input;

const ICON = { pronto: "✅", discovery: "🔎", bloqueado: "⛔", deferido: "🕓" };
console.log(`──────── AJUSTES (${secs}s · ${data.usage?.input_tokens}→${data.usage?.output_tokens} tok) ────────`);
console.log(`resumo: ${out.reuniao_resumo}\n`);
const cards = out.ajustes.filter((a) => a.disposicao !== "bloqueado" && a.disposicao !== "deferido");
const notes = out.ajustes.filter((a) => a.disposicao === "bloqueado" || a.disposicao === "deferido");
console.log(`CARDS (${cards.length}):`);
for (const a of out.ajustes) {
  if (a.disposicao === "bloqueado" || a.disposicao === "deferido") continue;
  console.log(`  ${ICON[a.disposicao]} [${a.area}/${a.tipo}]${a.vira_plano ? " 📋plano" : ""}  ${a.titulo}`);
}
console.log(`\nNOTAS — não viram card (${notes.length}):`);
for (const a of notes) console.log(`  ${ICON[a.disposicao]} [${a.area}/${a.tipo}]  ${a.titulo}${a.nota ? ` — ${a.nota}` : ""}`);
console.log(`\nfora de escopo ignorado (${out.fora_de_escopo.length}): ${out.fora_de_escopo.join(" · ")}`);

if (outfile) { await writeFile(outfile, JSON.stringify(out, null, 2)); console.log(`\n→ ${outfile}`); }
