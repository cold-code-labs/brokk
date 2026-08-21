# `cursor` — bancada de uso livre, dirigida pelo Cursor CLI

Irmã da [`bancada`](../bancada). Mesma ideia — um workspace por trabalho, com
checkout, dev server, agente e preview no mesmo lugar — com duas diferenças
deliberadas:

- o agente é o **`cursor-agent`** (modelo `auto`), não o Claude Code;
- **nada aqui vem do Brokk.** Você abre a aba Tasks, escolhe o projeto num
  preset, digita o comando e ele executa. Sem card, sem lane, sem RuntimeSpec.

O ciclo fecha em PR: preset → clone → `install` → dev server → você manda o
comando → preview ao vivo → branch, commit, push e `gh pr create`.

## Publicar uma versão

```sh
coder templates push cursor -d deploy/coder/cursor --yes \
  --variable cursor_api_key=…  \
  --variable github_token=…
```

Os dois segredos vivem no Ice Vault:

| variável | bucket | nome |
|---|---|---|
| `cursor_api_key` | `llm-gateway` | `cursor_api_key` |
| `github_token`   | `GitHub`     | `GitHub Token fine-grained (Ice Breaker repos)` = PAT `heimdall-ice-breaker` |

## Fixar um projeto novo

Um bloco `coder_workspace_preset` por projeto. Os valores são os mesmos campos
que o Brokk preenche na `bancada` — dá para lê-los de uma bancada existente:

```sh
coder-db psql -U coder -d coder -c "select name, value from workspace_build_parameters …"
```

> ⚠️ **Projeto cujo `extra_env` carrega segredo não entra aqui.** Preset é valor
> literal no template versionado. Pior: `coder_parameter` **não tem flag de
> sensível** — o campo não existe no schema — e o valor volta limpo pela API.
> O `logcheck-dev` expõe hoje um `DATABASE_URL` com senha desse jeito. Para
> esses, o env precisa ser servido em runtime (endpoint do Brokk, como o
> `git-credential`) ou buscado do Vault pelo startup.

## Armadilhas medidas (20/08/2026)

Todas falham em **silêncio** — a task fica `active`/`healthy=false` para sempre,
sem erro em log nenhum. Estão resolvidas no `main.tf`; a lista existe para
ninguém "simplificar" e reintroduzir.

1. **Trust do Cursor.** O `cursor-agent` para num diálogo TUI *"Workspace Trust
   Required"* esperando alguém apertar `a`. O módulo não expõe `--trust`, mas o
   trust é um arquivo-marcador: `~/.cursor/projects/<path-com-hifens>/.workspace-trusted`.
   Só `pre_install_script` roda antes do CLI subir.

2. **`coder` fora do PATH.** O binário é extraído num `/tmp/coder.XXXX`
   aleatório. Sem symlink em `~/.local/bin`, o MCP `coder_report_task` morre com
   `coder: not found` e a task nunca reporta status no chat.

3. **`agentapi_subdomain`.** O `cursor-cli` 0.3.0 usa `agentapi` 2.0.0, cujo
   default virou `true`, e não expõe o input. Por isso o módulo está
   **vendorizado** em `modules/cursor-cli` — o único delta em relação ao
   upstream é `agentapi_subdomain = false`. (O módulo do Claude Code escapa
   porque usa um agentapi mais antigo.)

4. **Preview precisa de subdomínio.** Dev server tipo Vite serve caminho
   **absoluto** (`/@vite/client`, `/src/main.tsx`). Servido por caminho, esses
   `/...` saem da raiz do Coder e a página abre **preta**. Ver a seção de rede.

5. **PR precisa de `pull_requests: write`.** O PAT tinha só Administration,
   Contents e Metadata; `gh pr create` morria com *"Resource not accessible by
   personal access token"* e o agente queimava contexto depurando.

## Rede — por que os apps saem no wildcard da raiz

Configuração viva: `CODER_WILDCARD_ACCESS_URL="*.coldcodelabs.com"` em
`surtr:/opt/coder/docker-compose.yaml`, rota em
`surtr:/data/coolify/proxy/dynamic/coder-apps.yaml`.

- O Coder separa os campos do host com `--` justamente para caber em **um** nível
  de DNS, que é tudo que um wildcard cobre. O Universal SSL da Cloudflare já
  serve — não precisa de ACM.
- **O campo do agente some quando o workspace tem um agente só**: o host real é
  `<app>--<workspace>--<owner>`, três campos. Regex fixo em quatro devolve 404
  no redirect de auth.
- 🔴 **Não usar `*.preview.coldcodelabs.com`**, apesar de ter cert e ser onde
  moram as bancadas: há uma **Transform Rule na Cloudflare** escopada nesse
  domínio que reescreve o `Content-Security-Policy` para
  `frame-ancestors 'self' https://brokk.coldcodelabs.com`. Ela sobrescreve o que
  o Traefik devolve — o header sai certo do proxy e chega trocado no navegador —
  e o iframe da aba Tasks morre com *"refused to connect"*.
- `priority: 1` na rota, pelo mesmo motivo do `bancadas.yaml`: o Traefik ordena
  por tamanho de regra e um regex longo passaria na frente dos `Host()` exatos
  da frota inteira.

## Adicionar um projeto novo — o que custa de verdade

O preset e oito linhas. O trabalho e descobrir **a credencial de build** do
projeto. Medido ao adicionar o Bragi:

- `pnpm install` morreu em 401 porque o `.npmrc` do repo aponta
  `@cold-code-labs` para `npm.pkg.github.com` com `${NODE_AUTH_TOKEN}`;
- com o PAT classico do Vault virou **403** no `/download/...` do pacote
  `@cold-code-labs/yggdrasil-tokens`. Nenhum dos tres PATs do bucket `GitHub`
  consegue baixa-lo — falta `read:packages` para esse pacote;
- ⚠️ testar `GET /@escopo/pacote` (metadados) **nao** prova nada: da 200 com um
  token que da 403 no `/download/`, que e o que o pnpm usa de verdade.
- O fine-grained nunca serve para GitHub Packages: o registry npm responde 403.

Ou seja: antes de fixar um projeto, rode o `install` dele numa bancada limpa e
veja o que falta. O checklist e curto — registry privado, variavel de build,
env de runtime.

## Autenticacao no preview

O preview da bancada serve para **ver a mudanca**, nao para exercitar login. Dois
caminhos, conforme o app:

- **App com modo de auth falso** — o Arte aceita `VITE_AUTH_MODE` em `stub` ou
  `hauldr`. O preset do Arte ja passa `stub` via `dev_env`, entao o preview sobe
  sem depender de sessao.
- **App atras do Logto** (Bragi) — o host do preview
  (`preview--<workspace>--<owner>.coldcodelabs.com`) **nao** esta nos redirect
  URIs, e o login quebra com `redirect_uri mismatch`. Duas saidas:
  1. `coder port-forward <workspace> --tcp 3000:3000` — o app aparece em
     `http://localhost:3000` na sua maquina, que **ja e** um redirect URI
     registrado. Zero configuracao.
  2. registrar o host do preview como redirect URI na aplicacao do Logto. Vale
     quando varias pessoas forem usar a mesma bancada.

> ⚠️ `dev_env` e para valor **nao-secreto** (feature flag, modo de auth). Nao e
> canal de segredo: parametro do Coder nao tem flag de sensivel e volta limpo
> pela API — a mesma armadilha do `extra_env` descrita acima.

## Ruído no painel de chat

O painel espelha a **tela do terminal do agente**, literalmente — o eco de cada
comando, cada diff, cada saída. Isso não é filtrável:

- o `cursor-agent` expõe só quatro booleanos de display
  (`showLineNumbers`, `showThinkingBlocks`, `showStatusIndicators`,
  `showStatusLineRunningTime`), **todos já em `false`** aqui, mais um
  `mode: "zen"` não documentado. Nenhum esconde saída de ferramenta;
- o `agentapi server --help` não tem flag de filtro, e o rodapé
  *"Switch to Control mode…"* é parte da UI embutida dele.

O que dá para fazer, e está feito:

1. **`--term-width 110`** no `modules/cursor-cli/scripts/start.sh`. O upstream
   crava **67**, e com 67 colunas todo diff quebra em linha curta e vira um muro.
   É a diferença visual maior.
2. **Regra de concisão** no `rules_files`: resposta final em até 3 linhas, sem
   repetir diff nem narrar passo a passo — o terminal logo acima já mostrou.
   Medido: a resposta final caiu de parágrafo com diffs para uma linha.

Se o chat limpo passar a valer mais que usar o Cursor, o caminho é trocar o
agente: o `agentapi` tem parser próprio por tipo de agente, e a `bancada` (Claude
Code) não sofre disso do mesmo jeito.

## Dívida conhecida

- **`github_token` é andaime.** É um PAT durável entregue a toda bancada deste
  template. O certo é o **External Auth** do Coder: token por usuário, buscado
  em runtime, commits com a autoria de quem pediu. Custa quatro variáveis no
  servidor e um restart — que é uma janela no runtime do Brokk, por isso ficou
  para depois.
- **Partida de ~2 minutos** (clone + `install` a cada task). Prebuilds é
  recurso Premium e a instância não tem licença; o caminho aberto é assar
  `cursor-agent`, agentapi e toolchain numa imagem, como já se faz com a
  `coder-ccl`.
- A **`bancada`** ainda usa `subdomain = false` nos apps e sofre do mesmo
  problema de caminho absoluto descrito acima. Agora que o wildcard existe, é
  uma linha.
