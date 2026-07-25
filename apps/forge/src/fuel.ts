/**
 * Fuel circuit-breaker (fleet reliability).
 *
 * When the LLM fuel line (LiteLLM → OmniRoute → Cursor/Anthropic) goes down, the
 * forge would otherwise claim card after card and burn each one into the dead
 * gateway — a single outage on 2026-07-23 failed 62 cards this way. The breaker
 * turns that into "pause claiming while the fuel is down; the cards stay
 * `queued` and drain once it recovers."
 *
 * Design — reactive with a half-open trial, so there is ZERO probe cost while
 * healthy and no dependency on a fuel health endpoint / model name / auth:
 *   - CLOSED: claim normally. `threshold` consecutive fuel-signature failures → OPEN.
 *   - OPEN: do not claim; the cards wait in the queue. After a cooldown (exponential
 *     backoff, capped) → HALF-OPEN.
 *   - HALF-OPEN: let exactly one card through as a live trial. Its outcome decides:
 *       fuel-error → back to OPEN with a longer cooldown; anything else (the fuel
 *       answered — success, or a downstream verify/acceptance/git failure) → CLOSED.
 * A sustained outage therefore burns at most one trial card per cooldown, not 62.
 */

export type RunOutcome = "ok" | "fuel-error" | "other-error";

/** Does this run error look like the FUEL failing (gateway/model unreachable or
 *  refusing), as opposed to the agent working but the change failing downstream
 *  (verify/acceptance/git/PR)? Conservative on purpose — a false "not fuel" only
 *  means we don't trip on a non-fuel issue, which is correct. The strong signals
 *  are the CLI turn-drivers reporting no result event, plus hard gateway errors. */
export function isFuelError(err: string): boolean {
  const s = err.toLowerCase();
  return (
    // CLI turn drivers (cursor-cli / openhands / claude-cli) — no real turn.
    /(cursor-agent|openhands|claude) .*(cli pass failed|exited \d+ without|without a result event|without jsonl)/.test(s) ||
    /openhands exited 0 without jsonl/.test(s) ||
    // Native afl engine / any HTTP client → the gateway is unreachable or erroring.
    /\b(econnrefused|etimedout|enotfound|econnreset|socket hang up|fetch failed|network error)\b/.test(s) ||
    /\b(429|500|502|503|504)\b[^\n]*\b(litellm|gateway|upstream|completion|model|proxy|anthropic|openai)\b/.test(s) ||
    /(no healthy (deployment|endpoint)|all model|overloaded_error|overloaded|rate.?limit|too many requests|bad gateway|service unavailable|gateway time)/.test(s) ||
    /(llm|model|completion) (call|request) (failed|errored|timed out)/.test(s)
  );
}

export interface FuelBreakerOpts {
  threshold?: number;
  baseCooldownMs?: number;
  maxCooldownMs?: number;
  now?: () => number;
}

export class FuelBreaker {
  private state: "closed" | "open" | "half" = "closed";
  private fails = 0;
  private openUntil = 0;
  private cooldownMs: number;
  private readonly threshold: number;
  private readonly baseCooldownMs: number;
  private readonly maxCooldownMs: number;
  private readonly now: () => number;

  constructor(opts: FuelBreakerOpts = {}) {
    this.threshold = opts.threshold ?? (Number(process.env.BROKK_FUEL_BREAKER_THRESHOLD) || 3);
    this.baseCooldownMs = opts.baseCooldownMs ?? (Number(process.env.BROKK_FUEL_BREAKER_COOLDOWN_MS) || 60_000);
    this.maxCooldownMs = opts.maxCooldownMs ?? (Number(process.env.BROKK_FUEL_BREAKER_MAX_MS) || 15 * 60_000);
    this.cooldownMs = this.baseCooldownMs;
    this.now = opts.now ?? (() => Date.now());
  }

  /** May the runner claim a card now? OPEN blocks; once the cooldown elapses it
   *  flips to HALF-OPEN and lets trials through until one records an outcome. */
  canClaim(): boolean {
    if (this.state === "open") {
      if (this.now() >= this.openUntil) {
        this.state = "half";
        return true;
      }
      return false;
    }
    return true; // closed, or half-open (awaiting a trial's outcome)
  }

  /** How long (ms) until the next claim attempt while OPEN. 0 when not blocking. */
  retryInMs(): number {
    return this.state === "open" ? Math.max(0, this.openUntil - this.now()) : 0;
  }

  get isOpen(): boolean {
    return this.state === "open";
  }

  /** Record a completed run's outcome. Returns a human note when the breaker
   *  changed state (for logging), else null. */
  record(outcome: RunOutcome): string | null {
    if (outcome === "fuel-error") {
      this.fails += 1;
      if (this.state === "half" || this.fails >= this.threshold) return this.trip();
      return null;
    }
    // The fuel answered (success, or a non-fuel downstream failure) → recover.
    const wasNotClosed = this.state !== "closed";
    this.fails = 0;
    this.state = "closed";
    this.cooldownMs = this.baseCooldownMs;
    return wasNotClosed ? "fuel recovered — resuming claims" : null;
  }

  private trip(): string {
    this.state = "open";
    this.openUntil = this.now() + this.cooldownMs;
    const note = `fuel breaker OPEN — pausing claims ${Math.round(this.cooldownMs / 1000)}s (cards stay queued)`;
    this.cooldownMs = Math.min(this.cooldownMs * 2, this.maxCooldownMs);
    return note;
  }
}
