/** Thin HTTP client for Svalinn's machine API (ADR 0087). The token stays in
 *  the Brokk API process — never in a forge worktree. */

export type SvalinnClientOpts = {
  baseUrl: string
  token: string
  actor?: string
}

export type BoardRow = {
  slug: string
  name: string
  repoUrl: string | null
  defaultBranch: string | null
  open: number
  high: number
  critical: number
  bug: number
  medium: number
  low: number
  codeBug: number
  noise: number
  processPolicy: number
  systemicInfra: number
  awaitingVerification: number
}

export type MachineFinding = {
  id: string
  engine: string
  severity: string
  title: string
  slug: string | null
  location: Record<string, unknown> | null
  body: string | null
  status: string
  class: string | null
  clusterKey: string
  targetSlug: string | null
  targetRepoUrl: string | null
}

function trimBase(url: string): string {
  return url.replace(/\/+$/, "")
}

async function svalinnFetch(
  opts: SvalinnClientOpts,
  path: string,
  init: RequestInit = {},
): Promise<{ ok: boolean; status: number; body: unknown }> {
  if (!opts.token) return { ok: false, status: 503, body: { error: "SVALINN_MACHINE_TOKEN unset" } }
  const headers = new Headers(init.headers)
  headers.set("authorization", `Bearer ${opts.token}`)
  headers.set("x-svalinn-actor", opts.actor ?? "brokk")
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json")
  const res = await fetch(`${trimBase(opts.baseUrl)}${path}`, { ...init, headers })
  const body = await res.json().catch(() => ({}))
  return { ok: res.ok, status: res.status, body }
}

export async function getBoard(opts: SvalinnClientOpts): Promise<BoardRow[]> {
  const { ok, status, body } = await svalinnFetch(opts, "/api/machine/board")
  if (!ok) throw new Error(`svalinn board ${status}`)
  const board = (body as { board?: BoardRow[] }).board
  return board ?? []
}

export async function getFindings(
  opts: SvalinnClientOpts,
  slug: string,
  status = "open",
): Promise<MachineFinding[]> {
  const q = new URLSearchParams({ status })
  const { ok, status: http, body } = await svalinnFetch(
    opts,
    `/api/machine/targets/${encodeURIComponent(slug)}/findings?${q}`,
  )
  if (!ok) throw new Error(`svalinn findings ${http}`)
  return (body as { findings?: MachineFinding[] }).findings ?? []
}

export async function setFindingStatus(
  opts: SvalinnClientOpts,
  id: string,
  payload: { status: string; note: string; ref?: string },
): Promise<void> {
  const { ok, status, body } = await svalinnFetch(opts, `/api/machine/findings/${id}/status`, {
    method: "POST",
    body: JSON.stringify(payload),
  })
  if (!ok) throw new Error(`svalinn status ${status}: ${JSON.stringify(body).slice(0, 200)}`)
}

export async function bulkSetFindingStatus(
  opts: SvalinnClientOpts,
  payload: { ids: string[]; status: string; note: string; ref?: string },
): Promise<number> {
  const { ok, status, body } = await svalinnFetch(opts, "/api/machine/findings/status", {
    method: "POST",
    body: JSON.stringify(payload),
  })
  if (!ok) throw new Error(`svalinn bulk ${status}: ${JSON.stringify(body).slice(0, 200)}`)
  return (body as { updated?: number }).updated ?? 0
}

// ── Passada de varredura (ofício `sec`) ──────────────────────────────────────
// O Svalinn passou a aceitar dois verbos de máquina: começar a varredura de um
// alvo e dizer se ela terminou. É o que faz `sec` caber na fila serial sem o
// Brokk reimplementar varredura nenhuma.

export type PassadaSecInicio = {
  passId: string
  slug: string
  enfileiradas: string[]
  puladas: string[]
}

export type PassadaSecEstado = {
  passId: string
  slug: string | null
  estado: "rodando" | "concluida" | "falhou" | "desconhecida"
  ativos: number
  runs: { engine: string; status: string; error: string | null }[]
  findingsAbertos: number
}

/** Começa a passada de `sec` num alvo. 400 = alvo desconhecido, sem repo ou untrusted. */
export async function iniciarPassadaSec(
  opts: SvalinnClientOpts,
  slug: string,
): Promise<PassadaSecInicio> {
  const { ok, status, body } = await svalinnFetch(opts, "/api/machine/scan", {
    method: "POST",
    body: JSON.stringify({ slug }),
  })
  if (!ok) {
    const erro = (body as { error?: string }).error ?? `http ${status}`
    throw new Error(`svalinn scan ${slug}: ${erro}`)
  }
  return body as PassadaSecInicio
}

/** Estado da passada. ⚠️ `rodando` até o ALVO ficar quieto — o Svalinn
 *  auto-enfileira o `report` com owner próprio depois do último scan, e sem
 *  essa espera colheríamos um alvo sem relatório. */
export async function estadoPassadaSec(
  opts: SvalinnClientOpts,
  passId: string,
): Promise<PassadaSecEstado> {
  const { ok, status, body } = await svalinnFetch(
    opts,
    `/api/machine/scan/${encodeURIComponent(passId)}`,
  )
  if (!ok) throw new Error(`svalinn scan estado ${passId}: http ${status}`)
  return body as PassadaSecEstado
}

/** Inventário de alvos varreáveis.
 *
 *  ⚠️ NÃO use `getBoard` para gerar fila: o board é a visão de TRIAGEM (só alvo
 *  com achado aberto), então repositório limpo ou nunca varrido não aparece. */
export type AlvoMaquina = {
  slug: string
  name: string
  repoUrl: string | null
  defaultBranch: string | null
  ultimaVarreduraEm: string | null
  abertos: number
}

export async function getTargets(opts: SvalinnClientOpts): Promise<AlvoMaquina[]> {
  const { ok, status, body } = await svalinnFetch(opts, "/api/machine/targets")
  if (!ok) throw new Error(`svalinn targets ${status}`)
  return (body as { targets?: AlvoMaquina[] }).targets ?? []
}
