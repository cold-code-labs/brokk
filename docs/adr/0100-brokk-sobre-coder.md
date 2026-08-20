---
adr: "0100"
titulo: "Brokk sobre Coder — control plane em cima de um runtime de verdade"
status: aceito
data: 2026-08-20
supersede: ["0017 (lane de preview do forge)", "0038 (preview host por app)", "parte do 0027 §3.3"]
---

# 0100 — Brokk sobre Coder

## O que muda, em uma frase

**Brokk decide e coordena → Coder cria o ambiente → o agente constrói → o
navegador verifica → Coder expõe → Brokk mostra o resultado.**

O Brokk deixa de ser dono do runtime. Ele não mantém mais checkout em disco, não
sobe `next dev` como processo filho, não tem enclave de gVisor e não proxia
subdomínio para porta. Passa a fazer o que só ele pode fazer: identidade,
organizações, permissão, projetos, orquestração de agente, git, ferramentas,
uso e cobrança.

## As camadas

| Camada | Quem é | Responsabilidade |
|---|---|---|
| Identidade | **Logto** (`auth.coldcodelabs.com`) | quem é, de que organização, com que permissão |
| Control plane | **Brokk** (`brokk.coldcodelabs.com`) | recebe o pedido, decide, escolhe/cria bancada, coordena agente, git, ferramentas, preview, uso, cobrança |
| Runtime | **Coder** (`coder.coldcodelabs.com`) | provisiona e mantém o ambiente onde o agente trabalha |
| Agente | Claude Code (hoje), Codex, Gemini CLI… | constrói dentro da bancada |
| Verificação | **Playwright/Chromium** dentro da bancada | prova que o que foi construído responde |
| Infra | containers docker na **surtr** | onde as bancadas vivem |

O `coder.coldcodelabs.com` é **infra/admin**. O usuário vive dentro do
`brokk.coldcodelabs.com`.

## Quente e frio

A distinção que organiza tudo:

```
arte.coldcodelabs.com          FRIO   prod      main      → build no push, monta o BaaS
arte.preview.coldcodelabs.com  FRIO   preview   preview   → build no push, monta o BaaS
coder.coldcodelabs.com/…       QUENTE bancada   dev       → HMR, agente, navegador
```

**Quente** é onde se trabalha: HMR, agente editando, navegador verificando. Uma
bancada é descartável — apagar e recriar reconstrói tudo do git em segundos.

**Frio** é o que se publica: um artefato construído a partir de um push, com o
BaaS montado junto. Mexer em schema, banco ou sidecar não é coisa de bancada: vai
no commit/push para `preview`, e o ambiente frio se monta.

## Por que não continuar com o runtime próprio

Não foi uma escolha de gosto; foi a soma do que o runtime próprio custava:

- **Um dev server por projeto, no processo do forge.** RAM medida por preview,
  reaper por ociosidade, PID e RSS gravados no banco — o Brokk virou um
  supervisor de processos meia-boca, com um `previews` que carregava `pid`,
  `port` e `rss_mb`.
- **Isolamento caseiro.** N1 allowlist de env, N2 Landlock, N3 uid-split com
  nftables, enclave gVisor com um broker de socket docker (`enclave-manager`).
  Cada camada foi construída para chegar perto do que um workspace já dá de
  fábrica.
- **Um gateway só para preview.** `*.preview.coldcodelabs.com` → `preview-proxy`
  → porta, com chave HMAC `__bk` e certificado de 3º nível. O Coder entrega a
  mesma coisa **por caminho** (`/@owner/ws.main/apps/bancada/`) e o ingress do
  túnel caiu de 10 regras para 3.
- **O número.** Em 30 dias: 258 runs, 196 falhas contra 116 sucessos; em 7 dias,
  UMA sessão de chat. O runtime próprio não estava sendo usado — estava sendo
  mantido.

## As decisões desta ADR

### 1. As bancadas rodam na surtr, não no ymir

O Coder mora no ymir (bastion). As bancadas **não**: o ymir tem 4 vCPU, 7 GB e é
o único caminho de entrada da frota — um `pnpm build` lá dentro cega o acesso a
tudo. O provider docker do template aponta para a surtr por SSH sobre a
WireGuard (`ssh://root@10.10.0.2`).

Quando o serviço for pago pelo usuário, o alvo do provider muda de variável, não
de arquitetura.

### 2. O Brokk é o ÚNICO cliente do Coder

Ninguém precisa de conta no Coder para ser servido pelo Brokk. O control plane
autentica com um token de serviço e é ele quem provisiona, lê status, conversa
com o agente e endereça o preview. A tenancy é a do Brokk (Logto org), não a do
Coder — que no OSS nem tem múltiplas organizações.

⚠️ **Limite conhecido:** o app da bancada está com `share = "authenticated"`, o
que significa "qualquer usuário logado no Coder". Hoje isso é a casa (o Logto do
Coder tem trava de domínio `@coldcodelabs.com`). Multi-tenant de verdade exige
`share = "owner"` + um usuário Coder por org — trabalho seguinte, não desta ADR.

### 3. Credencial de git é BROKERADA, nunca guardada

A bancada nasce com um segredo próprio. O Brokk guarda só o `sha256`. Na hora do
push, um `credential.helper` troca esse segredo por um token de instalação de
vida curta.

Consequência que importa: **uma bancada apagada perde o direito de empurrar.**
Não existe token durável dentro do container, nem no `.git/config`, nem no
history do shell. A URL com token usada no clone inicial é reescrita no ato.

### 4. A receita vem do control plane, sempre

`repo`, `branch`, `install`, `dev`, `appRoot`, porta e env são **parâmetros**
entregues pelo Brokk a partir do `RuntimeSpec` fixado no projeto. O template não
adivinha nada.

Duas regras que viraram teste (medidas em 20/08/2026):

1. **`$PORT` é resolvido no control plane.** O Coder expande a env do agente como
   string de shell; um `$PORT` que sobra no comando vira vazio antes do startup
   rodar — o vite recebia `--port` sem valor e morria no boot.
2. **Projeto sem runtime fixado é recusado.** Adivinhar o comando de dev é como a
   bancada nasce quebrada e ainda se declara pronta.

### 5. Pronta = o dev server RESPONDE

O startup só grava `/tmp/bancada.done` depois de um `curl` bem-sucedido na porta.
Processo vivo não prova que serve — é a mesma lição do 502 com container
`healthy`.

⚠️ E o control plane precisa LER esse sinal. O agente do Coder em modo
`non-blocking` se declara `ready` assim que **conecta**, muito antes de o dev
server existir; lendo só isso, o Brokk anunciava bancada pronta com a página
fora do ar (medido 20/08). Por isso o startup é `blocking` — aí `ready` quer
dizer "o script terminou" e `start_error` quer dizer "ele falhou" — e o
`refresh` ainda confere o healthcheck do próprio app antes de dizer pronta.

### 6. Ociosa é PARADA, não apagada

Uma bancada `ready` sem interação por mais que `BANCADA_IDLE_MS` é parada; o
volume sobrevive, e o próximo `ensure` a traz de volta em segundos em vez de
clonar de novo.

## O que morre

| Peça | Substituída por |
|---|---|
| `apps/forge` (supervisor de preview + worktrees) | workspace do Coder |
| `apps/enclave-manager` (gVisor + socket docker) | isolamento do workspace |
| `apps/preview-proxy` (`*.preview` → porta) | app do Coder por caminho |
| `apps/chat` (Sindri, checkout por sessão) | o agente dentro da bancada |
| `previews.pid` / `.port` / `.rss_mb` | não existem mais neste lado |

## O que fica, e por quê

- **`apps/api`** — o control plane, agora com `/bancadas`.
- **`apps/reviewer` (Eitri)** — revisão de PR não é runtime; roda fora e continua.
- **`packages/afl`** — o kernel que o Eitri usa.
- **A tabela `previews`** — passa a registrar ambiente **frio**, alimentada pelo
  deploy, não por um supervisor.

## Como se prova que está funcionando

1. `POST /bancadas {projectId}` responde com uma bancada `provisioning`.
2. O container aparece na **surtr** (`docker ps | grep bancada-`).
3. `GET /bancadas/:id` chega a `ready` — e `ready` só acontece depois do curl
   interno na porta.
4. A URL do preview responde 200.
5. `POST /bancadas/:id/agent` faz o agente responder dentro da bancada.
6. Um push a partir da bancada funciona **sem** token no disco.

Ver `docs/BANCADA.md` para o runbook.
