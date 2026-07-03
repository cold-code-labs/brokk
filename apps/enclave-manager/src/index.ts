/**
 * @brokk/enclave-manager-app — the one privileged component that holds the Docker
 * socket, so the workers never have to.
 *
 * ADR 0010 Fase 1 (the sidecar-broker shape): the trusted workers (forge/chat/
 * reviewer) drive per-project gVisor enclaves WITHOUT the Docker socket — a socket
 * in a worker would be host-root-equivalent. Instead this sidecar holds the socket
 * and exposes a narrow, token-gated API — `POST /exec` / `POST /stop` — over the
 * internal network. Workers call it via `BrokeredEnclave` (@brokk/afl). Untrusted
 * code runs inside the enclave (no socket); a worker compromise can't spawn
 * containers. This process is the ONLY thing with `docker.sock`, and it exposes
 * exactly three verbs — nothing that lets a caller escape its own project.
 *
 * It reuses `RunscEnclave` (@brokk/afl) as the docker-side engine (it shells the
 * docker CLI, present in this image), memoised one-per-project so the enclave stays
 * warm across calls.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { RunscEnclave } from "@brokk/afl";

const PORT = Number(process.env.PORT || 8795);
const TOKEN = process.env.BROKK_ENCLAVE_MANAGER_TOKEN || "";
if (!TOKEN) {
  console.error("[enclave-manager] refusing to start: BROKK_ENCLAVE_MANAGER_TOKEN unset");
  process.exit(1);
}

// One warm RunscEnclave per project key. RunscEnclave reads image/dns/home-volume
// from env (BROKK_ENCLAVE_*), so construction only needs the project + its checkout.
const enclaves = new Map<string, RunscEnclave>();
function enclaveFor(project: string, checkoutRoot: string): RunscEnclave {
  let e = enclaves.get(project);
  if (!e) {
    e = new RunscEnclave({ project, checkoutRoot });
    enclaves.set(project, e);
  }
  return e;
}

function readJson(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 4 * 1024 * 1024) reject(new Error("body too large"));
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, obj: unknown): void {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body);
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") return send(res, 200, { ok: true });

    // Token gate — only trusted workers may drive the socket-holder.
    const auth = req.headers.authorization || "";
    if (auth !== `Bearer ${TOKEN}`) return send(res, 401, { error: "unauthorized" });

    if (req.method === "POST" && req.url === "/exec") {
      const b = await readJson(req);
      if (!b.project || !b.checkoutRoot || typeof b.command !== "string" || !b.cwd) {
        return send(res, 400, { error: "project, checkoutRoot, command, cwd required" });
      }
      const enc = enclaveFor(String(b.project), String(b.checkoutRoot));
      const r = await enc.exec(String(b.command), String(b.cwd), { timeoutMs: Number(b.timeoutMs) || undefined });
      return send(res, 200, r);
    }

    if (req.method === "POST" && req.url === "/stop") {
      const b = await readJson(req);
      const key = String(b.project || "");
      const enc = enclaves.get(key);
      if (enc) {
        await enc.stop();
        enclaves.delete(key);
      }
      return send(res, 200, { ok: true });
    }

    return send(res, 404, { error: "not found" });
  } catch (e: any) {
    return send(res, 500, { error: e?.message ?? String(e) });
  }
});

server.listen(PORT, () => console.log(`[enclave-manager] listening on :${PORT}`));
