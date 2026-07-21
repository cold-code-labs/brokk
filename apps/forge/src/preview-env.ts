/**
 * Env for preview install/boot spawns.
 *
 * Inherits `npm_config_store_dir` from the process — compose pins
 * `/home/brokk/work/.pnpm-store` (1001-writable, setgid). Do NOT override the
 * store here: BROKK-21 item 5 tried pinning `${HOME}/.pnpm-store` and caused a
 * real EPERM chmod regression on hardlinked bins (reverted). Previews already
 * share one store via the worker env; see docs/DEV-PREVIEW.md.
 */
export function previewSpawnEnv(
  base: NodeJS.ProcessEnv,
  extra: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const home = base.HOME && base.HOME !== "/" ? base.HOME : "/home/brokk";
  return {
    ...base,
    ...extra,
    HOME: home,
    COREPACK_HOME: `${home}/.cache/corepack`,
  };
}
