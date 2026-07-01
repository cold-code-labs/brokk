# Handoff — Pilar Analysis do Brokk (sessão 2026-07-01)

> Doc pra retomar em outra sessão. Tudo abaixo está **no ar em produção**
> (`brokk.coldcodelabs.com`, app Coolify `mhhtrgxatztqumegd9k00f9v`, nó **surtr**,
> GitHub App branch `main` → auto-deploy). Repo local: `~/ccl/brokk` (na `main`).

---

## 🧪 QA · Recibo de aceite ao vivo (Nv2) — LIVE em v1 (commit `0c1adee`)

**O que é:** depois do verify, se o card deixou `.brokk/acceptance.mjs` no worktree,
o forge **boota o app do cliente numa porta efêmera e roda esse check** contra ele —
verify prova que compila, isto prova que **se comporta**. Recibo = veredito (✅/❌) +
screenshot. Verdict vai no corpo da PR; screenshot vira **run-event `acceptance`** e
renderiza no run-log do board (`AcceptanceRow` em `Board.tsx`). Não commita screenshot
no repo do cliente — só o script rida a PR (verify re-roda ele pra sempre).

**Arquivos:** `apps/forge/src/acceptance.ts` (boot efêmero + CDP + captura),
`apps/forge/src/index.ts` (roda após verify, emite evento, rida no corpo da PR),
`packages/agents/forge/src/prompts.ts` (convenção `.brokk/acceptance.mjs`),
core/db (`acceptance` RunEventType + enum self-heal ALTER), `apps/web/components/Board.tsx`.
Gate proporcional: sem script → pulado. `BROKK_CHROMIUM` default `/usr/bin/chromium`.

**Decisão (Vitor, 2026-07-01): fica em v1** — **advisory, NÃO bloqueia** a run (verify
segue o gate). O screenshot no run-log é o **sinal honesto** e auditável por humano.

**⚠️ Limitação conhecida do v1 (provada ao vivo, PR #27 fechada):** o check que o
agente escreve pode ser **teatro** — `chromium --screenshot` sai 0 mesmo na tela de
login, e o boot do maglink cai no `/login` (esteira é gated por Logto, bootou
`AUTH_MODE=stub`). Resultado: "✅ met" **falso**, screenshot da tela de login. O
screenshot expôs isso na hora (por isso v1 é aceitável advisory).

**Frente deferida — v1.1 (endurecer, quando quiser):**
1. **Prompt:** exigir **assert real via CDP** (achar o elemento no DOM, checar
   computed-style/comportamento, sair ≠0 se ausente) + **click-through do login stub**
   ("Entrar com um clique" existe em `AUTH_MODE=stub` = seam credential-free) +
   **proibir** screenshot-só-como-prova.
2. **Forge:** guarda anti-teatro que rebaixa `met→inconclusivo` quando não houve
   assertion real; depois virar **gate** (bloquear promoção dev→main em ❌).

---

## ✅ RESOLVIDO (sessão 2026-07-01, parte 2) — verify verde de ponta a ponta

O verify do forge estava falhando por **DUAS** causas empilhadas, agora ambas
consertadas:

1. **`--silent` cegava o diagnóstico** → trocado o env `BROKK_VERIFY_CMD` (runtime,
   uuid `mnugpm2znkeyvikdjawuy0r5`, app `mhhtrgxatztqumegd9k00f9v`) de
   `pnpm install --silent && pnpm -r typecheck` para
   `pnpm install --no-frozen-lockfile --prod=false && pnpm -r typecheck` + redeploy.
   Aí o erro real apareceu.
2. **Causa raiz real = pnpm sem TTY** → `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`:
   o pnpm queria purgar um `node_modules` com settings divergentes e, sem TTY na
   sandbox, **abortava** em vez de purgar. Fix no código (`runVerify`,
   `apps/forge/src/index.ts`): o subprocesso de verify roda com **`CI: "true"`**
   no env (commit `693cc1b`, na `main`, deployado). É o que o próprio erro do pnpm
   recomenda. **Fix sistêmico** — vale pra frota inteira, não depende de `.npmrc`
   por-repo.

**Prova:** re-forja do card do scroll → status `review`, **PR #26 verify ✅ passed**
(`pnpm install` completo + `tsc --noEmit` limpo, `Done in 2.9s`). O fix real do card
(`scrollbar-thin`+`overflow-x-scroll` no `esteira-scroll-area.tsx`) já tinha
mergeado na dev via **#23**; #26 só adiciona `scrollbar-gutter: stable` (polish,
aberta pra você decidir). PRs órfãs #22/#25 (verify falho) fechadas + branches
deletadas.

> ⚠️ 1º diagnóstico desta sessão (Playwright pesado quebrando o verify) estava
> **ERRADO** — as runs falhavam idênticas no `pnpm install`, sem tocar Playwright.
> A doutrina de "teste proporcional" (commit `598b796`) continua boa, mas não era
> o culpado.

---

## O que foi construído (6 commits, `801d5c2..a3248c7`)

Pilar **Analysis**: o card de backlog vira um *entendimento vivo e versionado* —
**problema** (título + citações + detalhes) **e plano** — que humano refina.
Fluxo: `Muninn (reunião→evidência) → Resolve (código→plano) → aprovar → forge → PR`.

| Commit | O quê |
|--------|-------|
| `85ef02a` | Superfície do passo Analysis: coluna no board, ação `analyze →`, endpoint chat `/analyze/:taskId` (roda `runResolve` detached), api `/tasks/:id/analysis/approve` (atomic enfileira / feature vira sub-cards), tabela self-heal `card_analyses`, status `analysis` no enum, sdk+core+drawer |
| `e1e47f5` | (2) Resolve **duvida da premissa** (separa verificado-no-código × assumido-runtime → `questions[]`); (1) Muninn **reconcilia o tópico** (estado resolvido, não 1ª fala); (3) **drawer redesenhado** (resumo simples + badges escopo/confiança + premissas elevadas + técnico colapsável) |
| `8654ec0` | Card **versionado**: Resolve emite `revised_title` (conserta título enganoso) + `details` (problema simples) + `evidence` (cura citações verbatim). "**Adicionar Detalhes**" (input humano autoritativo) → regenera v+1. `card_analyses` versionado (revisions jsonb inline), `tasks.evidence`, `setAnalysisStatus`/`beginAnalysisRevision` |
| `632c303` | Endpoint **backfill** Muninn: `POST /muninn/backfill/:projectId` re-roda Muninn num transcript e crava `evidencia` verbatim nos cards por **match de conteúdo** (título muda quando o Muninn conserta, então não dá match por título) |
| `598b796` | Doutrina forge: **teste proporcional** — não instalar test-runner (Playwright etc.) pra fix pequeno; usar o tooling que já existe (`prompts.ts`) |
| `a3248c7` | **Live run log** legível (à la Sindri): narração + tool rows (ícone+arg+ok/erro, colapsável) + pílulas de fase + bloco de verify. `Board.tsx` `RunLog`/`ToolRow`/`PhaseRow`/`LogRow` |

### Validado E2E ao vivo (na maglink, em produção)
- Backfill: 14 cards ganharam evidência verbatim.
- Analyze do card do scroll: v2 com **título corrigido** ("...que some para usuários
  de mouse" — dropou "mousepad"), citações reais ("Da reunião": fala do Vitão + meu
  detalhe + commit `6db8527`), plano atômico (`scrollbar-thin`).
- Aprovar: **título corrigido gravado no card real** + enfileirado.
- Forge: rodou 2x até **PR real** (maglink#22), fix correto — mas **verify falhou**
  (ver PRÓXIMA AÇÃO).

---

## Arquivos tocados (mapa)

- **core** `packages/core/src/index.ts` — `TaskStatus:'analysis'`; `TaskAnalysis`
  (version/revisedTitle/details/evidence/inputDetails/revisions), `AnalysisEvidence`,
  `AnalysisRevision`, `AnalysisStep`; `Task.evidence`
- **scout** `packages/agents/scout/src/` — `resolve.ts` (prompt premissa+runtime,
  revised_title/details/evidence, prior+details+evidence inputs), `meeting.ts`
  (reconciliar tópico + `evidencia` verbatim), `index.ts` (exports)
- **db** `packages/db/src/{index,schema}.ts` — `card_analyses` versionado + `tasks.evidence`
  (self-heal ALTERs em `ensureChatSchema`), store methods, mappers
- **chat** `apps/chat/src/app.ts` — `/analyze/:taskId` (details+prior+evidence, versionado),
  `/muninn/backfill/:projectId`
- **api** `apps/api/src/routes/{tasks,projects}.ts` — approve aplica revisedTitle;
  ajustes-from-meeting grava evidence
- **sdk** `packages/sdk/src/index.ts` — tipos + getAnalysis/approveAnalysis
- **web** `apps/web/{components/Board.tsx,lib/chat.ts,lib/theme.ts}` — coluna,
  AnalysisPanel (título corrigido/citações/Adicionar Detalhes/histórico), RunLog

---

## Cheatsheet operacional

**Alcançar surtr** (alias "surtr" NÃO resolve — usar IP WireGuard):
```bash
ssh -i ~/.ssh/id_surtr root@10.10.0.2
```
Containers têm sufixo de timestamp (mudam a cada deploy). Reachar por IP do container
a partir do host surtr (o `--silent`... digo, a auth web é Logto, curl externo dá 307;
por isso vai-se direto no container):
```bash
# no host surtr:
AP=$(docker ps --format '{{.Names}}' | grep -i '^brokk-api-mhhtrgx')      # api  :8789 (BROKK_API_SECRET)
CH=$(docker ps --format '{{.Names}}' | grep -i '^chat-mhhtrgx')           # chat :8795 (BROKK_RUNNER_SECRET)
IP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' "$AP" | awk '{print $1}')
SEC=$(docker exec "$AP" printenv BROKK_API_SECRET)
curl -s -H "Authorization: Bearer $SEC" "http://$IP:8789/tasks?projectId=<PID>"
```

**IDs úteis:**
- maglink project: `b590c3cb-841d-4fc5-910b-4221e8087c7c`
- card do scroll (task): `8cd75d43-5e45-44a4-b5d1-0c100e33bf3a`
- PR aberto (verify falho): https://github.com/cold-code-labs/maglink/pull/22

**Re-forjar um card** (via api container, contorna auth web):
```bash
curl -s -X POST -H "Authorization: Bearer $SEC" "http://$IP:8789/tasks/<TID>/enqueue"
# poll status: GET /tasks?projectId=<PID> → status running→review/failed, prUrl
# ⚠️ ao re-enfileirar um 'failed', dá um race: o poll pode pegar o 'failed' residual.
#    Guardar "só aceita terminal DEPOIS de ver running".
```

**Rodar backfill Muninn** (payload já montado em
`.../scratchpad/backfill.json` = transcrição `~/ccl/maglink/docs/reunioes/2026-06-30_1_handoff-plataforma.md`):
```bash
cat backfill.json | ssh -i ~/.ssh/id_surtr root@10.10.0.2 \
 "SEC=\$(docker exec \$CH printenv BROKK_RUNNER_SECRET); curl -s -X POST \
  -H \"Authorization: Bearer \$SEC\" -H 'content-type: application/json' \
  --data-binary @- http://\$CHIP:8795/muninn/backfill/<PID>"
```

**Deploy:** push `main` → auto-deploy (GitHub App). Monitorar:
```bash
TOKEN=$(cat ~/.coolify_token)
curl -s -H "Authorization: Bearer $TOKEN" \
 "http://localhost:8000/api/v1/deployments/applications/mhhtrgxatztqumegd9k00f9v?take=1"
```
⚠️ Deploy do Brokk pode dar **flake transitório** no `docker compose up` (`No such
container` num race) — build ok, só re-disparar: `GET /api/v1/deploy?uuid=…`.

**Chrome MCP** (pra dirigir o board, que é gated por Logto): browser já logado
(Vitor Alves, proprietário), deviceId `9f3e3685-a2da-443f-a062-5938cddf204a`.

---

## Gotchas aprendidos nesta sessão

- **Template literal + backticks**: nos prompts do scout (`resolve.ts`/`meeting.ts`),
  crases dentro do template (`` `evidencia` ``) precisam ser escapadas `\``; NÃO
  escapar a crase de fechamento do template.
- **Match de backfill por CONTEÚDO, não título**: o Muninn novo conserta o título,
  então match por título erra justo os cards consertados. Usar sobreposição de tokens.
- **`--silent` no verify cega o diagnóstico** (a PRÓXIMA AÇÃO).
- **Re-enqueue race** no poll (guardar "viu running primeiro").
- **`pnpm -r typecheck` na base do maglink passa verde** (não é workspace) — logo o
  verify que falha é o `pnpm install`, não o typecheck.

---

## Ideias/frentes abertas (não pedidas ainda)
- Empurrar o Resolve a virar premissa duvidosa em `questions[]` com mais força
  (hoje ele às vezes "assume declarando" em vez de perguntar — foi o que aconteceu
  no card do scroll; a suposição estava certa, mas nem sempre estará).
- Rodar o **Muninn novo** numa transcrição limpa pra ver a `evidencia` verbatim
  nascendo na origem (cards novos já vêm com citação boa, sem backfill).
- Estado local: `~/ccl/maglink` foi mexido (checkouts main/dev p/ testar typecheck) —
  conferir/restaurar a branch se for trabalhar nele.
