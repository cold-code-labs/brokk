"use client";

/**
 * Forge lintel — brand · (empty) · Anvil · user.
 * Rooms/bench live in the cockpit stage or Settings; header stays clean.
 */

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { Anvil, ChevronDown } from "lucide-react";
import { useProject } from "../lib/project-context";
import { useCockpitOptional } from "../lib/cockpit-context";
import { ComposerMenu } from "./ComposerMenu";

type TopbarUserProps = { name: string; role?: string; authDisabled: boolean };

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0][0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1][0] ?? "") : "";
  return (first + last).toUpperCase();
}

function AnvilMenu() {
  const { projects, currentId, setCurrentId, pinnedIds, getLastSession } = useProject();
  const path = usePathname();
  const router = useRouter();
  const cockpit = useCockpitOptional();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const btnRef = useRef<HTMLButtonElement>(null);
  const current = projects.find((p) => p.id === currentId);
  const label = current?.name ?? (projects.length ? "Pick project" : "No project");

  const ordered = useMemo(() => {
    const pinSet = new Set(pinnedIds);
    const pinned = pinnedIds
      .map((id) => projects.find((p) => p.id === id))
      .filter((p): p is NonNullable<typeof p> => !!p);
    const rest = projects
      .filter((p) => !pinSet.has(p.id))
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name));
    return [...pinned, ...rest];
  }, [projects, pinnedIds]);

  function pick(id: string) {
    setCurrentId(id);
    setOpen(false);
    if (cockpit && path === "/fleet") {
      cockpit.openProjectChat(id);
      return;
    }
    if (path.startsWith("/projects/")) router.push(`/projects/${id}`);
    else if (path.startsWith("/chat")) {
      const sid = getLastSession(id);
      router.push(sid ? `/chat?session=${encodeURIComponent(sid)}` : "/chat");
    }
  }

  return (
    <div className={`forge-slot${open ? " is-open" : ""}`}>
      <button
        ref={btnRef}
        type="button"
        className={`forge-ctrl forge-anvil${open ? " is-open" : ""}`}
        aria-label={`Project on the anvil: ${label}`}
        aria-expanded={open}
        aria-haspopup="listbox"
        disabled={projects.length === 0}
        title={label}
        onClick={() => {
          if (!ordered.length) return;
          setActive(Math.max(0, ordered.findIndex((p) => p.id === currentId)));
          setOpen((v) => !v);
        }}
      >
        <Anvil size={15} strokeWidth={1.75} aria-hidden className="forge-ctrl-ico" />
        <span className="forge-anvil-name">{label}</span>
        <ChevronDown size={14} strokeWidth={1.75} aria-hidden className="forge-ctrl-caret" />
      </button>
      <ComposerMenu
        open={open}
        placement="below"
        portal
        anchorRef={btnRef}
        align="start"
        items={ordered.map((p) => ({
          id: p.id,
          label: p.name,
          hint: p.id === currentId
            ? "on the anvil"
            : pinnedIds.includes(p.id)
              ? "pinned"
              : undefined,
          tag: p.id === currentId ? "live" : pinnedIds.includes(p.id) ? "pin" : undefined,
        }))}
        activeIndex={active}
        onActiveIndex={setActive}
        onPick={pick}
        onClose={() => setOpen(false)}
        emptyHint="Connect a repo first"
      />
    </div>
  );
}

/** Digits 1–9 → open pinned anvil chat (skip when typing in a field). */
function useHousePinKeys() {
  const { pinnedProjects, setCurrentId, getLastSession } = useProject();
  const router = useRouter();
  const cockpit = useCockpitOptional();
  const path = usePathname();
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t) {
        const tag = t.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t.isContentEditable) {
          return;
        }
      }
      const n = Number(e.key);
      if (!Number.isInteger(n) || n < 1 || n > 9) return;
      const proj = pinnedProjects[n - 1];
      if (!proj) return;
      e.preventDefault();
      setCurrentId(proj.id);
      if (cockpit && path === "/fleet") {
        cockpit.openProjectChat(proj.id);
        return;
      }
      const sid = getLastSession(proj.id);
      router.push(sid ? `/chat?session=${encodeURIComponent(sid)}` : "/chat");
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pinnedProjects, setCurrentId, getLastSession, router, cockpit, path]);
}

function UserMenu({ user }: { user: TopbarUserProps }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const btnRef = useRef<HTMLButtonElement>(null);
  const router = useRouter();
  return (
    <div className={`forge-slot forge-user-slot${open ? " is-open" : ""}`}>
      <button
        ref={btnRef}
        type="button"
        className={`forge-ctrl forge-avatar${open ? " is-open" : ""}`}
        aria-label={user.name}
        aria-expanded={open}
        title={user.name}
        onClick={() => setOpen((v) => !v)}
      >
        {initials(user.name)}
      </button>
      <ComposerMenu
        open={open}
        placement="below"
        portal
        anchorRef={btnRef}
        align="end"
        items={[
          {
            id: "who",
            label: user.name,
            hint: user.authDisabled ? "auth off" : user.role || "member",
          },
          { id: "settings", label: "Configurações", tag: "gear" },
          { id: "out", label: "Sign out", tag: "leave" },
        ]}
        activeIndex={active}
        onActiveIndex={setActive}
        onPick={(id) => {
          setOpen(false);
          if (id === "settings") router.push("/settings");
          if (id === "out") window.location.href = "/sign-out";
        }}
        onClose={() => setOpen(false)}
      />
    </div>
  );
}

export default function Topbar({ user }: { user?: TopbarUserProps }) {
  useHousePinKeys();

  return (
    <header className="forge-lintel" aria-label="Brokk forge lintel">
      <div className="forge-lintel-inner">
        <Link href="/fleet" className="forge-brand" aria-label="Brokk">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brokk.svg" alt="" width={22} height={30} className="forge-brand-mark" />
          <span className="forge-brand-word">Brokk</span>
        </Link>

        <div className="forge-lintel-spacer" aria-hidden />

        <AnvilMenu />
        {user ? <UserMenu user={user} /> : null}
      </div>
    </header>
  );
}
