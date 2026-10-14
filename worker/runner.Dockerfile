FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl git python3 ripgrep procps && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
USER node
ENV HOME=/home/node
ARG CURSOR_VERSION=2026.10.12-d47ca18
ARG TARGETARCH
RUN case "$TARGETARCH" in amd64) agent_arch=x64 ;; arm64) agent_arch=arm64 ;; *) exit 1 ;; esac && \
    mkdir -p "$HOME/.local/share/cursor-agent/versions/$CURSOR_VERSION" "$HOME/.local/bin" && \
    curl -fsSL "https://downloads.cursor.com/lab/$CURSOR_VERSION/linux/$agent_arch/agent-cli-package.tar.gz" | \
    tar --strip-components=1 -xzf - -C "$HOME/.local/share/cursor-agent/versions/$CURSOR_VERSION" && \
    ln -s "$HOME/.local/share/cursor-agent/versions/$CURSOR_VERSION/cursor-agent" "$HOME/.local/bin/agent"
ENV PATH=/home/node/.local/bin:$PATH
WORKDIR /workspace
ENTRYPOINT ["agent"]
