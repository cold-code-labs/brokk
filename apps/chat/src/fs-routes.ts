// ─────────────────────────────────────────────────────────────────────────────
// File viewer — a browser-over-the-wire onto a Sindri session's working checkout.
// Sindri (not the API) mounts brokk_home and owns the checkouts, so the fs routes
// live HERE and the browser reaches them through the existing /api/chat/* proxy
// (no new control-plane route). Read-only listing + file read, plus a guarded
// write so the user can drop a file straight into the worktree (it hot-reloads in
// the dev preview like any edit). Keyed by sessionId; every path is confined to
// the checkout root — no traversal escapes, no writing into .git/node_modules.
// ─────────────────────────────────────────────────────────────────────────────

import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { Hono } from "hono";
import type { CheckoutManager } from "./checkout.js";

/** Directories we never surface (noise / heavy / secret) — hidden from listings
 *  AND refused as write targets. */
const HIDDEN = new Set([
  ".git",
  "node_modules",
  ".next",
  "dist",
  "build",
  ".turbo",
  ".vercel",
  "coverage",
]);

/** Cap the inline text we ship for viewing (download always serves the full file). */
const MAX_VIEW = 512 * 1024;

/** Resolve a user-supplied relative path against the checkout root, refusing any
 *  escape (`..`, absolute, or symlink-out). Returns the absolute path, or null. */
function safe(root: string, rel: string): string | null {
  const clean = (rel ?? "").replace(/^[/\\]+/, "");
  const abs = resolve(root, clean);
  if (abs !== root && !abs.startsWith(root + sep)) return null;
  return abs;
}

/** A NUL byte in the first few KB → treat as binary (show "download", not text). */
function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export function fsRoutes(checkouts: CheckoutManager): Hono {
  const r = new Hono();

  // ── List a directory ────────────────────────────────────────────────────────
  // ready:false (not an error) when the session has no checkout yet, so the panel
  // renders a "suba o preview" hero instead of a failure.
  r.get("/sessions/:id/fs/list", async (c) => {
    const root = checkouts.existing(c.req.param("id"));
    if (!root) return c.json({ ready: false, path: "", entries: [] });
    const abs = safe(root, c.req.query("path") ?? "");
    if (!abs) return c.json({ error: "invalid path" }, 400);
    if (!existsSync(abs)) return c.json({ error: "not found" }, 404);

    const dirents = await readdir(abs, { withFileTypes: true });
    const entries = await Promise.all(
      dirents
        .filter((d) => !(d.isDirectory() && HIDDEN.has(d.name)))
        .map(async (d) => {
          const isDir = d.isDirectory();
          const size = isDir
            ? 0
            : await stat(join(abs, d.name)).then((s) => s.size).catch(() => 0);
          return { name: d.name, type: isDir ? "dir" : "file", size };
        }),
    );
    // Folders first, then files, each alphabetical.
    entries.sort((a, b) =>
      a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1,
    );
    return c.json({ ready: true, path: relative(root, abs), entries });
  });

  // ── Read one file ─────────────────────────────────────────────────────────────
  // ?raw=1 streams the raw bytes as an attachment (download / binary passthrough);
  // otherwise returns JSON with a (capped) utf8 preview + a `binary` flag.
  r.get("/sessions/:id/fs/read", async (c) => {
    const root = checkouts.existing(c.req.param("id"));
    if (!root) return c.json({ error: "no checkout" }, 409);
    const abs = safe(root, c.req.query("path") ?? "");
    if (!abs) return c.json({ error: "invalid path" }, 400);
    if (!existsSync(abs)) return c.json({ error: "not found" }, 404);
    const st = await stat(abs);
    if (st.isDirectory()) return c.json({ error: "is a directory" }, 400);

    const buf = await readFile(abs);
    if (c.req.query("raw")) {
      return new Response(new Uint8Array(buf), {
        headers: {
          "content-type": "application/octet-stream",
          "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(basename(abs))}`,
        },
      });
    }
    const binary = isBinary(buf);
    return c.json({
      path: relative(root, abs),
      size: st.size,
      binary,
      truncated: !binary && buf.length > MAX_VIEW,
      content: binary ? "" : buf.subarray(0, MAX_VIEW).toString("utf8"),
    });
  });

  // ── Write / upload a file ─────────────────────────────────────────────────────
  // The body is the raw file bytes; ?path is where it lands (relative to the
  // checkout). Creates parent dirs. Refuses protected trees. Mutating → the /api
  // proxy already gates this behind a Logto session + the runner secret.
  r.post("/sessions/:id/fs/write", async (c) => {
    const root = checkouts.existing(c.req.param("id"));
    if (!root) return c.json({ error: "no checkout" }, 409);
    const abs = safe(root, c.req.query("path") ?? "");
    if (!abs || abs === root) return c.json({ error: "invalid path" }, 400);
    const rel = relative(root, abs);
    if (rel.split(sep).some((seg) => HIDDEN.has(seg)))
      return c.json({ error: "protected path" }, 400);

    const body = Buffer.from(await c.req.arrayBuffer());
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, new Uint8Array(body));
    return c.json({ ok: true, path: rel, size: body.length });
  });

  return r;
}
