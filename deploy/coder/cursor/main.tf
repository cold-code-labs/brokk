/**
 * Cursor — bancada de uso livre, dirigida pelo Cursor CLI (Cursor Auto).
 *
 * Irmã da `bancada` (ADR 0100), com duas diferenças deliberadas:
 *   - o agente é o `cursor-agent`, não o Claude Code;
 *   - nada aqui vem do Brokk. Você digita um comando na aba Tasks e ele executa.
 *     Sem repo, sem lane, sem RuntimeSpec — a bancada nasce vazia.
 *
 * Push a new version:
 *   coder templates push cursor -d deploy/coder/cursor --yes \
 *     --variable cursor_api_key=…   # Ice Vault, bucket `llm-gateway`
 */

terraform {
  required_providers {
    coder  = { source = "coder/coder" }
    docker = { source = "kreuzwerker/docker" }
  }
}

variable "docker_host" {
  description = "Docker endpoint the workspaces are provisioned on — mesmo daemon da surtr, socket local."
  type        = string
  default     = "unix:///var/run/docker.sock"
}

variable "workspace_network" {
  description = "Docker network the workspace joins."
  type        = string
  default     = "coolify"
}

variable "cursor_api_key" {
  description = "API key do Cursor CLI (formato crsr_). Ice Vault, bucket `llm-gateway`, nome `cursor_api_key`."
  type        = string
  sensitive   = true
}

variable "github_token" {
  description = "ANDAIME DE EXPERIMENTO. PAT do valvesss (Heimdall) usado SÓ no clone inicial. Substituir por External Auth do Coder — ver o estudo: parametro não guarda segredo e variável sensível fica em texto puro no Postgres."
  type        = string
  sensitive   = true
  default     = ""
}

variable "cpus" {
  description = "CPU WEIGHT por bancada (cpu_shares, relativo — não é teto duro)."
  type        = number
  default     = 2
}

variable "memory_mb" {
  description = "Teto de RAM por bancada, em MiB. Medido: uma task com o agente trabalhando fica em ~850MiB."
  type        = number
  default     = 3072
}

provider "docker" {
  host = var.docker_host
}

data "coder_workspace" "me" {}
data "coder_workspace_owner" "me" {}
data "coder_task" "me" {}

# ── a receita do projeto ──────────────────────────────────────────────────────
# Mesmos campos que o Brokk preenche na `bancada`. Aqui eles vêm de um PRESET:
# você escolhe "Arte" na aba Tasks e não digita nada disso.

data "coder_parameter" "repo" {
  name         = "repo"
  display_name = "Repositório"
  description  = "owner/nome. Vazio = bancada limpa, sem checkout."
  type         = "string"
  default      = ""
  mutable      = false
}

data "coder_parameter" "branch" {
  name         = "branch"
  display_name = "Branch"
  type         = "string"
  default      = "dev"
  mutable      = false
}

data "coder_parameter" "app_root" {
  name         = "app_root"
  display_name = "Raiz do app"
  description  = "Subpasta dentro do repo onde roda o dev server."
  type         = "string"
  default      = "."
  mutable      = false
}

data "coder_parameter" "install_cmd" {
  name         = "install_cmd"
  display_name = "Instalação"
  type         = "string"
  default      = ""
  mutable      = false
}

data "coder_parameter" "dev_cmd" {
  name         = "dev_cmd"
  display_name = "Dev server"
  type         = "string"
  default      = ""
  mutable      = false
}

data "coder_parameter" "dev_port" {
  name         = "dev_port"
  display_name = "Porta do dev server"
  type         = "number"
  default      = 3000
  mutable      = false
}

# ── projetos fixos ────────────────────────────────────────────────────────────
# Um bloco por projeto. Os valores do Arte foram lidos do `arte-one-dev`, que já
# roda com esta receita. Projeto cujo `extra_env` carrega segredo (logcheck) NÃO
# entra aqui até o segredo sair de parâmetro — ver o estudo.

data "coder_workspace_preset" "arte" {
  name = "Arte"
  parameters = {
    repo        = "cold-code-labs/arte"
    branch      = "dev"
    app_root    = "."
    install_cmd = "pnpm install --no-frozen-lockfile"
    dev_cmd     = "pnpm exec vite --port 5173 --host 0.0.0.0"
    dev_port    = "5173"
  }
}

data "coder_workspace_preset" "limpa" {
  name    = "Bancada limpa"
  default = true
  parameters = {
    repo        = ""
    branch      = "dev"
    app_root    = "."
    install_cmd = ""
    dev_cmd     = ""
    dev_port    = "3000"
  }
}

locals {
  has_repo = data.coder_parameter.repo.value != ""
  # O agente trabalha DENTRO do checkout quando existe um; senão numa pasta solta.
  folder = local.has_repo ? "/home/coder/app" : "/home/coder/projects"
}

resource "coder_agent" "main" {
  arch = "amd64"
  os   = "linux"

  startup_script = <<-EOT
    set -e

    if [ ! -f ~/.init_done ]; then
      cp -rT /etc/skel ~
      touch ~/.init_done
    fi

    mkdir -p ~/projects

    # ── toolchain ─────────────────────────────────────────────────────────────
    # A enterprise-base não traz node. Mesmo caminho da `bancada`: instala uma
    # vez e o volume de home guarda o resto entre builds.
    if ! command -v node >/dev/null; then
      curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
      sudo apt-get install -y nodejs
    fi
    sudo corepack enable || true
    corepack prepare pnpm@9.15.0 --activate || true

    # ── gh, para o agente abrir PR sem inventar chamada de API ────────────────
    if ! command -v gh >/dev/null; then
      curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        | sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg status=none
      echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        | sudo tee /etc/apt/sources.list.d/github-cli.list >/dev/null
      sudo apt-get update -qq && sudo apt-get install -y gh
    fi

    if [ -n "$REPO" ]; then
      # ── git, sem credencial no disco ────────────────────────────────────────
      # O helper responde com o token que está no ambiente do agente. Nada vai
      # para .git/config nem para o history — e o `docker inspect` do workspace
      # não mostra esse env (medido: só CODER_AGENT_TOKEN aparece lá).
      git config --global credential.helper \
        '!f() { echo username=x-access-token; echo password=$GITHUB_TOKEN; }; f'
      git config --global user.name  "$GIT_AUTHOR_NAME"
      git config --global user.email "$GIT_AUTHOR_EMAIL"

      # ── checkout ────────────────────────────────────────────────────────────
      # O token só aparece na URL do clone e some do remoto no ato seguinte —
      # não fica no .git/config nem no history.
      if [ ! -d "$HOME/app/.git" ]; then
        # O modulo do cursor escreve .cursor/ (mcp.json + rules) DENTRO da pasta
        # de trabalho, e nao ha garantia de ordem entre esse script e o dele. Um
        # `rm -rf` seco leva o mcp.json junto — e sem ele o agente perde a
        # ferramenta coder_report_task, passa a falar JSON-RPC na mao e a task
        # fica marcada como rodando para sempre. Medido em 21/08.
        # `[ -d x ] && cp` com set -e aborta o script quando o teste da falso —
        # e na primeira build .cursor nao existe. Por isso `if`, nao `&&`.
        KEEP=$(mktemp -d)
        if [ -d "$HOME/app/.cursor" ]; then cp -a "$HOME/app/.cursor" "$KEEP/"; fi
        rm -rf "$HOME/app"
        git clone --branch "$BRANCH" \
          "https://x-access-token:$GITHUB_TOKEN@github.com/$REPO.git" "$HOME/app"
        if [ -d "$KEEP/.cursor" ]; then cp -a "$KEEP/.cursor" "$HOME/app/"; fi
        rm -rf "$KEEP"
        git -C "$HOME/app" remote set-url origin "https://github.com/$REPO.git"
      else
        git -C "$HOME/app" fetch origin "$BRANCH" && git -C "$HOME/app" checkout "$BRANCH"
      fi
      git config --global --add safe.directory "$HOME/app"

      cd "$HOME/app/$APP_ROOT"
      if [ -n "$INSTALL_CMD" ]; then eval "$INSTALL_CMD"; fi
      if [ -n "$DEV_CMD" ]; then
        nohup sh -c "$DEV_CMD" >/tmp/dev.log 2>&1 &
      fi
    else
      # Bancada limpa: serve ~/projects como estático, para o preview ter o que
      # mostrar assim que o agente escrever um html.
      if ! curl -sfo /dev/null "http://localhost:$DEV_PORT"; then
        nohup python3 -m http.server "$DEV_PORT" --directory ~/projects >/tmp/preview.log 2>&1 &
      fi
    fi
  EOT

  env = {
    GIT_AUTHOR_NAME     = coalesce(data.coder_workspace_owner.me.full_name, data.coder_workspace_owner.me.name)
    GIT_AUTHOR_EMAIL    = data.coder_workspace_owner.me.email
    GIT_COMMITTER_NAME  = coalesce(data.coder_workspace_owner.me.full_name, data.coder_workspace_owner.me.name)
    GIT_COMMITTER_EMAIL = data.coder_workspace_owner.me.email

    REPO         = data.coder_parameter.repo.value
    BRANCH       = data.coder_parameter.branch.value
    APP_ROOT     = data.coder_parameter.app_root.value
    INSTALL_CMD  = data.coder_parameter.install_cmd.value
    DEV_CMD      = data.coder_parameter.dev_cmd.value
    DEV_PORT     = tostring(data.coder_parameter.dev_port.value)
    GITHUB_TOKEN = var.github_token
    GH_TOKEN     = var.github_token
  }

  metadata {
    display_name = "Agente"
    key          = "agente"
    script       = "curl -fsS http://127.0.0.1:3284/status 2>/dev/null | grep -oE 'stable|running' || echo fora"
    interval     = 20
    timeout      = 5
  }

  metadata {
    display_name = "Preview"
    key          = "preview"
    script       = "curl -fsS http://127.0.0.1:${data.coder_parameter.dev_port.value}/ >/dev/null && echo rodando || echo parado"
    interval     = 15
    timeout      = 5
  }

  metadata {
    display_name = "RAM"
    key          = "ram"
    script       = "coder stat mem"
    interval     = 20
    timeout      = 5
  }
}

# subdomain = true. Dev server serve caminho ABSOLUTO (/@vite/client,
# /src/main.tsx); por CAMINHO esses paths saem da raiz do Coder e a página abre
# preta — medido em 20/08 no preview do Arte. Por SUBDOMÍNIO o app tem host
# próprio e o caminho absoluto resolve. Custo zero: reusa o wildcard das
# bancadas (`*.preview.coldcodelabs.com`), que já tem cert.
resource "coder_app" "preview" {
  agent_id     = coder_agent.main.id
  slug         = "preview"
  display_name = "Preview"
  url          = "http://localhost:${data.coder_parameter.dev_port.value}"
  icon         = "/emojis/1f50e.png"
  subdomain    = true
  share        = "authenticated"
  healthcheck {
    url       = "http://localhost:${data.coder_parameter.dev_port.value}/"
    interval  = 10
    threshold = 30
  }
}

# Quarta aba da task: o código. Junto do chat, do preview e do terminal, para a
# task inteira caber num link só.
module "code_server" {
  count    = data.coder_workspace.me.start_count
  source   = "registry.coder.com/coder/code-server/coder"
  version  = "~> 1.0"
  agent_id = coder_agent.main.id
  folder   = local.folder
  order    = 2
}

# Deixa o `coder` CLI autenticado dentro da bancada. É ele que o MCP de status
# usa para reportar progresso — sem isso a task roda mas o chat fica mudo.
module "coder_login" {
  count    = data.coder_workspace.me.start_count
  source   = "registry.coder.com/coder/coder-login/coder"
  version  = "1.0.31"
  agent_id = coder_agent.main.id
}

module "cursor_cli" {
  count    = data.coder_workspace.me.start_count
  # Vendorizado em ./modules/cursor-cli — ver o comentario la dentro: o unico
  # delta e' `agentapi_subdomain = false`, sem o qual o painel de chat da task
  # exige wildcard e nao abre.
  source   = "./modules/cursor-cli"
  agent_id = coder_agent.main.id
  folder   = local.folder

  install_cursor_cli = true
  model              = "auto"
  api_key            = var.cursor_api_key
  ai_prompt          = data.coder_task.me.prompt

  # Duas correções que o módulo não faz, ambas medidas em 20/08 numa instância
  # local. As duas falham em SILÊNCIO: a task fica `active`/`healthy=false` para
  # sempre, sem erro em log nenhum.
  #
  # 1. O cursor-agent para num diálogo TUI "Workspace Trust Required" esperando
  #    alguém apertar `a`. O módulo não expõe a flag `--trust`, mas o trust é só
  #    um arquivo-marcador — dá para pré-criar.
  # 2. O binário do `coder` é extraído num /tmp/coder.XXXX aleatório que não
  #    entra no PATH do cursor-agent. Sem ele o MCP `coder_report_task` morre
  #    com "coder: not found" e nada é reportado no chat.
  #
  # `pre_install_script` é o único gancho que roda antes do CLI subir.
  # O agente lê isto antes de agir. Sem a regra ele commita direto na branch de
  # trabalho, que aqui e' a `dev` de um projeto real.
  rules_files = {
    "fluxo.mdc" = <<-RULES
      ---
      description: Como entregar trabalho nesta bancada
      alwaysApply: true
      ---

      - NUNCA faca commit ou push direto na branch base (`dev` ou `main`).
      - Ao terminar uma alteracao que o usuario pediu para entregar: crie uma
        branch `coder/<descricao-curta>`, commit com mensagem no imperativo, e
        `git push -u origin` nessa branch.
      - Depois do push, abra o PR: `gh pr create --fill --base dev --draft`
        e devolva a URL do PR na resposta. O token da bancada tem
        `pull_requests: write` desde 20/08 — antes disso a chamada morria com
        "Resource not accessible by personal access token".
      - Se o usuario nao pediu para entregar, apenas edite: o preview ao vivo
        na porta do dev server ja mostra o resultado.

      ## Como responder

      O painel de chat espelha seu terminal inteiro, entao o que voce escreve
      aparece no meio do eco de cada comando. Escreva para quem so vai ler as
      ultimas linhas:

      - Resposta final em ATE 3 linhas, em portugues, dizendo o que mudou —
        nao como voce descobriu.
      - NAO repita diff, trecho de arquivo ou saida de comando na resposta:
        isso ja apareceu no terminal logo acima.
      - NAO narre o passo a passo ("vou procurar...", "agora vou editar...").
        Trabalhe calado e responda no fim.
      - Se entregou, a ultima linha e a URL do PR, sozinha.

      ## Fechar a task (obrigatorio)

      A ULTIMA acao antes de responder e sempre `coder_report_task` com estado
      `complete` (ou `failure`, se nao deu). Sem isso a task fica marcada como
      rodando para sempre no painel — o agente termina, responde, e o Coder
      continua exibindo o ultimo estado intermediario. Reportar `working` no
      meio e opcional; reportar o estado final NAO e.
    RULES
  }

  pre_install_script = <<-EOT
    #!/usr/bin/env bash
    set -euo pipefail

    slug=$(echo "${local.folder}" | sed 's|^/||; s|/|-|g')
    mkdir -p "$HOME/.cursor/projects/$slug"
    touch "$HOME/.cursor/projects/$slug/.workspace-trusted"

    mkdir -p "$HOME/.local/bin"
    CODER_BIN=$(command -v coder || true)
    if [ -z "$CODER_BIN" ]; then
      CODER_BIN=$(ls -d /tmp/coder.*/coder 2>/dev/null | head -1)
    fi
    if [ -n "$CODER_BIN" ]; then
      ln -sf "$CODER_BIN" "$HOME/.local/bin/coder"
    fi
  EOT
}

# Exigido para a aba Tasks aceitar este template. Sem ele: "Template does not
# have a valid coder_ai_task resource".
resource "coder_ai_task" "task" {
  count  = data.coder_workspace.me.start_count
  app_id = module.cursor_cli[count.index].task_app_id
}

resource "docker_volume" "home" {
  name = "coder-${data.coder_workspace.me.id}-home"
  lifecycle { ignore_changes = all }
}

resource "docker_container" "workspace" {
  count      = data.coder_workspace.me.start_count
  image      = "codercom/enterprise-base:ubuntu"
  name       = "cursor-${data.coder_workspace_owner.me.name}-${lower(data.coder_workspace.me.name)}"
  hostname   = data.coder_workspace.me.name
  entrypoint = ["sh", "-c", coder_agent.main.init_script]
  env        = ["CODER_AGENT_TOKEN=${coder_agent.main.token}"]

  init = true

  cpu_shares = var.cpus * 1024
  memory     = var.memory_mb

  networks_advanced { name = var.workspace_network }

  volumes {
    container_path = "/home/coder"
    volume_name    = docker_volume.home.name
    read_only      = false
  }

  labels {
    label = "coder.owner"
    value = data.coder_workspace_owner.me.name
  }
  labels {
    label = "coder.workspace_id"
    value = data.coder_workspace.me.id
  }
  labels {
    label = "coder.workspace_name"
    value = data.coder_workspace.me.name
  }
}
