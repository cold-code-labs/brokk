// brokk-sandbox — the unprivileged FS jail for the agents' bash hand.
//
// Wraps a command in a Landlock ruleset so the shell can touch ONLY the paths we
// grant: the session's own checkout (RW), the caches package managers need (RW),
// and the read-only system toolchain. Everything else — sibling sessions'
// checkouts, ~/.config/gh & ~/.npmrc credentials, the rest of $HOME — is denied by
// the kernel, not by convention. This is isolation Nível 2 (see docs/NORTH-STAR.md
// §5, §9 and the brokk-isolation memory): the missing runtime boundary that a
// worktree + env-allowlist (Nível 1) can't provide.
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
// to a warning and the command still runs — the sandbox tightens security when the
// platform allows and never breaks the fleet when it doesn't.
//
// Usage:
//
//	brokk-sandbox [--rw DIR]... [--ro DIR]... [--ro-file FILE]... [--verbose] -- cmd [args...]
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
