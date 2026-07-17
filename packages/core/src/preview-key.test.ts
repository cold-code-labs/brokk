import assert from "node:assert/strict";
import { test } from "node:test";
import { mintPreviewKey, PREVIEW_KEY_TTL_S, verifyPreviewKey } from "./index.js";

const SECRET = "s3cr3t-hmac-key";
const OTHER = "a-different-secret";
const NOW = 1_800_000_000_000;

test("a freshly minted key opens its own subdomain", () => {
  const key = mintPreviewKey(SECRET, "viken", NOW);
  assert.equal(verifyPreviewKey(SECRET, "viken", key, NOW), true);
});

test("a key is bound to ONE subdomain — this is the whole point", () => {
  const key = mintPreviewKey(SECRET, "viken", NOW);
  assert.equal(verifyPreviewKey(SECRET, "maglink-dev", key, NOW), false);
});

test("a key goes stale after the TTL", () => {
  const key = mintPreviewKey(SECRET, "viken", NOW);
  const justInside = NOW + PREVIEW_KEY_TTL_S * 1000 - 1000;
  const justOutside = NOW + PREVIEW_KEY_TTL_S * 1000 + 1000;
  assert.equal(verifyPreviewKey(SECRET, "viken", key, justInside), true);
  assert.equal(verifyPreviewKey(SECRET, "viken", key, justOutside), false);
});

test("a key from another secret never opens anything", () => {
  const forged = mintPreviewKey(OTHER, "viken", NOW);
  assert.equal(verifyPreviewKey(SECRET, "viken", forged, NOW), false);
});

test("an unset secret is CLOSED, not open — the fail-open trap", () => {
  const key = mintPreviewKey(SECRET, "viken", NOW);
  assert.equal(verifyPreviewKey("", "viken", key, NOW), false);
  // Even a key minted from the empty secret must not open an unconfigured gate.
  assert.equal(verifyPreviewKey("", "viken", mintPreviewKey("", "viken", NOW), NOW), false);
});

test("garbage never verifies", () => {
  for (const junk of [
    "",
    ".",
    "abc",
    "notanumber.sig",
    `${Math.floor(NOW / 1000) + 60}.`,
    `${Math.floor(NOW / 1000) + 60}.wrongsig`,
    // exp claiming the far future with no real signature
    "99999999999.AAAA",
  ]) {
    assert.equal(verifyPreviewKey(SECRET, "viken", junk, NOW), false, `opened on: ${junk}`);
  }
});

test("the expiry is not attacker-editable — moving it breaks the signature", () => {
  const key = mintPreviewKey(SECRET, "viken", NOW);
  const sig = key.slice(key.indexOf(".") + 1);
  const farFuture = Math.floor(NOW / 1000) + PREVIEW_KEY_TTL_S * 100;
  // Replay the real signature under a stretched exp: must not verify, or the TTL
  // would be decoration.
  assert.equal(verifyPreviewKey(SECRET, "viken", `${farFuture}.${sig}`, NOW), false);
});
