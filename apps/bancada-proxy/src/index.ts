/**
 * O proxy da bancada — o ambiente QUENTE servido num host que o Brokk controla.
 *
 * Por que ele existe, já que o Coder publica o app da bancada por caminho: **o
 * caminho quebra o app**. O Coder serve em
 * `/@dono/<ws>.main/apps/bancada/`, mas o HTML de um dev server referencia
 * asset por caminho ABSOLUTO (`/@vite/client`, `/src/main.tsx`, `/_next/...`).
 * O navegador então pede `coder.coldcodelabs.com/@vite/client` — a raiz do
 * Coder — e recebe o HTML do próprio dashboard do Coder. Medido em 20/08/2026:
 * `content-type: text/html`, o dashboard inteiro no lugar do módulo. O app não
 * roda, e o cliente do HMR nunca carrega.
 *
 * Servir na RAIZ de um host próprio resolve isso pela origem: o caminho
 * absoluto passa a apontar para o dev server, e o websocket do HMR sobe.
 *
 * (Correção de um erro meu: a primeira versão disto dizia que o motivo era o
 * cookie `SameSite=Lax` do Coder não sobreviver a um iframe. Não é verdade —
 * `brokk.` e `coder.` dividem o mesmo domínio registrável, então são o MESMO
 * site para efeito de SameSite e o cookie iria. O que quebra é o caminho.)
 *
 * O portão é o `__bk`: a web do Brokk (que sabe quem você é) assina uma chave
 * curta para AQUELE subdomínio, o proxy troca por cookie, e daí em diante os
 * pedidos do próprio app carregam. A chave não diz quem você é — diz "alguém
 * com sessão no Brokk pediu esta bancada, há pouco".
 */

import * as http from "node:http";
import * as net from "node:net";
import {
  PREVIEW_KEY_COOKIE,
  PREVIEW_KEY_PARAM,
  PREVIEW_KEY_TTL_S,
  verifyPreviewKey,
} from "@brokk/core/preview-key";
import type { RuntimeSpec } from "@brokk/core";
import { alvoDe, subdomainOf, type Alvo, type BancadaRow } from "./resolve.js";

const PORT = Number(process.env.BANCADA_PROXY_PORT ?? 3020);
const CONTROL = (process.env.BROKK_CONTROL_URL ?? "http://brokk-api:8789").replace(/\/$/, "");
const API_SECRET = process.env.BROKK_API_SECRET ?? "";
const KEY = process.env.BROKK_PREVIEW_KEY ?? "";
const SUFFIX = process.env.BANCADA_HOST_SUFFIX ?? "preview.coldcodelabs.com";
const WEB = (process.env.BROKK_WEB_URL ?? "https://brokk.coldcodelabs.com").replace(/\/$/, "");

/** Cache curto do mapa subdomínio→alvo. Curto porque uma bancada morre e nasce
 *  o tempo todo; existe só para não bater no control plane a cada asset. */
const CACHE_MS = 5_000;
const cache = new Map<string, { at: number; alvo: Alvo | null }>();

async function alvoPara(sub: string): Promise<Alvo | null> {
  const hit = cache.get(sub);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.alvo;
  let alvo: Alvo | null = null;
  try {
    const res = await fetch(`${CONTROL}/bancadas/by-workspace/${encodeURIComponent(sub)}`, {
      headers: { authorization: `Bearer ${API_SECRET}`, "x-brokk-is-staff": "1" },
      signal: AbortSignal.timeout(5_000),
    });
    if (res.ok) {
      const body = (await res.json()) as { bancada: BancadaRow; runtime: RuntimeSpec | null };
      alvo = alvoDe(body.bancada, body.runtime ?? null);
    }
  } catch {
    // control plane fora do ar: melhor 502 do que servir errado
  }
  cache.set(sub, { at: Date.now(), alvo });
  return alvo;
}

function cookieDe(req: http.IncomingMessage, nome: string): string | null {
  const raw = req.headers.cookie ?? "";
  for (const parte of raw.split(";")) {
    const [k, ...v] = parte.trim().split("=");
    if (k === nome) return decodeURIComponent(v.join("="));
  }
  return null;
}

/** O portão. Devolve a chave a "plantar" como cookie quando ela veio na URL. */
function liberado(req: http.IncomingMessage, sub: string): { ok: boolean; plantar?: string } {
  if (!KEY) return { ok: false }; // sem segredo é FECHADO, nunca aberto
  const url = new URL(req.url ?? "/", "http://x");
  const daUrl = url.searchParams.get(PREVIEW_KEY_PARAM);
  if (daUrl && verifyPreviewKey(KEY, sub, daUrl)) return { ok: true, plantar: daUrl };
  const doCookie = cookieDe(req, PREVIEW_KEY_COOKIE);
  if (doCookie && verifyPreviewKey(KEY, sub, doCookie)) return { ok: true };
  return { ok: false };
}

function recusa(res: http.ServerResponse, code: number, msg: string) {
  res.writeHead(code, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(
    `<!doctype html><meta charset="utf-8"><title>bancada</title>` +
      `<body style="font:14px/1.5 system-ui;padding:32px;color:#333">` +
      `<p>${msg}</p><p><a href="${WEB}">Voltar ao Brokk</a></p></body>`,
  );
}

const server = http.createServer(async (req, res) => {
  const sub = subdomainOf(req.headers.host ?? "", SUFFIX);
  if (!sub) return recusa(res, 404, "Host desconhecido.");

  const portao = liberado(req, sub);
  if (!portao.ok) {
    return recusa(res, 403, "Esta bancada precisa ser aberta pelo Brokk.");
  }
  // Chave veio na URL: vira cookie e a query some — assim o link não fica no
  // histórico do navegador nem no Referer de cada asset.
  if (portao.plantar) {
    const url = new URL(req.url ?? "/", "http://x");
    url.searchParams.delete(PREVIEW_KEY_PARAM);
    res.writeHead(302, {
      // SameSite=None: hoje o Brokk e a bancada dividem o domínio registrável,
      // então Lax bastaria — mas um Brokk hospedado noutro domínio passaria a
      // ser cross-site e o cookie sumiria sem aviso. None+Secure vale nos dois.
      "set-cookie": `${PREVIEW_KEY_COOKIE}=${encodeURIComponent(portao.plantar)}; Path=/; Max-Age=${PREVIEW_KEY_TTL_S}; HttpOnly; Secure; SameSite=None`,
      location: `${url.pathname}${url.search}`,
      "cache-control": "no-store",
    });
    return res.end();
  }

  const alvo = await alvoPara(sub);
  if (!alvo) return recusa(res, 502, "Bancada não está no ar.");

  const up = http.request(
    {
      host: alvo.host,
      port: alvo.port,
      method: req.method,
      path: req.url,
      headers: { ...req.headers, host: `${alvo.host}:${alvo.port}` },
      timeout: 120_000,
    },
    (upRes) => {
      res.writeHead(upRes.statusCode ?? 502, upRes.headers);
      upRes.pipe(res);
    },
  );
  up.on("error", () => {
    if (!res.headersSent) recusa(res, 502, "Bancada não respondeu.");
    else res.end();
  });
  req.pipe(up);
});

/** HMR. Sem isto o preview carrega uma vez e nunca mais se mexe — que é
 *  exatamente o oposto do que uma bancada serve para ser. */
server.on("upgrade", async (req, socket: net.Socket, head) => {
  const sub = subdomainOf(req.headers.host ?? "", SUFFIX);
  if (!sub || !liberado(req, sub).ok) return socket.destroy();
  const alvo = await alvoPara(sub);
  if (!alvo) return socket.destroy();

  const up = http.request({
    host: alvo.host,
    port: alvo.port,
    method: req.method,
    path: req.url,
    headers: { ...req.headers, host: `${alvo.host}:${alvo.port}` },
  });
  up.on("upgrade", (upRes, upSocket, upHead) => {
    const linhas = Object.entries(upRes.headers).map(([k, v]) => `${k}: ${v}`);
    socket.write(`HTTP/1.1 101 Switching Protocols\r\n${linhas.join("\r\n")}\r\n\r\n`);
    if (upHead?.length) socket.unshift(upHead);
    upSocket.pipe(socket);
    socket.pipe(upSocket);
  });
  up.on("error", () => socket.destroy());
  socket.on("error", () => up.destroy());
  if (head?.length) up.write(head);
  up.end();
});

server.listen(PORT, () => {
  console.log(
    `[bancada-proxy] :${PORT} servindo *.${SUFFIX}` +
      (KEY ? "" : " — ⚠️ SEM BROKK_PREVIEW_KEY: tudo recusado (fecha, não abre)"),
  );
});
