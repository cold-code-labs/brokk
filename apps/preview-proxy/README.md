# @brokk/gateway

Wildcard `*.preview` reverse proxy for dev-preview environments.

Each request to `<subdomain>.preview.coldcodelabs.com` is routed by the
leftmost DNS label to the local port of the matching live preview, resolved
from the Brokk control plane.

## One-time infra wiring

> **Humans wire this; no code is required.**

### 1. Cloudflare Tunnel (on surtr)

```
# /etc/cloudflared/config.yml
tunnel: <your-tunnel-id>
credentials-file: /etc/cloudflared/<tunnel-id>.json

ingress:
  - hostname: "*.preview.coldcodelabs.com"
    service: http://localhost:3020
  - service: http_status:404
```

Add a wildcard CNAME in the Cloudflare DNS dashboard:

| Type  | Name                        | Target                          |
|-------|-----------------------------|---------------------------------|
| CNAME | `*.preview.coldcodelabs.com`| `<tunnel-id>.cfargotunnel.com`  |

Proxy status: **Proxied** (orange cloud). This gives you free TLS with no
certificate management.

### 2. systemd unit (on surtr)

```ini
# /etc/systemd/system/brokk-gateway.service
[Unit]
Description=Brokk *.preview reverse proxy
After=network.target

[Service]
Type=simple
User=brokk
WorkingDirectory=/opt/brokk/gateway
ExecStart=node /opt/brokk/gateway/dist/index.js
Restart=always
RestartSec=5

Environment=BROKK_RUNNER_SECRET=<shared-secret>
Environment=BROKK_CONTROL_URL=http://127.0.0.1:8789
Environment=BROKK_GATEWAY_PORT=3020
Environment=BROKK_PREVIEW_TTL_MS=3600000

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now brokk-gateway
```

## Environment variables

| Variable               | Default                    | Description                                           |
|------------------------|----------------------------|-------------------------------------------------------|
| `BROKK_GATEWAY_PORT`   | `3020`                     | Port the gateway HTTP server binds to                 |
| `BROKK_RUNNER_SECRET`  | `""`                       | Shared secret for control-plane auth (Bearer token)   |
| `BROKK_CONTROL_URL`    | `http://127.0.0.1:8789`    | Base URL of the Brokk control plane                   |
| `BROKK_PREVIEW_TTL_MS` | `3600000`                  | How far ahead to push `expiresAt` on each bump (ms)   |

## Build

```bash
pnpm --filter @brokk/gateway build   # emits dist/index.js
node dist/index.js                   # start (production)
pnpm --filter @brokk/gateway dev     # tsx watch (development)
```

## How it works

1. **Subdomain resolution** — The Host header's leftmost label is extracted
   (`brokk-dev` from `brokk-dev.preview.coldcodelabs.com`).

2. **Preview cache** — The gateway calls `GET /previews` on the control plane
   (authenticated with `BROKK_RUNNER_SECRET`) and builds a `subdomain → {port,
   id}` map. The map is cached for 5 s; stale cache is served on CP errors so
   transient blips do not immediately break in-flight requests.

3. **Proxy** — Requests are forwarded via Node's built-in `node:http` to
   `http://127.0.0.1:<port>`. WebSocket upgrades are tunnelled with `node:net`
   (raw TCP) so the WS handshake is preserved end-to-end. Bodies stream; method,
   headers, and status codes are forwarded unchanged.

4. **Activity bump** — At most once per 60 s per preview, the gateway
   `PATCH /previews/:id { expiresAt: now + BROKK_PREVIEW_TTL_MS }` so a live
   demo's TTL keeps sliding and the reaper never kills it mid-show.

5. **Error pages** — 404 if no live preview matches the subdomain; 502 if the
   upstream port refuses the connection (preview still starting or crashed).
