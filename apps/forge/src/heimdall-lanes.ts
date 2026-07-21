import type { Hauldr, HauldrProject } from "@brokk/core";

/**
 * The dev lane's backend, asked for through Heimdall instead of provisioned by
 * us.
 *
 * Why this replaced the direct Hauldr client: reaching the data plane needed
 * `HAULDR_TOKEN` — its MANAGEMENT key, which reads the superuser DSN of every
 * project on the fleet, a client's production database included. The forge only
 * ever needs one dev lane's connection material, so it now asks the party whose
 * job that is: Heimdall refuses anything but `<app>_dev` of a registered app,
 * creates the lane at the right envelope (nano) if it has never existed, and
 * restores its compute when only the sidecars are missing.
 *
 * Shape-compatible with the old `HauldrClient` on purpose — the `DataProvider`
 * seam above it doesn't change.
 */
export class HeimdallLanes implements Hauldr {
  constructor(
    private readonly agentUrl: string,
    private readonly agentToken: string,
  ) {}

  /** Ensure the lane is up and return its connection. Heimdall does the
   *  create/restore/poll; a cold GoTrue+PostgREST can take minutes, hence the
   *  wide ceiling — the preview would rather wait than boot against nothing. */
  async ensureProject(name: string): Promise<HauldrProject> {
    return this.req(name, 330_000);
  }

  /** Read-only view of the same lane. Goes through the same route — it is
   *  idempotent, and a lane that is already up costs Heimdall one read. */
  async getProject(name: string): Promise<HauldrProject> {
    return this.req(name, 30_000);
  }

  /** Not ours to do anymore. Dropping a lane's compute is a data-plane decision
   *  and belongs to Heimdall; the old implementation here had zero call sites
   *  in the first place. */
  async deprovisionCompute(): Promise<void> {
    throw new Error("deprovisionCompute is Heimdall's call now, not the forge's");
  }

  private async req(name: string, timeoutMs: number): Promise<HauldrProject> {
    const url = `${this.agentUrl.replace(/\/$/, "")}/api/agent/lanes/${encodeURIComponent(name)}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${this.agentToken}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const payload = (await res.json().catch(() => ({}))) as {
      project?: {
        name: string;
        status: string;
        connection: {
          dbUrl: string;
          adminDbUrl?: string | null;
          database?: string | null;
          gotrueUrl: string | null;
          jwtSecret: string | null;
          restUrl: string | null;
          migrateToken?: string | null;
        } | null;
      } | null;
      error?: string;
    };
    if (!res.ok) {
      // 403 means Heimdall says this is not a dev lane we may touch — surface it
      // as-is rather than retrying, so it reads as a scope refusal in the log
      // and not as a flaky backend.
      throw new Error(
        `heimdall lane ${name} → ${res.status} ${payload?.error ?? JSON.stringify(payload)}`,
      );
    }
    const p = payload.project;
    const c = p?.connection;
    if (!p || !c) {
      throw new Error(`heimdall lane ${name}: no connection (status ${p?.status ?? "unknown"})`);
    }
    return {
      database: c.database ?? "",
      gotrueUrl: c.gotrueUrl ?? "",
      jwtSecret: c.jwtSecret ?? "",
      postgrestUrl: c.restUrl ?? "",
      dbUrl: c.dbUrl,
      migrateToken: c.migrateToken ?? "",
    };
  }
}
