# Litr — UI refinement backlog (Brokk shell)

**Origem:** crítica detalhada do fundador (2026-07-13) sobre o layout do app Brokk
— "a arquitetura lembra v0/Lovable/Cursor, mas passa sensação de UI feita por
engenheiro; existe muito peso visual distribuído igualmente, o olho não sabe onde
começar." O salto pra nível top-tier é **refinamento**, não features: menos ruído,
mais hierarquia, fluxo do olhar natural.

**Norte (soul "Forge at Night"):** o único calor é o gesto que envia (ember
reservado); escuro, ordenado, quieto. Regra do Linear: **só o elemento ativo tem
contraste; o resto quase desaparece.**

**Benchmarks (ordem do fundador):** v0 (hierarquia + espaço negativo) · Linear
(espaçamento/tipografia/densidade) · Cursor (layout de IDE) · Lovable (simplicidade
IA) · Raycast (consistência de componentes) · Claude Desktop (tipografia + menos ruído).

**Ordem de ataque (o "se eu tivesse 1 dia"):** 1) remover ~40% das bordas · 2)
escala de espaço em múltiplos de 8 · 3) hierarquia tipográfica · 4) contraste no
ativo + reduzir o resto · 5) reorganizar a toolbar em grupos · 6) compactar a
sidebar · 7) unificar radius/ícones/tons de azul.

---

## ✅ Feito (2026-07-13) — passes 1 e 2

Tudo como **override Brokk-local do shell Yggdrasil**, num bloco marcado no fim de
`apps/web/app/globals.css` ("Design-refinement pass") + escalas em `apps/web/app/forge.css`.
Promover ao design system (`~/ccl/yggdrasil`, `yggdrasil-react`) quando assentar.

**Passe 1 — hierarquia + bordas:**
- **#4/#16 estado ativo (regra do Linear):** nav inativo recua p/ `--fg-dim` (peso 450);
  só o ativo fica `--fg` bold + barra de accent (`box-shadow inset 2px --accent`). **#15**
  ícones lucide seguem `currentColor` → dimam junto.
- **#1/#17 menos linhas:** `.ygg-sidebar` sem `border-right` (separa por bg mais fundo
  `#05070c` + `box-shadow 8px 0 22px -14px`); `.brokk-user-plate`/`.brokk-user` sem `border-top`;
  seam `.sindri-preview-bar`/`.sindri-head` em `--line-soft`.
- **#20 section-labels:** `.ygg-nav-group-label` opacity .5, tracking .13em, 0.62rem.
- **#2/#21 fundação:** `.ygg-shell { --sp-1..7: 4/8/12/16/24/32/48; --r-sm:8 --r-md:10 --r-lg:14 }`
  (⚠️ ainda NÃO aplicado componente-a-componente — é só o vocabulário).

**Passe 2 — composer:**
- **#12** `.sindri-chip` (Medium/Sonnet/Sindri) sem borda/bg → embutido, quieto (estilo Claude).
- **#11** `.sindri-input::placeholder` num muted legível.
- **#13/#1** `.sindri-composer` em `--line-soft` + radius 12.

---

## ⬜ Pendente — próximos passes

### Passe 3 — toolbar do preview (app-próprio, `.sindri-*`) · **começar por aqui**
- **#23 agrupar em 3 grupos visuais:** `[view: eye/code/db/env]` · `[browser-chrome:
  device/800px/reload/external]` · `[action: Create PR]`. Os view-toggles já são um pill
  (`.sindri-viewswitch`); replicar o padrão segmentado no browser-chrome; separador antes do action.
- **#9 device-como-tab:** desktop/mobile são `.sindri-preview-icon` (parecem botões soltos) →
  agrupar num segmented control (paradigma único).
- **#9 `800px` é INFO, não botão:** `.sindri-preview-dim` deve ler como readout (muted, tabular,
  sem afford de clique), não como controle.
- **#4 hierarquia:** Create PR já domina (ember); os secundários devem ficar mais quietos ainda.

### Passe 4 — sidebar compaction (Yggdrasil, mas sobrescrevível local)
Seletores já descobertos: `.ygg-sidebar` · `.ygg-nav-link` (ativo via `[aria-current="page"]`)
· `.ygg-nav-group-label` · `.ygg-brand.brokk-brand` (logo, img 22×32) · `.brokk-user-plate` (32px).
- **#5 logo BROKK** ocupa um header inteiro — reduzir ~30% (container/padding do `.ygg-brand`).
- **#6 avatar inferior** (Vitor Alves / PROPRIETÁRIO) muito alto (parece card) → compactar p/
  ~1 linha (avatar + nome + "Owner" pequeno). `PROPRIETÁRIO` → `Owner`, menor.
- **#14 densidade:** mais respiro entre grupos; menos altura por item.
- **#20** já calmo; revisar tracking do uppercase.

### Passe 5 — sistema (auditoria, ripple na frota)
- **#21 radius:** aplicar a escala em TODO componente (hoje mistura 6/8/10/12/14). Sistema alvo:
  cards 12 · inputs 12 · buttons 10 · modals 16. ⚠️ existe `--radius-sm` legado (6px) + `--radius`;
  reconciliar com `--r-*`.
- **#25 azul único:** o azul aparece em `--accent`/`--primary` em tons diferentes (botão +, enviar,
  seleção). Padronizar num `--accent` só.
- **#24 grid 8px:** alinhar elementos a múltiplos de 8 (hoje 11/17/29/15/42 — sem escala). Aplicar `--sp-*`.
- **#2 spacing:** idem — trocar os gaps/paddings soltos pelas `--sp-*`.
- **#18 contraste de superfícies:** os fundos (`#0F1115/#111827/#151922/#171A24`) são próximos demais;
  diferenças pequenas mas **perceptíveis** entre sidebar/chat/preview (hoje o Brokk usa `--bg #07090f`
  / `--panel #0c101a` / sidebar `#05070c` — validar o step).

### Passe 6 — chat, tabs, tipografia, micro
- **#7 largura do chat:** a coluna é larga demais p/ pouca info (ajuste do grid `grid-template-columns`
  ~50/50 em globals.css:322) → dar mais peso ao preview.
- **#8 tabs** (`.sindri-tab`): muito padding horizontal, pouca diferenciação → estilo navegador, compactas.
- **#22 gap chat|preview:** +8~12px de respiro entre os painéis.
- **#3/#19 hierarquia tipográfica:** definir escala clara — section 11/medium · item 14/regular ·
  título 15/semibold · botão 14/semibold · descrição 13/regular. Hoje quase tudo 14/500.
- **#26 microinterações (sem features):** hover 2-3% de luminosidade · transições 120-180ms ·
  focus-ring 2px consistente só em interativos · pressed discreto · cursores coerentes.
- **#10 preview padding:** o painel respira demais no centro (env panel "Environment loaded…" perdido).

---

## Método (como continuar)

Passe é **incremental** (tela já-souled) → dispensa exploração de variantes, mas o **gate de render
real** vale: pré-visualizar injetando CSS no Chrome ao vivo (`<style id="litr-preview">`) ANTES de
commitar; A/B "B melhor que A"; dark **e** light. Vocabulário nos arquivos CSS (`.ygg-*` override +
`.sindri-*` + tokens `forge.css`), nunca `style={{}}` solto. Deploy = push→Gjallarhorn (nunca manual).
Ver `SYSTEM-MAP.md`, `soul.json`, e a memória `brokk-ui-refinement-backlog`.
