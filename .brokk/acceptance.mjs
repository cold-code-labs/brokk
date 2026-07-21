#!/usr/bin/env node
/**
 * BROKK-24 acceptance — prove the post-remediation isolation stack is effective.
 *
 * Typecheck alone cannot catch a brokk-sandbox that warns-and-continues without
 * Landlock, or a setuid bit that silently fails to drop the bash uid. This
 * receipt FAIL-CLOSES when the binary is present but the jail/uid-split is not
 * actually enforcing.
 *
 * Checks:
 *   1) Source contracts (Dockerfile setuid sandbox, ExecEnclave seam, egress entrypoint)
 *   2) Runtime: Landlock denies a sibling write; uid-split drops when setuid
 *   3) Screenshot of the booted app (receipt)
 *
 * Env: BROKK_ACCEPTANCE_URL, BROKK_CHROMIUM, BROKK_ACCEPTANCE_SHOT
 */
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = process.env.BROKK_ACCEPTANCE_URL;
const CHROME = process.env.BROKK_CHROMIUM;
const SHOT = process.env.BROKK_ACCEPTANCE_SHOT;

if (!BASE || !CHROME || !SHOT) {
  console.error("missing BROKK_ACCEPTANCE_URL / BROKK_CHROMIUM / BROKK_ACCEPTANCE_SHOT");
  process.exit(2);
}

const ROOT = dirname(fileURLToPath(import.meta.url));
const REPO = join(ROOT, "..");

function die(code, msg) {
  console.error(msg);
  process.exit(code);
}

function findSandboxBin() {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir) continue;
    const p = join(dir, "brokk-sandbox");
    try {
      if (statSync(p).isFile()) return p;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

function assertSourceContracts() {
  const forgeDocker = readFileSync(join(REPO, "apps/forge/Dockerfile"), "utf8");
  if (!/brokk-sandbox/.test(forgeDocker)) {
    die(1, "forge Dockerfile must ship brokk-sandbox");
  }
  if (!/chmod 4750 \/usr\/local\/bin\/brokk-sandbox/.test(forgeDocker)) {
    die(1, "forge Dockerfile must setuid brokk-sandbox (chmod 4750)");
  }
  if (!/adduser .*1002.*brokk-bash/.test(forgeDocker)) {
    die(1, "forge Dockerfile must create egress uid 1002 (brokk-bash)");
  }

  const entry = readFileSync(join(REPO, "tools/brokk-egress/entrypoint.sh"), "utf8");
  if (!/BROKK_EGRESS/.test(entry) || !/egress\.nft/.test(entry)) {
    die(1, "brokk-egress entrypoint must install the nft egress jail");
  }

  const enclave = readFileSync(join(REPO, "packages/afl/src/enclave.ts"), "utf8");
  for (const needle of [
    "export function shellEnv",
    "export class LocalEnclave",
    "export class SplitEnclave",
    "export function resolveEnclave",
    "export function needsCreds",
    "landlock",
    "BROKK_BASH_UID",
  ]) {
    if (!enclave.toLowerCase().includes(needle.toLowerCase())) {
      die(1, `enclave.ts missing isolation surface: ${needle}`);
    }
  }

  const sandboxGo = readFileSync(join(REPO, "tools/brokk-sandbox/main.go"), "utf8");
  if (!/landlock\.V4/.test(sandboxGo) || !/Setresuid/.test(sandboxGo)) {
    die(1, "brokk-sandbox must apply Landlock V4 + Setresuid uid-drop");
  }

  console.log(
    "[ok] source contracts: setuid sandbox, egress entrypoint, ExecEnclave seam, Landlock+Setresuid",
  );
}

/** Prove Landlock denies a sibling write the unsandboxed shell can make; prove
 *  uid-split when the binary is setuid. */
function assertIsolationEffective() {
  const bin = findSandboxBin();
  if (!bin) {
    die(
      1,
      "brokk-sandbox not on PATH — isolation cannot be proven (post-remediation verify requires it)",
    );
  }

  const st = statSync(bin);
  const isSetuid = (st.mode & 0o4000) !== 0;
  const bashUid = Number(process.env.BROKK_BASH_UID ?? 1002);
  const bashGid = Number(process.env.BROKK_BASH_GID ?? 1001);

  const parent = join(homedir(), `brokk-iso-accept-${process.pid}`);
  const cwd = join(parent, "checkout");
  const sibling = join(parent, "sibling");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(sibling, { recursive: true });
  chmodSync(parent, 0o2775);
  chmodSync(cwd, 0o2775);
  chmodSync(sibling, 0o2775);

  try {
    // Control: without the jail both writes succeed.
    const ctrl = spawnSync(
      "/bin/sh",
      ["-c", "touch ok-ctrl.txt; touch ../sibling/pwn-ctrl.txt"],
      { cwd, encoding: "utf8" },
    );
    if (ctrl.status !== 0) {
      die(1, `unsandboxed control probe failed (dirs not writable?): ${ctrl.stderr}`);
    }

    const args = [
      "--verbose",
      ...(isSetuid ? ["--uid", String(bashUid), "--gid", String(bashGid)] : []),
      "--rw",
      cwd,
      "--rw",
      "/tmp",
      "--rw",
      "/dev",
      "--ro",
      "/usr",
      "--ro",
      "/bin",
      "--ro",
      "/lib",
      "--ro",
      "/lib64",
      "--ro",
      "/etc",
      "--ro",
      "/proc",
      "--ro",
      "/sys",
      "--ro",
      "/run",
      "--",
      "/bin/sh",
      "-c",
      [
        "id -u",
        "touch ok.txt; echo IN=$?",
        "touch ../sibling/pwn.txt; echo OUT=$?",
        "test -f ../sibling/pwn.txt && echo SIBLING_EXISTS || echo SIBLING_ABSENT",
      ].join("; "),
    ];

    const r = spawnSync(bin, args, { cwd, encoding: "utf8" });
    const combined = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
    if (r.error) die(1, `failed to spawn ${bin}: ${r.error.message}`);

    if (/landlock not applied/i.test(combined)) {
      die(1, `Landlock not applied (sandbox warned):\n${combined}`);
    }
    if (!/IN=0/.test(combined)) {
      die(1, `checkout write must succeed under jail:\n${combined}`);
    }
    if (!/OUT=[1-9]/.test(combined) || !/SIBLING_ABSENT/.test(combined)) {
      die(1, `Landlock not effective — sibling write leaked:\n${combined}`);
    }

    if (isSetuid) {
      const uid = Number((combined.match(/^(\d+)/m) ?? [])[1]);
      if (uid !== bashUid) {
        die(1, `uid-split not effective (got uid=${uid}, want ${bashUid}):\n${combined}`);
      }
      console.log(`[ok] uid-split effective: bash uid=${uid} (setuid ${bin})`);
    } else {
      console.log(`[ok] sandbox present but not setuid — uid-split skipped (${bin})`);
    }

    console.log("[ok] Landlock effective: checkout RW, sibling denied");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
}

function screenshotHome() {
  const url = BASE.replace(/\/$/, "") + "/";
  return new Promise((resolve, reject) => {
    const shot = spawn(
      CHROME,
      [
        "--headless=new",
        "--disable-gpu",
        "--no-sandbox",
        `--screenshot=${SHOT}`,
        "--window-size=1200,800",
        url,
      ],
      { stdio: "ignore" },
    );
    shot.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`screenshot exit ${code}`)),
    );
    shot.on("error", reject);
  }).then(() => {
    console.log(`[ok] screenshot → ${SHOT} (booted app ${url})`);
  });
}

assertSourceContracts();
assertIsolationEffective();
await screenshotHome();
console.log("BROKK-24 acceptance met — isolation mechanism proven effective");
process.exit(0);
