// Engine Cursor API — mesmo caminho que o Svalinn já usa (worker/engines/report.mjs
// e enclave.mjs `--agent cursor`): binário `cursor-agent` headless, autenticado por
// CURSOR_API_KEY. Nada de gateway aqui: é a API do Cursor direto, por desenho.
//
// A lente NUNCA roda na working tree do repo. Roda num `git worktree` descartável
// em /tmp — isolamento barato que o Brokk já usa no forge, e a garantia de que uma
// lente de leitura não escreve no repo do alvo.

import { spawn, spawnSync } from "node:child_process"
import { mkdtemp, readFile, rm, mkdir } from "node:fs/promises"
import { readFileSync, existsSync } from "node:fs"
import { tmpdir, homedir } from "node:os"
import path from "node:path"

export function agentBin() {
  return process.env.CURSOR_AGENT_BIN
    || process.env.BROKK_CURSOR_CLI_BIN
    || path.join(homedir(), ".local/bin/cursor-agent")
}

/** Chave: env primeiro, senão o cofre local da frota (mesmo padrão do litellm_image_key). */
export function cursorKey() {
  if (process.env.CURSOR_API_KEY) return process.env.CURSOR_API_KEY
  const vault = path.join(homedir(), ".config/ccl/cursor_api_key")
  if (existsSync(vault)) return readFileSync(vault, "utf8").trim()
  return ""
}

export function cursorAvailable() {
  if (!cursorKey()) return { ok: false, why: "CURSOR_API_KEY ausente (env ou ~/.config/ccl/cursor_api_key)" }
  const r = spawnSync(agentBin(), ["--version"], { timeout: 15_000, stdio: "ignore" })
  if (r.status !== 0) return { ok: false, why: `binário ${agentBin()} indisponível` }
  return { ok: true }
}

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", ...opts })
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} → ${r.status}: ${(r.stderr || r.stdout || "").slice(-400)}`)
  }
  return (r.stdout ?? "").trim()
}

/** Worktree descartável do commit alvo. Devolve { dir, commit, cleanup }. */
export async function checkout(repoDir, ref = "HEAD") {
  const commit = sh("git", ["rev-parse", ref], { cwd: repoDir })
  const dir = await mkdtemp(path.join(tmpdir(), "assurance-"))
  const wt = path.join(dir, "wt")
  sh("git", ["worktree", "add", "--detach", wt, commit], { cwd: repoDir })
  return {
    dir: wt,
    commit,
    cleanup: async () => {
      try { sh("git", ["worktree", "remove", "--force", wt], { cwd: repoDir }) } catch { /* best-effort */ }
      await rm(dir, { recursive: true, force: true })
    },
  }
}

/** Diff unificado do alvo contra uma base — a entrada das lentes `scope: diff`. */
export function diffAgainst(repoDir, base) {
  return sh("git", ["diff", "--unified=3", `${base}...HEAD`], { cwd: repoDir, maxBuffer: 32 * 1024 * 1024 })
}

/** Roda cursor-agent headless com cwd = worktree. Resolve com o stdout. */
export function runCursor({ cwd, prompt, model = "auto", timeoutMs = 15 * 60 * 1000, onHeartbeat }) {
  const bin = agentBin()
  const args = ["-p", "--force", "--trust", "--output-format", "text", "--model", model]
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, {
      cwd,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME || homedir(),
        TMPDIR: process.env.TMPDIR || "/tmp",
        CURSOR_API_KEY: cursorKey(),
        NO_COLOR: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    const hb = setInterval(() => onHeartbeat?.(), 30_000)
    const timer = setTimeout(() => {
      proc.kill("SIGTERM")
      reject(new Error(`cursor-agent estourou ${timeoutMs}ms`))
    }, timeoutMs)
    proc.stdout.on("data", (d) => { stdout += d.toString() })
    proc.stderr.on("data", (d) => { stderr += d.toString() })
    proc.on("error", (e) => { clearTimeout(timer); clearInterval(hb); reject(e) })
    proc.on("close", (code) => {
      clearTimeout(timer)
      clearInterval(hb)
      if (code !== 0) {
        reject(new Error(`cursor-agent saiu ${code}: ${(stderr || stdout).slice(-800)}`))
        return
      }
      resolve(stdout)
    })
    proc.stdin.write(prompt)
    proc.stdin.end()
  })
}

/** Extrai JSON de resposta de agente (cercado, com preâmbulo, ou cru). */
export function extractJson(raw) {
  const fenced = String(raw).match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidate = (fenced?.[1] ?? raw).trim()
  const i = [candidate.indexOf("{"), candidate.indexOf("[")].filter((n) => n >= 0).sort((a, b) => a - b)[0]
  if (i === undefined) throw new Error("nenhum JSON na resposta do agente")
  const slice = candidate.slice(i)
  try {
    return JSON.parse(slice)
  } catch {
    const end = Math.max(slice.lastIndexOf("}"), slice.lastIndexOf("]"))
    if (end < 0) throw new Error("JSON impossível de parsear")
    return JSON.parse(slice.slice(0, end + 1))
  }
}

/**
 * Roda uma lente pelo Cursor e devolve o array cru de achados.
 * O agente escreve o resultado num arquivo fora do worktree (para não sujar o
 * repo nem depender de stdout limpo); stdout é o fallback.
 */
export async function runLensViaCursor({ lens, cwd, context, model, onHeartbeat }) {
  const outDir = await mkdtemp(path.join(tmpdir(), "assurance-out-"))
  const outPath = path.join(outDir, "findings.json")
  await mkdir(outDir, { recursive: true })

  const prompt = lens.prompt({ context, outPath })
  const stdout = await runCursor({ cwd, prompt, model: model ?? lens.model ?? "auto", onHeartbeat })

  let raw
  try {
    raw = await readFile(outPath, "utf8")
  } catch {
    raw = stdout
  }
  await rm(outDir, { recursive: true, force: true })
  if (!String(raw).trim()) throw new Error(`${lens.id}: agente não produziu saída`)
  const parsed = extractJson(raw)
  const items = Array.isArray(parsed) ? parsed : (parsed.findings ?? parsed.items ?? [])
  if (!Array.isArray(items)) throw new Error(`${lens.id}: saída não é lista de achados`)
  return items
}
