import Link from "next/link";

import { ThemeToggle } from "../components/ThemeToggle";
import { getSession } from "../lib/logto";

export const dynamic = "force-dynamic";

const GITHUB = "https://github.com/cold-code-labs/brokk";

/**
 * The public face of Brokk — the marketing landing served at `/` to anyone,
 * logged in or not. The authed console lives under the `(app)` group behind
 * Logto; the primary CTA here is the login (wired to CCL ID) or, if you already
 * have a session, a shortcut straight into the forge.
 */
export default async function Landing() {
  const session = await getSession();
  const loggedIn = session.isAuthenticated;
  const primaryHref = loggedIn ? "/fleet" : "/sign-in";
  const primaryLabel = loggedIn ? "Open the forge" : "Log in";

  return (
    <div className="lp">
      {/* ── Nav ── */}
      <header className="lp-nav">
        <div className="lp-shell lp-nav-inner">
          <Link href="/" className="lp-brand">
            <span className="lp-brand-mark">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/brokk.svg" alt="" />
            </span>
            <span className="lp-brand-name">Brokk</span>
          </Link>
          <nav className="lp-nav-links">
            <a href="#features">Features</a>
            <a href="#how">How it works</a>
            <a href="#cast">The cast</a>
            <a href={GITHUB} target="_blank" rel="noreferrer">
              Source
            </a>
          </nav>
          <div className="lp-nav-cta">
            <ThemeToggle />
            <Link href={primaryHref} className="lp-btn lp-btn-primary">
              {primaryLabel}
              <Arrow />
            </Link>
          </div>
        </div>
      </header>

      {/* ── Hero ── */}
      <section className="lp-hero">
        <div className="lp-aurora" aria-hidden />
        <div className="lp-grid-overlay" aria-hidden />
        <div className="lp-shell lp-hero-inner">
          <div className="lp-hero-copy">
            <span className="lp-eyebrow">
              <span className="lp-dot" /> The Cold Code Labs code pillar · Open
              source
            </span>
            <h1 className="lp-title">
              Drop a card.
              <br />
              Get a Pull Request.
            </h1>
            <p className="lp-lede">
              Brokk is a forge of autonomous coding agents. Each card is claimed by
              a runner, forged in its own isolated worktree, and shipped as a
              reviewed PR. <strong>Mímir</strong> advises, <strong>Brokkr</strong>{" "}
              forges, <strong>Eitri</strong> reviews — many runners, one queue, in
              parallel.
            </p>
            <div className="lp-hero-actions">
              <Link href={primaryHref} className="lp-btn lp-btn-primary lp-btn-lg">
                {primaryLabel}
                <Arrow />
              </Link>
              <a
                href={GITHUB}
                target="_blank"
                rel="noreferrer"
                className="lp-btn lp-btn-ghost lp-btn-lg"
              >
                <GithubMark />
                View source
              </a>
            </div>
            <p className="lp-hero-meta">
              Apache-2.0 · Self-hosted · Login secured by CCL ID
            </p>
          </div>

          {/* Board vignette — the forge's queue, stylised: cards moving to PR. */}
          <div className="lp-console" aria-hidden>
            <div className="lp-console-bar">
              <span className="lp-console-dots">
                <i /> <i /> <i />
              </span>
              <span className="lp-console-title">brokk · forge queue</span>
            </div>
            <div className="lp-console-body">
              <div className="lp-console-stats">
                <div>
                  <b>6</b>
                  <span>forging</span>
                </div>
                <div>
                  <b>12</b>
                  <span>in review</span>
                </div>
                <div>
                  <b>48</b>
                  <span>merged</span>
                </div>
              </div>
              <ul className="lp-console-list">
                {[
                  ["fix flaky auth test", "forging", "brokkr"],
                  ["add /health endpoint", "review", "eitri"],
                  ["rate-limit the webhook", "forging", "brokkr"],
                  ["port zyramed consultas", "merged", "PR #218"],
                  ["dark-mode the settings", "merged", "PR #217"],
                ].map(([task, status, who]) => (
                  <li key={task}>
                    <span className={`lp-status lp-status-${status}`} />
                    <span className="lp-console-app">{task}</span>
                    <span className="lp-console-node">{who}</span>
                    <span className="lp-console-state">{status}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* ── Value strip ── */}
      <section className="lp-strip">
        <div className="lp-shell lp-strip-inner">
          {[
            ["Advise", "Mímir turns a prompt into a plan"],
            ["Forge", "one isolated worktree per card"],
            ["Review", "security scan + LLM on every PR"],
            ["Ship", "commit, push, open the Pull Request"],
          ].map(([k, v]) => (
            <div key={k} className="lp-strip-cell">
              <b>{k}</b>
              <span>{v}</span>
            </div>
          ))}
        </div>
      </section>

      {/* ── Features ── */}
      <section id="features" className="lp-section">
        <div className="lp-shell">
          <div className="lp-section-head">
            <span className="lp-kicker">Everything the forge needs</span>
            <h2>A board. A queue. A fleet of agents.</h2>
            <p>
              Brokk is the shell — board, queue, runner orchestration, GitHub and
              PRs. The brain is a native agent kernel. Point it at your repos and
              let the fleet pull work in parallel.
            </p>
          </div>
          <div className="lp-features">
            {FEATURES.map((f) => (
              <article key={f.title} className="lp-card">
                <span className="lp-card-icon">{f.icon}</span>
                <h3>{f.title}</h3>
                <p>{f.body}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* ── How it works ── */}
      <section id="how" className="lp-section lp-section-alt">
        <div className="lp-shell">
          <div className="lp-section-head">
            <span className="lp-kicker">From issue to merge</span>
            <h2>Three strikes on the anvil.</h2>
          </div>
          <div className="lp-steps">
            {STEPS.map((s, i) => (
              <div key={s.title} className="lp-step">
                <span className="lp-step-num">{String(i + 1).padStart(2, "0")}</span>
                <h3>{s.title}</h3>
                <p>{s.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── The cast (agents) ── */}
      <section id="cast" className="lp-section">
        <div className="lp-shell">
          <div className="lp-section-head">
            <span className="lp-kicker">The cast of the forge</span>
            <h2>Named agents, each with a craft.</h2>
            <p>
              Every part of the pipeline is a character on the native{" "}
              <strong>Afl</strong> kernel — no black box, all open source.
            </p>
          </div>
          <div className="lp-cast">
            {CAST.map((c) => (
              <div key={c.name} className="lp-cast-row">
                <span className="lp-cast-name">{c.name}</span>
                <span className="lp-cast-role">{c.role}</span>
                <span className="lp-cast-body">{c.body}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Sindri band ── */}
      <section className="lp-section lp-section-alt">
        <div className="lp-shell lp-aegir">
          <div className="lp-aegir-copy">
            <span className="lp-kicker">Meet Sindri</span>
            <h2>Or just talk to the forge.</h2>
            <p>
              Not every change starts as a card. Sindri is the conversational build
              persona — describe what you want, watch it plan, forge, and open the
              PR in a live preview. The whole fleet, at the end of a sentence.
            </p>
            <Link href={primaryHref} className="lp-btn lp-btn-primary">
              {loggedIn ? "Open Sindri" : "Log in to try it"}
              <Arrow />
            </Link>
          </div>
          <div className="lp-chat" aria-hidden>
            <div className="lp-bubble lp-bubble-user">
              Add a rate limit to the public API — 100 req/min per key
            </div>
            <div className="lp-bubble lp-bubble-ai">
              <span className="lp-ai-tag">
                <span className="lp-brand-mark lp-brand-mark-sm">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src="/brokk.svg" alt="" />
                </span>
                Sindri
              </span>
              On it. Worktree up, adding a token-bucket middleware to{" "}
              <b>apps/api</b>, wiring the 429 path, and a test. I&apos;ll open a PR
              when the verify passes. ✳︎
            </div>
          </div>
        </div>
      </section>

      {/* ── Final CTA ── */}
      <section className="lp-cta">
        <div className="lp-aurora lp-aurora-soft" aria-hidden />
        <div className="lp-shell lp-cta-inner">
          <h2>Light the forge.</h2>
          <p>
            Sign in with your CCL ID and put the fleet to work — or read the source
            and run your own.
          </p>
          <div className="lp-hero-actions lp-cta-actions">
            <Link href={primaryHref} className="lp-btn lp-btn-primary lp-btn-lg">
              {primaryLabel}
              <Arrow />
            </Link>
            <a
              href={GITHUB}
              target="_blank"
              rel="noreferrer"
              className="lp-btn lp-btn-ghost lp-btn-lg"
            >
              <GithubMark />
              GitHub
            </a>
          </div>
        </div>
      </section>

      {/* ── Footer ── */}
      <footer className="lp-footer">
        <div className="lp-shell lp-footer-inner">
          <div className="lp-brand">
            <span className="lp-brand-mark">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/brokk.svg" alt="" />
            </span>
            <span className="lp-brand-name">Brokk</span>
          </div>
          <p className="lp-footer-note">
            A pillar of{" "}
            <a href="https://coldcodelabs.com" target="_blank" rel="noreferrer">
              Cold Code Labs
            </a>{" "}
            · Apache-2.0
          </p>
          <nav className="lp-footer-links">
            <a href={GITHUB} target="_blank" rel="noreferrer">
              GitHub
            </a>
            <Link href={primaryHref}>{primaryLabel}</Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}

/* ── Content ── */

const FEATURES = [
  {
    title: "The board",
    body: "A Linear-style queue of cards. Drop an issue, watch it get claimed, forged, and land as a PR — every state, live.",
    icon: <IconBoard />,
  },
  {
    title: "Parallel runners",
    body: "Many runners pull from one queue at once. Each claims a card, spins an isolated git worktree, and works alone.",
    icon: <IconPulse />,
  },
  {
    title: "Security-reviewed PRs",
    body: "Eitri scans every diff — semgrep + trivy plus an LLM verdict — before the Pull Request ever reaches a human.",
    icon: <IconShield />,
  },
  {
    title: "Hardened isolation",
    body: "Env-allowlist, Landlock, egress split, and gVisor sandboxes. An agent's blast radius stops at its worktree.",
    icon: <IconVault />,
  },
  {
    title: "Discovery scout",
    body: "Huginn reads a fresh repo and returns a structured brief — mission, what's built, what's missing, the stack.",
    icon: <IconRoute />,
  },
  {
    title: "Open kernel",
    body: "Agents run native on the Afl kernel — one tool-loop, shared hands, no SDK. The whole forge is Apache-2.0.",
    icon: <IconSpark />,
  },
];

const STEPS = [
  {
    title: "Drop a card",
    body: "File an issue on the board — or just describe it to Sindri. Mímir qualifies the prompt and fans it into a plan of cards.",
  },
  {
    title: "The forge runs",
    body: "A runner claims the card, spins an isolated worktree, and Brokkr forges the change — build, verify, commit, push.",
  },
  {
    title: "Review & merge",
    body: "Eitri scans the diff and writes the review, then opens the PR. You read a clean, tested change and hit merge.",
  },
];

const CAST = [
  { name: "Mímir", role: "the counselor", body: "triages the prompt and fans it into a DAG of cards" },
  { name: "Brokkr", role: "the forge", body: "one worktree per card → build → verify → Pull Request" },
  { name: "Eitri", role: "the reviewer", body: "diff → semgrep + trivy + LLM verdict on every PR" },
  { name: "Sindri", role: "the chat", body: "the conversational build persona, with a live preview" },
  { name: "Huginn", role: "the scout", body: "reads a repo read-only → structured brief" },
  { name: "Afl", role: "the kernel", body: "the native gateway loop every agent runs on" },
];

/* ── Icons ── */

function Arrow() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="lp-ico">
      <path d="M5 12h14M13 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function GithubMark() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className="lp-ico">
      <path d="M12 2C6.48 2 2 6.58 2 12.25c0 4.53 2.87 8.37 6.84 9.73.5.1.68-.22.68-.49v-1.72c-2.78.62-3.37-1.37-3.37-1.37-.45-1.18-1.11-1.5-1.11-1.5-.91-.64.07-.62.07-.62 1 .07 1.53 1.06 1.53 1.06.9 1.57 2.34 1.12 2.91.85.09-.66.35-1.12.63-1.38-2.22-.26-4.55-1.14-4.55-5.06 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.3.1-2.71 0 0 .84-.28 2.75 1.05a9.34 9.34 0 0 1 5 0c1.91-1.33 2.75-1.05 2.75-1.05.55 1.41.2 2.45.1 2.71.64.72 1.03 1.63 1.03 2.75 0 3.93-2.34 4.79-4.57 5.05.36.32.68.94.68 1.9v2.82c0 .27.18.6.69.49A10.02 10.02 0 0 0 22 12.25C22 6.58 17.52 2 12 2z" />
    </svg>
  );
}
function IconBoard() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
      <rect x="3" y="4" width="5" height="16" rx="1.2" />
      <rect x="10" y="4" width="5" height="10" rx="1.2" />
      <rect x="17" y="4" width="4" height="13" rx="1.2" />
    </svg>
  );
}
function IconSpark() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
      <path d="M12 3v6M12 15v6M3 12h6M15 12h6" strokeLinecap="round" />
      <circle cx="12" cy="12" r="2.4" />
    </svg>
  );
}
function IconPulse() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
      <path d="M3 12h4l2 6 4-15 2 9h6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function IconShield() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
      <path d="M12 3l7 3v5c0 4.4-3 7.7-7 9-4-1.3-7-4.6-7-9V6l7-3z" strokeLinejoin="round" />
      <path d="M9 12l2 2 4-4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function IconVault() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
      <rect x="4" y="5" width="16" height="14" rx="2" />
      <circle cx="12" cy="12" r="3" />
      <path d="M12 12v3" strokeLinecap="round" />
    </svg>
  );
}
function IconRoute() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="18" cy="18" r="2.5" />
      <path d="M6 8.5V14a4 4 0 0 0 4 4h5.5" strokeLinecap="round" />
    </svg>
  );
}
