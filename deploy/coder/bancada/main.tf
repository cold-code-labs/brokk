/**
 * Bancada — the hot environment (ADR 0100).
 *
 * One Coder workspace per (project, lane): the checkout, the dev server with
 * HMR, the AI agent that edits it and the browser that verifies it, in the same
 * box. Everything it needs to know is handed in by Brokk as a parameter — this
 * file never guesses a command, a port or a credential.
 *
 * Push a new version:
 *   coder templates push bancada -d deploy/coder/bancada --yes \
 *     --variable claude_oauth=… --variable docker_host=… --variable ssh_key=…
 *
 * The workspaces run on the FLEET host (surtr), not on the Coder host: the
 * Coder server lives on the bastion, which has 4 vCPU and is the single way in
 * for the whole fleet. A dev server compiling there is a fleet-wide outage
 * waiting to happen.
 */

terraform {
  required_providers {
    coder  = { source = "coder/coder" }
    docker = { source = "kreuzwerker/docker" }
  }
}

variable "docker_host" {
  description = "Docker endpoint the workspaces are provisioned on (ssh://root@10.10.0.2 = surtr over WireGuard)."
  type        = string
  default     = "ssh://root@10.10.0.2"
}

variable "ssh_key" {
  description = "Private key inside the Coder container used to reach docker_host."
  type        = string
  default     = "/home/coder/.ssh/id_surtr"
}

variable "workspace_network" {
  description = "Docker network the workspace joins. Must be the one the Brokk API is on, so a bancada can broker its git credential without leaving the host."
  type        = string
  default     = "coolify"
}

variable "claude_oauth" {
  description = "OAuth token for the Claude Code CLI."
  type        = string
  sensitive   = true
  default     = ""
}

variable "cpus" {
  description = "CPU WEIGHT per bancada (docker cpu_shares, relative — not a hard cap). RAM below is the real ceiling; CPU is shared fairly under contention."
  type        = number
  default     = 2
}

variable "memory_mb" {
  description = "RAM ceiling per bancada, in MiB."
  type        = number
  default     = 3072
}

provider "docker" {
  host = var.docker_host
  ssh_opts = [
    "-i", var.ssh_key,
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "BatchMode=yes",
  ]
}

data "coder_workspace" "me" {}
data "coder_workspace_owner" "me" {}
data "coder_task" "me" {}

# ── the recipe, handed in by the control plane ─────────────────────────────────
# Every one of these comes from Brokk (project + repository + pinned RuntimeSpec).
# Nothing here has a default that could quietly boot the wrong thing.

data "coder_parameter" "repo" {
  name         = "repo"
  display_name = "Repositório (owner/name)"
  type         = "string"
  mutable      = true
}

data "coder_parameter" "branch" {
  name         = "branch"
  display_name = "Branch"
  type         = "string"
  default      = "dev"
  mutable      = true
}

data "coder_parameter" "install_cmd" {
  name         = "install_cmd"
  display_name = "Comando de instalação"
  type         = "string"
  default      = "pnpm install --no-frozen-lockfile"
  mutable      = true
}

# ⚠️ Chega com a porta JÁ RESOLVIDA. Não use $PORT aqui: o Coder expande as env
# do agente como string de shell, e um $PORT inexistente naquele instante vira
# vazio — o vite recebia `--port` sem valor e morria no boot (medido 20/08).
data "coder_parameter" "dev_cmd" {
  name         = "dev_cmd"
  display_name = "Comando do dev server"
  type         = "string"
  mutable      = true
}

data "coder_parameter" "app_root" {
  name         = "app_root"
  display_name = "Subpasta do app (monorepo)"
  type         = "string"
  default      = "."
  mutable      = true
}

data "coder_parameter" "dev_port" {
  name         = "dev_port"
  display_name = "Porta do dev server"
  type         = "number"
  default      = 5173
  mutable      = true
}

data "coder_parameter" "extra_env" {
  name         = "extra_env"
  display_name = "Env extra (JSON) — a lane de dados"
  type         = "string"
  default      = "{}"
  mutable      = true
}

data "coder_parameter" "brokk_url" {
  name         = "brokk_url"
  display_name = "Control plane (interno)"
  type         = "string"
  default      = "http://brokk-api:8789"
  mutable      = true
}

# Segredo próprio da bancada. O Brokk guarda só o sha256; isto aqui é a única
# cópia em claro, e existe para uma coisa só: trocar por um token de git de vida
# curta na hora do push.
data "coder_parameter" "bancada_token" {
  name         = "bancada_token"
  display_name = "Segredo da bancada"
  type         = "string"
  default      = ""
  mutable      = true
  ephemeral    = true
}

# Token de instalação para o CLONE inicial (vida curta, ~1h). Depois disso quem
# responde por credencial é o broker — nada durável fica no container.
data "coder_parameter" "git_token" {
  name         = "git_token"
  display_name = "Token do clone"
  type         = "string"
  default      = ""
  mutable      = true
  ephemeral    = true
}

resource "coder_agent" "main" {
  arch                    = "amd64"
  os                      = "linux"
  startup_script_behavior = "non-blocking"

  # `set -e` de propósito: sem ele um clone recusado seguia adiante e a bancada
  # se declarava PRONTA com a pasta vazia (medido 20/08). Falha tem de gritar.
  startup_script = <<-EOT
    #!/bin/bash
    set -eux
    export HOME=/home/coder
    exec > >(tee -a /tmp/bancada.log) 2>&1
    rm -f /tmp/bancada.done /tmp/bancada.failed
    trap 'echo "FALHOU na linha $LINENO" | tee /tmp/bancada.failed' ERR

    # ── toolchain ─────────────────────────────────────────────────────────────
    if ! command -v node >/dev/null 2>&1; then
      curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
      sudo apt-get install -y nodejs
    fi
    sudo corepack enable || true
    corepack prepare pnpm@9.15.0 --activate || true

    # ── git, sem credencial durável ───────────────────────────────────────────
    # O helper troca o segredo DESTA bancada por um token de instalação de vida
    # curta, a cada operação. Nada de token no disco, nada de token no history:
    # se a bancada morrer, o direito de empurrar morre junto.
    mkdir -p "$HOME/.local/bin"
    cat > "$HOME/.local/bin/brokk-credential" <<'HELPER'
    #!/bin/bash
    # git credential helper — protocolo: lê chave=valor do stdin, responde o par.
    [ "$1" = "get" ] || exit 0
    resp=$(curl -fsS -X POST "$BROKK_URL/bancadas/git-credential" \
      -H 'Content-Type: application/json' \
      -d "{\"token\":\"$BANCADA_TOKEN\"}") || exit 1
    echo "username=$(echo "$resp" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).username))')"
    echo "password=$(echo "$resp" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).password))')"
    HELPER
    chmod +x "$HOME/.local/bin/brokk-credential"
    git config --global credential.helper "$HOME/.local/bin/brokk-credential"
    git config --global user.name  "Brokk"
    git config --global user.email "brokk@coldcodelabs.com"
    git config --global --add safe.directory "$HOME/app"

    # ── checkout ──────────────────────────────────────────────────────────────
    if [ ! -d "$HOME/app/.git" ]; then
      rm -rf "$HOME/app"
      git clone --branch "$LANE_BRANCH" \
        "https://x-access-token:$GIT_TOKEN@github.com/$LANE_REPO.git" "$HOME/app"
      # A URL com token some do remoto no ato: a partir daqui quem responde por
      # credencial é o helper.
      git -C "$HOME/app" remote set-url origin "https://github.com/$LANE_REPO.git"
    else
      git -C "$HOME/app" fetch origin "$LANE_BRANCH"
      git -C "$HOME/app" checkout "$LANE_BRANCH"
      git -C "$HOME/app" pull --ff-only
    fi
    cd "$HOME/app/$APP_ROOT"

    # ── lane de dados ─────────────────────────────────────────────────────────
    if [ "$EXTRA_ENV" != "{}" ]; then
      node -e '
        const e = JSON.parse(process.env.EXTRA_ENV);
        const l = Object.entries(e).map(([k,v]) => k+"="+v).join("\n");
        require("fs").writeFileSync(".env.local", l+"\n");
      '
    fi

    # O agente edita sem pedir aprovação a cada arquivo. É seguro AQUI e só aqui:
    # a bancada é descartável — apagar e recriar reconstrói tudo do git.
    mkdir -p "$HOME/.claude"
    cat > "$HOME/.claude/settings.json" <<'JSON'
    { "permissions": { "defaultMode": "acceptEdits" } }
    JSON

    # ⚠️ O módulo roda o CLI com `--dangerously-skip-permissions`, que abre uma
    # TELA DE AVISO esperando confirmação. Sem aceitar de antemão, o agente fica
    # parado nela: a AgentAPI responde `stable` (parece pronto!) e todo envio de
    # mensagem morre em 500 `failed to wait for screen to stabilize` — medido
    # 20/08. A aceitação mora no ~/.claude.json, e é escrita ANTES do módulo subir.
    node -e '
      const fs = require("fs");
      const f = process.env.HOME + "/.claude.json";
      let j = {};
      try { j = JSON.parse(fs.readFileSync(f, "utf8")); } catch {}
      j.bypassPermissionsModeAccepted = true;
      j.hasCompletedOnboarding = true;
      fs.writeFileSync(f, JSON.stringify(j, null, 2));
    '

    eval "$INSTALL_CMD"

    # ── o navegador que verifica ──────────────────────────────────────────────
    # Cache no volume da home: instala uma vez, sobrevive a restart. Em background
    # porque o agente não precisa dele para começar a editar, e 150MB de download
    # não podem atrasar o "pronto".
    (
      export PLAYWRIGHT_BROWSERS_PATH="$HOME/.cache/ms-playwright"
      if [ ! -d "$PLAYWRIGHT_BROWSERS_PATH" ]; then
        sudo -E npx --yes playwright@1.50.1 install --with-deps chromium \
          && echo "playwright pronto" > /tmp/playwright.done
      else
        echo "playwright em cache" > /tmp/playwright.done
      fi
    ) > /tmp/playwright.log 2>&1 &

    # ── dev server ────────────────────────────────────────────────────────────
    export PORT="$DEV_PORT"
    echo "comando: $DEV_CMD"
    nohup bash -c "cd '$HOME/app/$APP_ROOT' && exec $DEV_CMD" > /tmp/dev.log 2>&1 &

    # Só marca pronta quando o dev server RESPONDE. Processo vivo não prova que
    # serve — é a mesma lição do 502 com container `healthy`.
    for i in $(seq 1 90); do
      if curl -fsS "http://127.0.0.1:$DEV_PORT/" >/dev/null 2>&1; then
        echo "bancada pronta $(date -u)" > /tmp/bancada.done; break
      fi
      sleep 2
    done
    test -f /tmp/bancada.done || { echo "dev server nao respondeu" | tee /tmp/bancada.failed; exit 1; }
  EOT

  env = {
    LANE_REPO     = data.coder_parameter.repo.value
    LANE_BRANCH   = data.coder_parameter.branch.value
    APP_ROOT      = data.coder_parameter.app_root.value
    INSTALL_CMD   = data.coder_parameter.install_cmd.value
    DEV_CMD       = data.coder_parameter.dev_cmd.value
    DEV_PORT      = tostring(data.coder_parameter.dev_port.value)
    EXTRA_ENV     = data.coder_parameter.extra_env.value
    BROKK_URL     = data.coder_parameter.brokk_url.value
    BANCADA_TOKEN = data.coder_parameter.bancada_token.value
    GIT_TOKEN     = data.coder_parameter.git_token.value
    # O módulo do Claude Code instala o CLI e escreve ~/.claude.json, mas NÃO
    # persiste o token como variável — sem isto qualquer shell do workspace
    # responde "Not logged in · Please run /login" (medido 20/08).
    CLAUDE_CODE_OAUTH_TOKEN   = var.claude_oauth
    PLAYWRIGHT_BROWSERS_PATH  = "/home/coder/.cache/ms-playwright"
  }

  metadata {
    display_name = "Dev server"
    key          = "dev"
    script       = "curl -fsS http://127.0.0.1:${data.coder_parameter.dev_port.value}/ >/dev/null && echo rodando || echo parado"
    interval     = 15
    timeout      = 5
  }

  metadata {
    display_name = "Navegador"
    key          = "browser"
    script       = "test -f /tmp/playwright.done && echo pronto || echo instalando"
    interval     = 30
    timeout      = 5
  }
}

# subdomain = false → URL por CAMINHO. Sem isso o Coder exigiria
# CODER_WILDCARD_ACCESS_URL e um certificado de 3º nível — exatamente o custo
# que travou `<app>.brokk.coldcodelabs.com`.
resource "coder_app" "bancada" {
  agent_id     = coder_agent.main.id
  slug         = "bancada"
  display_name = "Bancada (HMR)"
  url          = "http://localhost:${data.coder_parameter.dev_port.value}"
  icon         = "/icon/widgets.svg"
  subdomain    = false
  share        = "authenticated"
  healthcheck {
    url       = "http://localhost:${data.coder_parameter.dev_port.value}/"
    interval  = 10
    threshold = 30
  }
}

module "claude_code" {
  source  = "registry.coder.com/coder/claude-code/coder"
  version = "4.9.2"

  agent_id = coder_agent.main.id
  # workdir pré-cria a pasta e pré-aceita o diálogo de confiança do Claude Code
  # para ela — sem isto o agente para na primeira pergunta interativa.
  workdir = "/home/coder/app"

  claude_code_oauth_token = var.claude_oauth
  ai_prompt               = data.coder_task.me.prompt
}

# Exigido para a aba Tasks aceitar esta bancada. Sem ele: "Template does not have
# a valid coder_ai_task resource" (HTTP 400 no POST /tasks, medido 20/08).
resource "coder_ai_task" "task" {
  count  = data.coder_workspace.me.start_count
  app_id = module.claude_code.task_app_id
}

resource "docker_volume" "home" {
  name = "coder-${data.coder_workspace.me.id}-home"
  lifecycle { ignore_changes = all }
}

resource "docker_container" "workspace" {
  count      = data.coder_workspace.me.start_count
  image      = "codercom/enterprise-base:ubuntu"
  name       = "bancada-${data.coder_workspace_owner.me.name}-${lower(data.coder_workspace.me.name)}"
  hostname   = data.coder_workspace.me.name
  entrypoint = ["sh", "-c", coder_agent.main.init_script]
  env        = ["CODER_AGENT_TOKEN=${coder_agent.main.token}"]

  # Sem reaper, um `pnpm` que morre deixa zumbi atrás de zumbi até o container
  # bater no limite de PIDs — a bancada roda MUITO processo filho.
  init = true

  cpu_shares = var.cpus * 1024
  memory     = var.memory_mb

  networks_advanced { name = var.workspace_network }

  volumes {
    container_path = "/home/coder"
    volume_name    = docker_volume.home.name
    read_only      = false
  }
}
