FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl git python3 ripgrep procps && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
USER node
ENV HOME=/home/node
RUN curl -fsSL https://cursor.com/install -o /tmp/cursor-install.sh && bash /tmp/cursor-install.sh && rm /tmp/cursor-install.sh
ENV PATH=/home/node/.local/bin:$PATH
WORKDIR /workspace
ENTRYPOINT ["agent"]
