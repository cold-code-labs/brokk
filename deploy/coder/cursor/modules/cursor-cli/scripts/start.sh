#!/bin/bash

set -o errexit
set -o pipefail

command_exists() {
  command -v "$1" > /dev/null 2>&1
}

ARG_AI_PROMPT=$(echo -n "${ARG_AI_PROMPT:-}" | base64 -d)
ARG_FORCE=${ARG_FORCE:-false}
ARG_MODEL=${ARG_MODEL:-}
ARG_OUTPUT_FORMAT=${ARG_OUTPUT_FORMAT:-json}
ARG_MODULE_DIR_NAME=${ARG_MODULE_DIR_NAME:-.cursor-cli-module}
ARG_FOLDER=${ARG_FOLDER:-$HOME}

echo "--------------------------------"
echo "install: $ARG_INSTALL"
echo "version: $ARG_VERSION"
echo "folder: $ARG_FOLDER"
echo "ai_prompt: $ARG_AI_PROMPT"
echo "force: $ARG_FORCE"
echo "model: $ARG_MODEL"
echo "output_format: $ARG_OUTPUT_FORMAT"
echo "module_dir_name: $ARG_MODULE_DIR_NAME"
echo "folder: $ARG_FOLDER"
echo "--------------------------------"

mkdir -p "$HOME/$ARG_MODULE_DIR_NAME"

# Find cursor agent cli
if command_exists cursor-agent; then
  CURSOR_CMD=cursor-agent
elif [ -x "$HOME/.local/bin/cursor-agent" ]; then
  CURSOR_CMD="$HOME/.local/bin/cursor-agent"
else
  echo "Error: cursor-agent not found. Install it or set install_cursor_cli=true."
  exit 1
fi

# Ensure working directory exists
if [ -d "$ARG_FOLDER" ]; then
  cd "$ARG_FOLDER"
else
  mkdir -p "$ARG_FOLDER"
  cd "$ARG_FOLDER"
fi

ARGS=()

# global flags
if [ -n "$ARG_MODEL" ]; then
  ARGS+=("--model" "$ARG_MODEL")
fi
if [ "$ARG_FORCE" = "true" ]; then
  ARGS+=("-f")
fi

if [ -n "$ARG_AI_PROMPT" ]; then
  printf "AI prompt provided\n"
  # VENDORIZADO. O upstream so pede "report your progress", e na pratica o agente
  # emite um `working` no meio e termina calado — a task fica marcada como
  # rodando para sempre no painel, porque o Coder segue exibindo o ultimo estado
  # reportado. A exigencia do estado FINAL precisa estar aqui, no prompt, e nao
  # so no rules_files: e a primeira coisa que ele le. Medido em 21/08.
  ARGS+=("Complete the task at hand in one go. Report progress with the coder_report_task tool as you go. YOUR FINAL ACTION, immediately before your closing message, MUST be a coder_report_task call with state=complete (or state=failure if you could not finish) and a one-line summary of what changed — do not end your turn without it. Your task at hand: $ARG_AI_PROMPT")
fi

# Log and run in background, redirecting all output to the log file
printf "Running: %q %s\n" "$CURSOR_CMD" "$(printf '%q ' "${ARGS[@]}")"

# VENDORIZADO. Upstream crava --term-width 67, e o painel de chat da task
# espelha a tela do TUI literalmente: com 67 colunas todo diff e toda saida de
# comando quebra em linha curta e vira um muro de texto. 110 e o suficiente para
# um diff caber sem quebrar. Nao filtra o eco de ferramenta — nao ha opcao para
# isso nem no cursor-agent (a doc so expoe 4 booleanos de display, todos ja em
# false aqui) nem no agentapi.
agentapi server --type cursor --term-width 110 --term-height 1190 -- "$CURSOR_CMD" "${ARGS[@]}"
