import { devPort } from "@brokk/coder";
import type { RuntimeSpec } from "@brokk/core";

/** O que o proxy precisa saber para entregar uma bancada. */
export interface Alvo {
  /** Container da bancada na rede `coolify` (mesmo host, mesmo daemon). */
  host: string;
  /** Porta do dev server dentro dele. */
  port: number;
}

/** A forma mínima da linha que o control plane devolve. */
export interface BancadaRow {
  id: string;
  status: string;
  ownerName: string | null;
  workspaceName: string;
  runtimeId: string | null;
}

/** Subdomínio → nome do workspace.
 *
 *  É 1:1 de propósito: o nome do workspace já é único no Coder e já é derivado
 *  do projeto + lane, então não existe uma segunda tabela de nomes para
 *  divergir da primeira. */
export function subdomainOf(host: string, suffix: string): string | null {
  const h = (host || "").split(":")[0]!.toLowerCase();
  const s = suffix.toLowerCase().replace(/^\.*/, "");
  if (!h.endsWith(`.${s}`)) return null;
  const sub = h.slice(0, -(s.length + 1));
  // Um único rótulo: `a.b.preview.dominio` não é bancada de ninguém.
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(sub) ? sub : null;
}

/** Container + porta de uma bancada.
 *
 *  O alvo é o CONTAINER, não o app do Coder: servir na raiz de um host próprio
 *  faz o caminho absoluto do bundle (`/@vite/client`, `/_next/...`) e o
 *  websocket do HMR funcionarem exatamente como o dev server espera. Sob o
 *  proxy por caminho do Coder, os dois quebram.
 *
 *  O nome do container é o mesmo que o template cria — se um dia mudar lá, muda
 *  aqui, e o teste abaixo é quem grita. */
export function alvoDe(row: BancadaRow, runtime: RuntimeSpec | null): Alvo | null {
  if (row.status !== "ready") return null;
  const owner = (row.ownerName || "").toLowerCase();
  if (!owner) return null;
  return {
    host: `bancada-${owner}-${row.workspaceName.toLowerCase()}`,
    port: runtime ? devPort(runtime) : 3000,
  };
}
