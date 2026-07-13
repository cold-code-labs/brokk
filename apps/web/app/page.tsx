import Link from "next/link";

import { ThemeToggle } from "../components/ThemeToggle";
import { getSession } from "../lib/logto";

export const dynamic = "force-dynamic";

const GITHUB = "https://github.com/cold-code-labs/brokk";

/**
 * The public face of Brokk — "The Forge at Night", carried out of the app's own
 * Fleet aesthetic (see app/fleet.css): cold sky-blue steel for structure, one
 * warm ember reserved for live/forging work. Served at `/` to anyone; the authed
 * forge lives under the `(app)` group behind Logto.
 */
export default async function Landing() {
  const session = await getSession();
  const loggedIn = session.isAuthenticated;
  const primaryHref = loggedIn ? "/fleet" : "/sign-in";
  const primaryLabel = loggedIn ? "Enter the forge" : "Light the forge";

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
            <a href="#forge">The forge</a>
            <a href="#crew">The crew</a>
            <a href="#how">How it works</a>
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
        <div className="lp-dotgrid" aria-hidden />
        <div className="lp-sparks" aria-hidden>
          {SPARKS.map((s, i) => (
            <span key={i} style={s} />
          ))}
        </div>
        <div className="lp-shell lp-hero-inner">
          <div className="lp-hero-copy">
            <span className="lp-eyebrow">
              <Anvil /> Open-source coding forge · a Cold Code Labs pillar
            </span>
            <h1 className="lp-title">
              Feed it work.
              <br />
              It forges <span className="lp-hot">Pull Requests</span>.
            </h1>
            <p className="lp-lede">
              Brokk is a forge of autonomous coding agents. Drop a card — or just
              say what you want — and a crew of dwarven smiths claims it, hammers it
              out in its own isolated worktree, and hands back a tested,
              security-reviewed Pull Request. Many anvils, one queue, all night
              long.
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
                Read the source
              </a>
            </div>
            <p className="lp-hero-meta">
              Apache-2.0 · self-hosted · a crew that never puts down the hammer
            </p>
          </div>

          {/* The forge scene — the smith beside his live anvil (the queue). */}
          <div className="lp-scene" aria-hidden>
            <div className="lp-smith">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/brokk.svg" alt="" />
            </div>
            <div className="lp-anvil">
              <div className="lp-anvil-bar">
                <span className="lp-run-dot" />
                <span className="lp-anvil-title">the anvil · forging now</span>
              </div>
              <div className="lp-anvil-body">
                <ul className="lp-queue">
                  {[
                    ["rate-limit the public API", "forging", "Brokkr", true],
                    ["fix the flaky auth test", "on the anvil", "Brokkr", true],
                    ["add a /health endpoint", "inspecting", "Eitri", false],
                    ["port the consultas flow", "shipped", "PR #218", false],
                    ["dark-mode the settings", "shipped", "PR #217", false],
                  ].map(([task, state, who, live]) => (
                    <li key={task as string} className={live ? "is-live" : ""}>
                      <span className={`lp-billet ${live ? "lit" : ""}`} />
                      <span className="lp-q-task">{task}</span>
                      <span className="lp-q-who">{who}</span>
                      <span className="lp-q-state">{state}</span>
                    </li>
                  ))}
                </ul>
                <div className="lp-anvil-foot">
                  <b>3</b> forging · <b>5</b> inspecting · <b>61</b> shipped today
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── The forge cycle (ember strip) ── */}
      <section className="lp-strip">
        <div className="lp-shell lp-strip-inner">
          {[
            ["Counsel", "Mímir turns intent into a plan", "01"],
            ["Forge", "one anvil — one worktree — per card", "02"],
            ["Inspect", "Eitri scans every blade that leaves", "03"],
            ["Ship", "commit, push, open the Pull Request", "04"],
          ].map(([k, v, n]) => (
            <div key={k} className="lp-strip-cell">
              <span className="lp-strip-num">{n}</span>
              <b>{k}</b>
              <span className="lp-strip-note">{v}</span>
            </div>
          ))}
        </div>
      </section>

      {/* ── The forge (features) ── */}
      <section id="forge" className="lp-section">
        <div className="lp-shell">
          <div className="lp-section-head">
            <span className="lp-kicker">Inside the forge</span>
            <h2>A queue of work, hammered in parallel.</h2>
            <p>
              Brokk is the forge — the board, the queue, the runners, the fire.
              Point a crew of agents at your repos and they pull work off the anvil
              at once, each alone in its own worktree, none in the other&apos;s way.
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

      {/* ── The crew (the cast) ── */}
      <section id="crew" className="lp-section lp-section-alt">
        <div className="lp-shell">
          <div className="lp-section-head">
            <span className="lp-kicker">The crew at the anvil</span>
            <h2>Six smiths. One fire.</h2>
            <p>
              Every stage of the forge is a named agent on the open{" "}
              <strong>Afl</strong> kernel — no black box, all Apache-2.0.
            </p>
          </div>
          <div className="lp-crew">
            {CREW.map((c) => (
              <div key={c.name} className="lp-crew-row">
                <span className="lp-crew-mark">{c.icon}</span>
                <span className="lp-crew-name">{c.name}</span>
                <span className="lp-crew-role">{c.role}</span>
                <span className="lp-crew-body">{c.body}</span>
              </div>
            ))}
          </div>
          <p className="lp-myth">
            In the Prose Edda, the dwarves <strong>Brokkr</strong> and{" "}
            <strong>Sindri</strong> forged Mjölnir, Gungnir and Draupnir — while
            Loki, in the shape of a fly, bit the smith working the bellows. He never
            stopped pumping. Neither does this one.
          </p>
        </div>
      </section>

      {/* ── How it works ── */}
      <section id="how" className="lp-section">
        <div className="lp-shell">
          <div className="lp-section-head">
            <span className="lp-kicker">From issue to merge</span>
            <h2>Three strikes on the anvil.</h2>
          </div>
          <div className="lp-steps">
            {STEPS.map((s, i) => (
              <div key={s.title} className="lp-step">
                <span className="lp-step-num">{String(i + 1).padStart(2, "0")}</span>
                <span className="lp-step-line" aria-hidden />
                <h3>{s.title}</h3>
                <p>{s.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Chat band ── */}
      <section className="lp-section lp-section-alt">
        <div className="lp-shell lp-forge-band">
          <div className="lp-band-copy">
            <span className="lp-kicker">Talk to Brokk</span>
            <h2>Not everything starts as a card.</h2>
            <p>
              Brokk is the AI you speak to. Describe the change in a sentence —
              watch it plan, forge it in a live preview, and open the PR while
              you read along. One conversation, from intent to merge.
            </p>
            <Link href={primaryHref} className="lp-btn lp-btn-primary">
              {loggedIn ? "Open Brokk Chat" : "Log in to try it"}
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
                Brokk
              </span>
              On it. Worktree up — token-bucket middleware into <b>apps/api</b>,
              the 429 path wired, a test to prove it. I&apos;ll raise the PR the
              moment verify goes green. <span className="lp-ember-mark" />
            </div>
          </div>
        </div>
      </section>

      {/* ── Final CTA ── */}
      <section className="lp-cta">
        <div className="lp-forge-glow" aria-hidden />
        <div className="lp-shell lp-cta-inner">
          <h2>Light the forge.</h2>
          <p>
            Sign in with your CCL ID and put the crew to work — or clone the source
            and raise your own fire.
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
            · forged in the open, Apache-2.0
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
    title: "One anvil per card",
    body: "Every runner claims a card and spins its own isolated git worktree. Dozens forge at once, off a single queue — none touching another's steel.",
    icon: <Anvil />,
  },
  {
    title: "Nothing leaves un-inspected",
    body: "Eitri scans every diff — semgrep + trivy, then an LLM verdict — before the Pull Request ever reaches a human. No blade ships untempered.",
    icon: <IconShield />,
  },
  {
    title: "The fire is caged",
    body: "Env-allowlist, Landlock, split egress, gVisor sandboxes. An agent's blast radius stops at its worktree — the forge can roar without burning the house.",
    icon: <IconCage />,
  },
  {
    title: "Talk to Brokk",
    body: "Brokk is the conversational AI — say what you want and watch it plan, forge, and open the PR in a live preview. Chat in, code out.",
    icon: <IconChat />,
  },
  {
    title: "Send a scout ahead",
    body: "Huginn the raven reads a fresh repo end to end and returns a structured brief — mission, what's built, what's missing, the stack.",
    icon: <IconRaven />,
  },
  {
    title: "Your fire, your rules",
    body: "Agents run native on the Afl kernel — one tool-loop, shared hands, no SDK. Self-host it, read every line, bend it to your forge. Apache-2.0.",
    icon: <IconFlame />,
  },
];

const STEPS = [
  {
    title: "Drop a card",
    body: "File an issue on the board — or just tell Brokk. It reads the intent, qualifies it, and fans it into a plan of cards ready for the anvil.",
  },
  {
    title: "The forge runs",
    body: "A runner claims a card, spins an isolated worktree, and Brokkr hammers the change — build, verify, commit, push — while the next runner takes the next card.",
  },
  {
    title: "Review & merge",
    body: "Eitri tempers the diff — security scan plus a written review — then raises the PR. You read a clean, tested change and pull the lever.",
  },
];

const CREW = [
  { name: "Mímir", role: "the counselor", body: "reads your intent and fans it into a plan of cards", icon: <IconScroll /> },
  { name: "Brokkr", role: "the smith", body: "one worktree per card — build, verify, Pull Request", icon: <Anvil /> },
  { name: "Eitri", role: "the inspector", body: "semgrep + trivy + an LLM verdict on every diff", icon: <IconShield /> },
  { name: "Huginn", role: "the scout", body: "flies a repo read-only, returns a structured map", icon: <IconRaven /> },
  { name: "Afl", role: "the fire", body: "the native kernel every smith works by", icon: <IconFlame /> },
];

const SPARKS: React.CSSProperties[] = [
  { left: "12%", bottom: "8%", animationDelay: "0s", animationDuration: "3.6s" },
  { left: "22%", bottom: "0%", animationDelay: "1.1s", animationDuration: "4.2s" },
  { left: "38%", bottom: "12%", animationDelay: "2.3s", animationDuration: "3.9s" },
  { left: "54%", bottom: "4%", animationDelay: "0.6s", animationDuration: "4.6s" },
  { left: "63%", bottom: "10%", animationDelay: "1.8s", animationDuration: "3.4s" },
  { left: "78%", bottom: "2%", animationDelay: "3.0s", animationDuration: "4.1s" },
  { left: "88%", bottom: "9%", animationDelay: "2.0s", animationDuration: "3.7s" },
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
/** The anvil — Brokk's own mark. */
function Anvil() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className="lp-ico">
      <path d="M4 8h11a4 4 0 0 1-4 4H9l-1 3h6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M6 15h8l1 3H5l1-3z" strokeLinejoin="round" />
      <path d="M15 8l3-2" strokeLinecap="round" />
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
function IconCage() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path d="M9 4v16M15 4v16M4 9h16M4 15h16" strokeLinecap="round" />
    </svg>
  );
}
function IconChat() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
      <path d="M5 5h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H9l-4 3v-3H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z" strokeLinejoin="round" />
    </svg>
  );
}
function IconRaven() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
      <path d="M3 7c3 0 5 2 7 5 1-2 3-3 6-3l5-2-2 4 2 2-5 1c-2 3-5 4-8 4-4 0-6-3-6-6" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="6.5" cy="7.5" r="0.6" fill="currentColor" stroke="none" />
    </svg>
  );
}
function IconFlame() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
      <path d="M12 3c1 3 5 5 5 9a5 5 0 0 1-10 0c0-2 1-3 2-4 .5 1 1.5 1.5 2 1 0-2-1-4 1-6z" strokeLinejoin="round" />
    </svg>
  );
}
function IconScroll() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
      <path d="M7 4h11v13a3 3 0 0 1-3 3H6a3 3 0 0 0 3-3V4z" strokeLinejoin="round" />
      <path d="M10 8h5M10 12h5" strokeLinecap="round" />
    </svg>
  );
}
