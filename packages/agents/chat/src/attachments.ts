// ─────────────────────────────────────────────────────────────────────────────
// Chat attachments → `.brokk/inbox/<safe-filename>` + turn-context injection.
// The composer uploads via the existing session fs/write; this module sanitises
// names, validates relative inbox paths, and builds the short block the model
// sees so it can read the files with FS tools (no parsers — just paths).
// ─────────────────────────────────────────────────────────────────────────────

/** Directory (relative to the session checkout) where client drops land. */
export const INBOX_DIR = ".brokk/inbox";

/** Strip path junk; keep a short, filesystem-safe basename. */
export function safeInboxFilename(name: string): string {
  const base = (name ?? "").split(/[/\\]/).pop() ?? "";
  const cleaned = base
    .replace(/[^\w.\-+() ]+/g, "_")
    .replace(/^\.+/, "")
    .trim();
  const out = cleaned || "file";
  return out.slice(0, 180);
}

/** Relative checkout path for a client filename. */
export function inboxRelPath(filename: string): string {
  return `${INBOX_DIR}/${safeInboxFilename(filename)}`;
}

/** Keep only paths that clearly live under `.brokk/inbox/` (no traversal). */
export function normalizeInboxPaths(paths: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of paths) {
    const p = (raw ?? "").replace(/\\/g, "/").replace(/^\/+/, "").trim();
    if (!p.startsWith(`${INBOX_DIR}/`)) continue;
    if (p.includes("..") || p.includes("\0")) continue;
    const rest = p.slice(INBOX_DIR.length + 1);
    if (!rest || rest.includes("/")) continue; // flat inbox only
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

/** Short model-context block listing inbox paths for this turn. Empty → "". */
export function attachmentContextBlock(paths: readonly string[]): string {
  const clean = normalizeInboxPaths(paths);
  if (!clean.length) return "";
  return [
    "## Attachments (this turn)",
    "Client files were saved into this checkout under `.brokk/inbox/`. Read them with your FS tools (`read_file` / `bash`); do not ask the user to re-upload or paste their contents.",
    ...clean.map((p) => `- \`${p}\``),
  ].join("\n");
}
