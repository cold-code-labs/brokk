/**
 * Langfuse per-forge tracing (Langfuse path-b). Maps the engine's `emit()` event
 * stream into one Langfuse trace per card: a span per agent/verify phase, an event
 * per heal round, a generation per usage report, and scores for the verify outcome
 * + heal count. The fleet-wide LLM traces already come free via the LiteLLM→Langfuse
 * callback; this adds the forge-SHAPED view (cost/tokens/heal/verify per card).
 *
 * Entirely best-effort: disabled when LANGFUSE_PUBLIC_KEY/SECRET_KEY are unset, and
 * every SDK call is wrapped — a tracing hiccup never touches the forge.
 */
import { Langfuse } from "langfuse";

const PUB = process.env.LANGFUSE_PUBLIC_KEY;
const SEC = process.env.LANGFUSE_SECRET_KEY;

const client =
  PUB && SEC
    ? new Langfuse({ publicKey: PUB, secretKey: SEC, baseUrl: process.env.LANGFUSE_HOST || undefined })
    : null;

export const tracingEnabled = (): boolean => Boolean(client);

type Ev = { type: string; payload: any };

export interface ForgeTraceMeta {
  title: string;
  body: string;
  model: string;
  metadata: Record<string, unknown>;
}

/** A live trace for one forge run. All methods swallow errors. */
export class ForgeTrace {
  private trace: any;
  private agentSpan: any = null;
  private verifySpan: any = null;
  constructor(meta: ForgeTraceMeta) {
    this.trace = client!.trace({
      name: `forge: ${meta.title}`.slice(0, 90),
      input: meta.body,
      metadata: meta.metadata,
    });
    this.model = meta.model;
  }
  private model: string;

  /** Fold one engine event into the trace. */
  onEvent(e: Ev): void {
    try {
      if (e.type === "status") {
        const p = e.payload?.phase;
        if (p === "agent_start") {
          this.agentSpan = this.trace.span({ name: "agent", metadata: { model: e.payload?.model } });
        } else if (p === "verify_start") {
          this.verifySpan = this.trace.span({ name: `verify#${e.payload?.round ?? 0}` });
        } else if (p === "verify_done") {
          this.verifySpan?.end({ output: { ok: e.payload?.ok, round: e.payload?.round } });
          this.verifySpan = null;
        } else if (p === "heal") {
          this.trace.event({ name: "heal", metadata: { attempt: e.payload?.attempt, of: e.payload?.of } });
        } else if (p === "agent_done") {
          this.agentSpan?.end({ output: e.payload?.usage });
          this.agentSpan = null;
        }
      } else if (e.type === "usage") {
        const u = e.payload ?? {};
        this.trace
          .generation({
            name: "llm",
            model: this.model,
            usage: {
              input: Number(u.input_tokens ?? 0),
              output: Number(u.output_tokens ?? 0),
              unit: "TOKENS",
            },
          })
          .end();
      }
    } catch {
      // tracing is best-effort
    }
  }

  /** Final outcome → scores + metadata. */
  complete(r: {
    verify: { ok: boolean } | null;
    healAttempts: number;
    usage: { tokensIn: number; tokensOut: number };
    prUrl?: string;
  }): void {
    try {
      this.agentSpan?.end();
      this.trace.update({
        output: { prUrl: r.prUrl, verify: r.verify?.ok ?? null, healAttempts: r.healAttempts },
        metadata: { tokensIn: r.usage.tokensIn, tokensOut: r.usage.tokensOut },
      });
      if (r.verify) this.trace.score({ name: "verify", value: r.verify.ok ? 1 : 0 });
      this.trace.score({ name: "heal_attempts", value: r.healAttempts });
    } catch {
      /* best-effort */
    }
  }

  fail(err: unknown): void {
    try {
      this.agentSpan?.end();
      this.trace.update({ metadata: { error: String(err).slice(0, 500) } });
      this.trace.score({ name: "crashed", value: 1 });
    } catch {
      /* best-effort */
    }
  }
}

/** Start a forge trace, or null when tracing is disabled. */
export function startForgeTrace(meta: ForgeTraceMeta): ForgeTrace | null {
  return client ? new ForgeTrace(meta) : null;
}

/** Flush queued events to Langfuse (call after each run completes). */
export async function flushTraces(): Promise<void> {
  try {
    await client?.flushAsync();
  } catch {
    /* best-effort */
  }
}
