// brokk-sandbox — the unprivileged FS jail + egress-uid drop for the agents' bash hand.
//
// Wraps a command in a Landlock ruleset so the shell can touch ONLY the paths we
// grant: the session's own checkout (RW), the caches package managers need (RW),
// and the read-only system toolchain. Everything else — sibling sessions'
// checkouts, ~/.config/gh & ~/.npmrc credentials, the rest of $HOME — is denied by
// the kernel, not by convention. This is isolation Nível 2 (see docs/NORTH-STAR.md
// §5, §9 and the brokk-isolation memory): the missing runtime boundary that a
// worktree + env-allowlist (Nível 1) can't provide.
//
// Nível 3 (network egress): with --uid/--gid this binary — shipped SETUID to a
// second uid (1002) distinct from the node worker's (1001) — drops to that uid
// before exec. The shell then runs under a uid the container's static nft ruleset
// firewalls off from the fleet's internal subnets (RFC1918), while the node worker
// keeps its legitimate reach to litellm/brokk-api/db. node and bash share the
// netns, so a uid is the only discriminator netfilter can key on without KVM (no
// /dev/kvm) or a nested userns (blocked by apparmor_restrict_unprivileged_userns).
//
// Why Landlock and not bubblewrap: this host (Ubuntu 24.04, kernel 6.8) blocks
// nested unprivileged user namespaces (apparmor_restrict_unprivileged_userns=1),
// so bwrap can't set up its uid map inside the container without granting the
// container CAP_SYS_ADMIN + seccomp/apparmor=unconfined — weakening the OUTER
// boundary to strengthen the inner one, a bad trade. Landlock needs no privilege,
// no userns, no caps: an unprivileged process restricts ITSELF before exec. The
// kernel LSM is already loaded and Docker 29's default seccomp permits the syscalls.
//
// Best-effort by design: on a kernel/config without Landlock the ruleset degrades
// to a warning and the command still runs; without the setuid bit (dev/local) the
// uid drop degrades to a warning and the shell runs as the caller's uid. The
// sandbox tightens security when the platform allows and never breaks the fleet
// when it doesn't.
//
// Usage:
//
//	brokk-sandbox [--uid N] [--gid N] [--rw DIR]... [--ro DIR]... [--ro-file FILE]... [--verbose] -- cmd [args...]
package main

import (
	"fmt"
	"os"
	"syscall"

	"github.com/landlock-lsm/go-landlock/landlock"
)

func main() {
	var roDirs, rwDirs, roFiles []string
	verbose := false
	uid, gid := -1, -1

	args := os.Args[1:]
	i := 0
	for ; i < len(args); i++ {
		a := args[i]
		if a == "--" {
			i++
			break
		}
		next := func() string {
			i++
			if i >= len(args) {
				fatal("flag %s needs a value", a)
			}
			return args[i]
		}
		switch a {
		case "--rw":
			rwDirs = append(rwDirs, next())
		case "--ro":
			roDirs = append(roDirs, next())
		case "--ro-file":
			roFiles = append(roFiles, next())
		case "--uid":
			uid = atoi(next())
		case "--gid":
			gid = atoi(next())
		case "--verbose":
			verbose = true
		default:
			fatal("unknown flag %q", a)
		}
	}
	cmd := args[i:]
	if len(cmd) == 0 {
		fatal("no command given after --")
	}

	// Nível 3: drop to the egress uid BEFORE Landlock + exec. The setuid bit makes
	// euid already 1002 when the worker (ruid 1001) execs us — but the REAL uid is
	// still 1001, so we must setres* all three ids to 1002 to (a) make skuid on the
	// socket read 1002 for the nft egress match and (b) clear the saved-set id so the
	// shell can't climb back to the worker's uid. Hence the guard is on the real uid,
	// not euid. gid first (dropping uid can revoke the right to change gid). Best-
	// effort: a bare binary (no setuid bit, dev/local) can't reach 1002 ⇒ setresuid
	// EPERMs, we warn and run on as the caller rather than wedging the agent.
	if uid >= 0 && os.Getuid() != uid {
		if gid >= 0 {
			if err := syscall.Setresgid(gid, gid, gid); err != nil {
				fmt.Fprintf(os.Stderr, "[brokk-sandbox] warning: setgid %d not applied: %v\n", gid, err)
			}
		}
		if err := syscall.Setresuid(uid, uid, uid); err != nil {
			fmt.Fprintf(os.Stderr, "[brokk-sandbox] warning: setuid %d not applied (no setuid bit?): %v\n", uid, err)
		} else if verbose {
			fmt.Fprintf(os.Stderr, "[brokk-sandbox] dropped to uid=%d gid=%d\n", uid, gid)
		}
	}

	// Build the ruleset. IgnoreIfMissing: caches (~/.npm, pnpm store…) may not exist
	// yet on a fresh session — a missing grant must not abort the whole jail.
	var rules []landlock.Rule
	if len(roDirs) > 0 {
		rules = append(rules, landlock.RODirs(roDirs...).IgnoreIfMissing())
	}
	if len(rwDirs) > 0 {
		rules = append(rules, landlock.RWDirs(rwDirs...).IgnoreIfMissing())
	}
	if len(roFiles) > 0 {
		rules = append(rules, landlock.ROFiles(roFiles...).IgnoreIfMissing())
	}

	// V4 matches kernel 6.8 (Ubuntu 24.04). BestEffort clamps to whatever ABI the
	// running kernel actually supports, so this same binary is safe on older hosts.
	if err := landlock.V4.BestEffort().RestrictPaths(rules...); err != nil {
		// Never fail closed on a setup problem: warn and run unsandboxed rather than
		// wedge the agent. Security is best-effort; availability is not negotiable.
		fmt.Fprintf(os.Stderr, "[brokk-sandbox] warning: landlock not applied: %v\n", err)
	} else if verbose {
		fmt.Fprintf(os.Stderr, "[brokk-sandbox] landlock applied: rw=%v ro=%v roFiles=%v\n", rwDirs, roDirs, roFiles)
	}

	path, err := exec_LookPath(cmd[0])
	if err != nil {
		fatal("command not found: %s", cmd[0])
	}
	if err := syscall.Exec(path, cmd, os.Environ()); err != nil {
		fatal("exec %s: %v", path, err)
	}
}

func fatal(format string, a ...any) {
	fmt.Fprintf(os.Stderr, "[brokk-sandbox] "+format+"\n", a...)
	os.Exit(127)
}

// atoi parses a base-10 int flag value; a malformed value is a caller bug, not a
// runtime condition, so fail loudly rather than silently coerce to 0 (uid 0 = root).
func atoi(s string) int {
	if s == "" {
		fatal("empty integer flag")
	}
	n := 0
	neg := false
	for i, c := range s {
		if i == 0 && c == '-' {
			neg = true
			continue
		}
		if c < '0' || c > '9' {
			fatal("invalid integer %q", s)
		}
		n = n*10 + int(c-'0')
	}
	if neg {
		n = -n
	}
	return n
}

// exec_LookPath resolves cmd[0] against PATH when it has no slash, so callers can
// pass "sh"/"bash" like execAsync does. Kept tiny to avoid pulling os/exec.
func exec_LookPath(file string) (string, error) {
	if containsSlash(file) {
		return file, nil
	}
	for _, dir := range splitPath(os.Getenv("PATH")) {
		if dir == "" {
			dir = "."
		}
		p := dir + "/" + file
		if info, err := os.Stat(p); err == nil && !info.IsDir() {
			return p, nil
		}
	}
	return "", fmt.Errorf("not found")
}

func containsSlash(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] == '/' {
			return true
		}
	}
	return false
}

func splitPath(p string) []string {
	var out []string
	start := 0
	for i := 0; i < len(p); i++ {
		if p[i] == ':' {
			out = append(out, p[start:i])
			start = i + 1
		}
	}
	return append(out, p[start:])
}
