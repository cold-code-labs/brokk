#!/bin/sh
# brokk entrypoint — installs the Nível 3 egress jail (best-effort) and drops the
# worker to its unprivileged uid. Shared by forge / reviewer / chat.
#
# Two boot modes, decided by whether we start as root:
#
#   • root + BROKK_EGRESS=1 (prod / coolify, container netns): install the nft
#     ruleset that firewalls the bash uid (1002) off RFC1918, then drop to
#     1001:1001 and exec the worker. CAP_NET_ADMIN is used only here and is gone
#     once we drop, so neither node nor bash can touch the rules afterward.
#   • non-root (dev lane runs network_mode: host as uid 1001): skip nft entirely —
#     we must NOT rewrite the *host's* firewall — and just exec. The uid-split FS
#     jail still applies via the setuid brokk-sandbox binary.
#
# umask 0002 so the node worker (1001) creates group-writable files; the bash hand
# (uid 1002, gid 1001) shares the group and can therefore write the checkout/caches.
umask 0002

WORKER_UID=1001
WORKER_GID=1001

# Pick whatever privilege-dropper the base image ships (alpine: su-exec, debian: gosu).
drop() {
	if command -v su-exec >/dev/null 2>&1; then
		exec su-exec "${WORKER_UID}:${WORKER_GID}" "$@"
	elif command -v gosu >/dev/null 2>&1; then
		exec gosu "${WORKER_UID}:${WORKER_GID}" "$@"
	else
		echo "[entrypoint] warning: no su-exec/gosu; running as root" >&2
		exec "$@"
	fi
}

if [ "$(id -u)" = "0" ]; then
	# HOME is a named volume mounted over the image dir, so the Dockerfile's perms are
	# masked on a pre-existing volume. Re-assert them so the bash uid (1002, gid 1001)
	# can write the checkout/caches: setgid HOME + group-writable on exactly the cache
	# dirs the sandbox grants RW. NOT .config/gh — that stays Landlock's to gate.
	chown 1001:1001 /home/brokk 2>/dev/null || true
	chmod 2775 /home/brokk 2>/dev/null || true
	for d in .npm .cache .local .config/pnpm .yarn .bun .semgrep work; do
		[ -e "/home/brokk/$d" ] && chmod -R g+rwX "/home/brokk/$d" 2>/dev/null
	done

	if [ "${BROKK_EGRESS:-0}" = "1" ]; then
		if command -v nft >/dev/null 2>&1 && nft -f /etc/brokk/egress.nft 2>/dev/null; then
			echo "[entrypoint] egress jail installed (bash uid 1002 denied RFC1918)" >&2
		else
			# No CAP_NET_ADMIN, no nft, or a ruleset error — never fail the boot.
			echo "[entrypoint] warning: egress jail NOT installed (missing CAP_NET_ADMIN/nft?)" >&2
		fi
	fi
	drop "$@"
else
	# Already unprivileged (dev host-net lane): nothing to install, nothing to drop.
	exec "$@"
fi
