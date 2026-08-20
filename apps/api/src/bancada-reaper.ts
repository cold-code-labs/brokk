import type { Store } from "@brokk/db";
import type { BancadaService } from "./bancada.js";

/**
 * The idle reaper.
 *
 * A bancada is a real machine with a dev server in it. Left alone it keeps
 * compiling, watching files and holding RAM for nobody — on a host that is now
 * shared by the whole fleet. So a `ready` bancada whose last interaction is
 * older than the TTL gets **stopped**, not deleted: the disk survives, and the
 * next `ensure` brings it back in seconds instead of re-cloning.
 *
 * Activity is bumped by the screen (poll), by a message to the agent, and by a
 * git credential being brokered — i.e. by someone actually using it, never by
 * the reaper's own reads.
 *
 * O tick também RECONCILIA. O registro no banco só era atualizado quando alguém
 * abria a tela, então uma bancada que subiu sem ninguém olhando ficava eterna em
 * `provisioning`: o proxy se recusava a servi-la e o próprio reaper não a
 * enxergava para desligar. Estado que depende de alguém estar olhando não é
 * estado — é boato.
 */
export function startBancadaReaper(deps: {
  store: Store;
  bancadas: BancadaService;
  idleMs: number;
  intervalMs?: number;
}): { stop: () => void } {
  // 60s: o tick agora também é o que mantém o estado honesto para quem não é
  // navegador (o proxy, o driver). 5 minutos deixava um preview recusando por
  // até 5 minutos depois de a bancada estar pronta.
  const interval = deps.intervalMs ?? 60_000;
  const tick = async () => {
    try {
      // 1. Reconcilia o que ainda pode mudar sozinho.
      for (const status of ["provisioning", "ready"] as const) {
        for (const b of await deps.store.listBancadas({ status })) {
          await deps.bancadas.refresh(b).catch(() => {
            /* o Coder decide; um erro aqui é ruído, não estado */
          });
        }
      }

      // 2. Só então decide quem dormiu demais.
      const cutoff = new Date(Date.now() - deps.idleMs);
      const idle = await deps.store.listIdleBancadas(cutoff);
      for (const b of idle) {
        console.log(
          `[bancada-reaper] ${b.workspaceName} ocioso desde ${b.lastActivityAt} — parando`,
        );
        await deps.bancadas.stop(b).catch((err) => {
          console.warn(`[bancada-reaper] ${b.workspaceName}:`, err instanceof Error ? err.message : err);
        });
      }
    } catch (err) {
      // A reaper that throws stops reaping. Log and live.
      console.warn("[bancada-reaper]", err instanceof Error ? err.message : err);
    }
  };
  const timer = setInterval(tick, interval);
  timer.unref?.();
  void tick();
  return { stop: () => clearInterval(timer) };
}
