/**
 * Fingerprint — the identity of a finding ACROSS runs (ADR 0087 §5).
 *
 * The line number is deliberately absent: code moves, the defect doesn't. If the
 * fingerprint shifted every time a file grew a line, the ledger would re-raise
 * everything the reviewer already dismissed, which is the exact failure it exists
 * to prevent.
 *
 * Measured on the PoC (arte-one, 2026-08-06): anchoring on an LLM-authored rule
 * slug deduped 3/10 across two passes over the SAME commit — the model does not
 * reproduce its own slug. Hence: only deterministic parts go in the key.
 */
import { createHash } from "node:crypto";

/** Flatten accents/case/punctuation/digits so the title isn't a brittle key. */
export function normalizeTitle(s: string): string {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/`[^`]*`/g, " ")
    .replace(/\d+/g, "#")
    .replace(/[^a-z#\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function fingerprint(f: {
  lensId: string;
  filePath?: string | null;
  title: string;
}): string {
  const parts = [
    f.lensId,
    (f.filePath ?? "").replace(/^\.\//, "").trim(),
    normalizeTitle(f.title),
  ];
  return createHash("sha256").update(parts.join(" ")).digest("hex").slice(0, 32);
}
