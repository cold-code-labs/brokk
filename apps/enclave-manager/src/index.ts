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
import { execFile } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { hostname } from "node:os";
import { promisify } from "node:util";
import { RunscEnclave } from "@brokk/afl";

const execFileAsync = promisify(execFile);

const PORT = Number(process.env.PORT || 8795);
const TOKEN = process.env.BROKK_ENCLAVE_MANAGER_TOKEN || "";
if (!TOKEN) {
  console.error("[enclave-manager] refusing to start: BROKK_ENCLAVE_MANAGER_TOKEN unset");
  process.exit(1);
}

// The default runtime image ships as a Dockerfile in this image (./enclave-base).
// Build it on the host if absent, so a fresh host self-heals with no manual step
// (ADR 0010). Only touches the tag we own; a project overriding BROKK_ENCLAVE_IMAGE
// to something else is left alone. Best-effort — a build hiccup never blocks serving
// (the image may already exist, or a request can surface the error).
const BASE_IMAGE = "brokk-enclave-base:latest";
const BASE_DOCKERFILE_DIR = "/app/enclave-base";
async function ensureBaseImage(): Promise<void> {
  if ((process.env.BROKK_ENCLAVE_IMAGE || BASE_IMAGE) !== BASE_IMAGE) return;
  try {
    await execFileAsync("docker", ["image", "inspect", BASE_IMAGE], { timeout: 15_000 });
    return; // already present
  } catch {
    /* absent — build it */
  }
  try {
    console.log(`[enclave-manager] building ${BASE_IMAGE} (absent on host)…`);
    await execFileAsync("docker", ["build", "-t", BASE_IMAGE, BASE_DOCKERFILE_DIR], { timeout: 300_000 });
    console.log(`[enclave-manager] ${BASE_IMAGE} built`);
  } catch (e: any) {
    console.error(`[enclave-manager] base image build failed (best-effort): ${e?.message ?? e}`);
  }
}

// Discover our REAL brokk_home volume from our own container mounts, and pin it into
// BROKK_ENCLAVE_HOME_VOLUME (which RunscEnclave reads at construct time). Why: Coolify
// prefixes the volume with the app's uuid, and that uuid CHANGES when the app is
// recreated — the hardcoded env then points at an orphaned volume, so every enclave's
// `--mount volume-subpath` lstat-fails ("no such file or directory") and ALL bash dies
// while the checkout sits safe on the new volume. We hold the Docker socket, so our own
// mounts are the authoritative source. Self-inspection > a value a human has to keep in
// sync. Best-effort: if inspection fails we keep whatever env was set.
const HOME_MOUNT = process.env.BROKK_ENCLAVE_HOME_MOUNT || "/home/brokk";
async function discoverHomeVolume(): Promise<void> {
  try {
    const { stdout } = await execFileAsync(
      "docker",
      ["inspect", hostname(), "--format", "{{json .Mounts}}"],
      { timeout: 15_000 },
    );
    const mounts = JSON.parse(stdout) as Array<{ Type?: string; Name?: string; Destination?: string }>;
    const hit = mounts.find((m) => m.Type === "volume" && m.Destination === HOME_MOUNT && m.Name);
    if (!hit?.Name) {
      console.warn(
        `[enclave-manager] no named volume mounted at ${HOME_MOUNT}; keeping BROKK_ENCLAVE_HOME_VOLUME=${process.env.BROKK_ENCLAVE_HOME_VOLUME ?? "(unset)"}`,
      );
      return;
    }
    const prev = process.env.BROKK_ENCLAVE_HOME_VOLUME;
    process.env.BROKK_ENCLAVE_HOME_VOLUME = hit.Name;
    console.log(
      prev === hit.Name
        ? `[enclave-manager] home volume: ${hit.Name}`
        : `[enclave-manager] home volume: ${hit.Name} (corrected drifted env=${prev ?? "unset"})`,
    );
  } catch (e: any) {
    console.error(`[enclave-manager] home-volume discovery failed (best-effort): ${e?.message ?? e}`);
  }
}

// One warm RunscEnclave per project key. RunscEnclave reads image/dns/home-volume
// from env (BROKK_ENCLAVE_*), so construction only needs the project + its checkout;
// an optional per-request `image` lets different projects pin different runtimes
// (fixed at first-create, since the enclave is warm thereafter).
const enclaves = new Map<string, RunscEnclave>();
// Last-touched wall-clock per warm enclave — drives the idle reaper below.
const lastUsed = new Map<string, number>();
function enclaveFor(project: string, checkoutRoot: string, image?: string, gitCommonDir?: string): RunscEnclave {
  let e = enclaves.get(project);
  if (!e) {
    e = new RunscEnclave({ project, checkoutRoot, image, gitCommonDir });
    enclaves.set(project, e);
  }
  return e;
}

// ── Reaping ───────────────────────────────────────────────────────────────────
// Enclaves are warm containers (`brokk-enclave-<project>`) that only ever went away
// on an explicit `/stop`. Two leaks that left orphans running for days: (1) a deploy
// recreates THIS process → the warm map is empty but the old containers keep running;
// (2) a card that crashes without a clean `/stop`. Both are reaped here.
const IDLE_TTL_MS = Number(process.env.BROKK_ENCLAVE_IDLE_TTL_MS || 30 * 60_000);
const SWEEP_MS = Number(process.env.BROKK_ENCLAVE_SWEEP_MS || 5 * 60_000);

/** Boot reconcile: our warm map is empty on (re)start, so ANY `brokk-enclave-*`
 *  container/network is an orphan from a previous life — a deploy recreated us AND
 *  the workers, so nothing is using them. LIST (read-only) then remove by EXACT name
 *  — never `docker rm --filter` (substring match is a footgun). Best-effort. */
async function reapOrphans(): Promise<void> {
  try {
    const { stdout } = await execFileAsync(
      "docker",
      ["ps", "-a", "--filter", "name=brokk-enclave-", "--format", "{{.Names}}"],
      { timeout: 15_000 },
    );
    const names = stdout
      .split("\n")
      .map((s) => s.trim())
      .filter((n) => n.startsWith("brokk-enclave-") && !n.includes("manager"));
    for (const name of names) {
      try {
        await execFileAsync("docker", ["rm", "-f", name], { timeout: 30_000 });
        await execFileAsync("docker", ["network", "rm", name], { timeout: 15_000 }).catch(() => {});
        console.log(`[enclave-manager] reaped orphan enclave ${name}`);
      } catch (e: any) {
        console.error(`[enclave-manager] failed to reap ${name}: ${e?.message ?? e}`);
      }
    }
  } catch (e: any) {
    console.error(`[enclave-manager] orphan reconcile failed (best-effort): ${e?.message ?? e}`);
  }
}

/** Idle sweep: stop warm enclaves untouched for longer than the TTL. exec is capped
 *  well under the TTL, so a long-running command never looks idle mid-flight. */
async function sweepIdle(): Promise<void> {
  const now = Date.now();
  for (const [project, enc] of enclaves) {
    if (now - (lastUsed.get(project) ?? 0) <= IDLE_TTL_MS) continue;
    try {
      await enc.stop();
    } catch {
      /* best-effort */
    }
    enclaves.delete(project);
    lastUsed.delete(project);
    console.log(`[enclave-manager] reaped idle enclave ${project}`);
  }
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
      // Self-heal the base image on every exec, not just at startup: a host image
      // prune AFTER boot would otherwise leave a cold enclave unable to `docker run`
      // (the image can't be pulled — it's local-only), silently breaking every agent's
      // bash. The inspect is a cheap local daemon call when the image is present; it
      // only (re)builds when it's actually gone.
      await ensureBaseImage();
      const enc = enclaveFor(
        String(b.project),
        String(b.checkoutRoot),
        b.image ? String(b.image) : undefined,
        b.gitCommonDir ? String(b.gitCommonDir) : undefined,
      );
      lastUsed.set(String(b.project), Date.now());
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
        lastUsed.delete(key);
      }
      return send(res, 200, { ok: true });
    }

    return send(res, 404, { error: "not found" });
  } catch (e: any) {
    return send(res, 500, { error: e?.message ?? String(e) });
  }
});

// Boot: pin the real home volume FIRST (a lazily-constructed RunscEnclave reads the
// env at first exec, so discovery must win before we accept requests), then serve.
void (async () => {
  await discoverHomeVolume();
  server.listen(PORT, () => console.log(`[enclave-manager] listening on :${PORT}`));
  // Ensure the default runtime image exists (best-effort, non-blocking).
  void ensureBaseImage();
  // Reap orphans left by a previous life (deploy), then sweep idle enclaves.
  void reapOrphans();
  setInterval(() => void sweepIdle(), SWEEP_MS).unref();
})();
