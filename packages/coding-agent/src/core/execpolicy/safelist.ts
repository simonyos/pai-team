/**
 * The read-only safelist + forbidden-command detector (Wave 1, slice S2).
 *
 * This is pi's equivalent of Codex's `is_known_safe_command` heuristic fallback
 * plus the hard-deny set. Two layers with clear precedence (applied in policy.ts):
 *   1. forbidden patterns  → hard deny (no negotiation)
 *   2. read-only safelist  → allow without prompting
 *   3. everything else mutating → prompt
 *
 * Data only (sets/maps) + small pure predicates. The orchestration lives in
 * policy.ts. The lists are deliberately conservative: an UNLISTED command falls
 * through to "prompt", never to "allow".
 */

import type { RedirectInfo } from "./tokenize.ts";

/** Programs that only read state, regardless of their arguments (modulo the checks in policy.ts). */
export const READ_ONLY_PROGRAMS: ReadonlySet<string> = new Set([
	"ls",
	"pwd",
	"echo",
	"printf",
	"cat",
	"bat",
	"head",
	"tail",
	"wc",
	"nl",
	"tac",
	"rev",
	"grep",
	"egrep",
	"fgrep",
	"rg",
	"ag",
	"ack",
	"tree",
	"stat",
	"file",
	"realpath",
	"readlink",
	"basename",
	"dirname",
	"which",
	"type",
	"whereis",
	"whatis",
	"apropos",
	"whoami",
	"id",
	"groups",
	"hostname",
	"uname",
	"arch",
	"tty",
	"logname",
	"date",
	"cal",
	"uptime",
	"locale",
	"getconf",
	"env",
	"printenv",
	"ps",
	"pgrep",
	"df",
	"du",
	"free",
	"vmstat",
	"lscpu",
	"lsblk",
	"nproc",
	"uniq",
	"cut",
	"tr",
	"column",
	"fold",
	"fmt",
	"expand",
	"unexpand",
	"comm",
	"join",
	"paste",
	"diff",
	"cmp",
	"sdiff",
	"colordiff",
	"delta",
	"md5",
	"md5sum",
	"sha1sum",
	"sha224sum",
	"sha256sum",
	"sha384sum",
	"sha512sum",
	"shasum",
	"cksum",
	"b2sum",
	"crc32",
	"jq",
	"yq",
	"fx",
	"less",
	"more",
	"most",
	"pg",
	"true",
	"false",
	"test",
	"[",
	"[[",
	"seq",
	"expr",
	"yes",
	"man",
	"info",
	"tldr",
	"help",
	"hexdump",
	"xxd",
	"od",
	"strings",
	"base64",
	"base32",
]);

/** Shell interpreters: dangerous as a pipe sink (`curl … | sh`) or with `-c`. */
export const SHELL_INTERPRETERS: ReadonlySet<string> = new Set([
	"sh",
	"bash",
	"zsh",
	"dash",
	"ksh",
	"fish",
	"csh",
	"tcsh",
	"ash",
	"busybox",
]);

/** Wrappers that run another command supplied as an argument; we unwrap and judge the inner command. */
export const WRAPPER_PROGRAMS: ReadonlySet<string> = new Set([
	"env",
	"nice",
	"nohup",
	"timeout",
	"stdbuf",
	"setsid",
	"time",
	"ionice",
	"chrt",
	// `xargs` runs its trailing argument as the command (e.g. `xargs git push`), so
	// it is a wrapper: unwrap past its own options to reach the inner program. Its
	// value-taking options are declared in policy.ts (WRAPPER_VALUE_FLAGS).
	"xargs",
]);

/** Privilege-escalating wrappers: unwrap the inner command but never drop below "prompt". */
export const PRIVILEGE_WRAPPERS: ReadonlySet<string> = new Set(["sudo", "doas", "su"]);

/** Per-tool read-only subcommands (the verb at argv[1], or argv[2] for `git remote show`-style). */
export const SUBCOMMAND_READONLY: Record<string, ReadonlySet<string>> = {
	git: new Set([
		"status",
		"log",
		"diff",
		"show",
		"describe",
		"rev-parse",
		"rev-list",
		"ls-files",
		"ls-tree",
		"ls-remote",
		"cat-file",
		"blame",
		"annotate",
		"shortlog",
		"for-each-ref",
		"name-rev",
		"whatchanged",
		"grep",
		"count-objects",
		"var",
		"merge-base",
		"cherry",
		"verify-commit",
		"fsck",
		"show-ref",
		"show-branch",
		"help",
		"version",
	]),
	npm: new Set([
		"ls",
		"list",
		"view",
		"info",
		"show",
		"outdated",
		"why",
		"ping",
		"root",
		"prefix",
		"bin",
		"doctor",
		"explain",
		"fund",
		"help",
		"search",
	]),
	pnpm: new Set(["ls", "list", "view", "info", "outdated", "why", "root", "bin", "help"]),
	yarn: new Set(["list", "info", "why", "versions", "help"]),
	bun: new Set(["pm", "--version", "help"]),
	cargo: new Set(["version", "tree", "metadata", "search", "locate-project", "verify-project", "help"]),
	go: new Set(["version", "list", "doc", "vet", "help"]),
	docker: new Set(["ps", "images", "logs", "inspect", "version", "info", "top", "port", "history", "search", "stats"]),
	podman: new Set(["ps", "images", "logs", "inspect", "version", "info", "top", "port", "history", "search", "stats"]),
	kubectl: new Set([
		"get",
		"describe",
		"logs",
		"top",
		"explain",
		"api-resources",
		"api-versions",
		"version",
		"cluster-info",
	]),
	brew: new Set([
		"list",
		"ls",
		"info",
		"search",
		"outdated",
		"deps",
		"uses",
		"doctor",
		"config",
		"leaves",
		"tap-info",
		"--version",
	]),
	pip: new Set(["list", "show", "freeze", "check", "config", "debug"]),
	pip3: new Set(["list", "show", "freeze", "check", "config", "debug"]),
	gh: new Set(["status", "auth", "browse", "search"]),
	apt: new Set(["list", "search", "show", "policy"]),
	"apt-get": new Set(["--version"]),
	dnf: new Set(["list", "search", "info", "repolist"]),
	yum: new Set(["list", "search", "info", "repolist"]),
	systemctl: new Set(["status", "list-units", "list-unit-files", "is-active", "is-enabled", "show", "cat"]),
};

/** Tools whose first argument is a subcommand verb (used by both read-only and suggestion-prefix logic). */
export const SUBCOMMAND_TOOLS: ReadonlySet<string> = new Set(Object.keys(SUBCOMMAND_READONLY));

const FIND_WRITE_FLAGS = new Set(["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprintf", "-fls"]);

/** `find` is read-only unless it can delete or execute. */
export function isReadOnlyFind(argv: readonly string[]): boolean {
	return !argv.some((a) => FIND_WRITE_FLAGS.has(a));
}

// A command-position sed `e`/`w`/`W`/`r`/`R` command (exec / write-file / read-file).
const SED_DANGEROUS_COMMAND = /(?:^|;|\n)\s*[0-9,$~+\- ]*[ewWrR]\b/;
// An s///e (execute) or s///w (write) flag after the closing delimiter.
const SED_DANGEROUS_SFLAG = /[sy](.)(?:(?!\1).)*\1(?:(?!\1).)*\1[gpicm0-9]*[ewW]/;

/** `sed` is read-only unless it edits in place, executes (`e`), or writes/reads files (`w`/`r`). */
export function isReadOnlySed(argv: readonly string[]): boolean {
	if (argv.some((a) => a === "-i" || a === "--in-place" || a.startsWith("-i") || a.startsWith("--in-place="))) {
		return false;
	}
	return !argv.some((a) => SED_DANGEROUS_COMMAND.test(a) || SED_DANGEROUS_SFLAG.test(a));
}

// awk program constructs that write files or run commands.
const AWK_EXEC = /system\s*\(|getline/;
const AWK_REDIRECT = /\b(?:print|printf)\b[^;{}]*[>|]/;

/** `awk` is read-only unless its program writes files, pipes to a command, runs system(), or loads a program file. */
export function isReadOnlyAwk(argv: readonly string[]): boolean {
	// `-f progfile` / `--file` loads an unknown program we cannot inspect.
	if (argv.some((a) => a === "-f" || a === "--file" || (a.startsWith("-f") && a.length > 2))) return false;
	return !argv.some((a) => AWK_EXEC.test(a) || AWK_REDIRECT.test(a) || a.includes('"/dev/'));
}

const FD_WRITE_FLAGS = new Set(["-x", "--exec", "-X", "--exec-batch"]);

/** `fd` is read-only unless it executes a command per match (`-x`/`-X`). */
export function isReadOnlyFd(argv: readonly string[]): boolean {
	return !argv.some((a) => FD_WRITE_FLAGS.has(a));
}

/** `sort` is read-only unless it writes its output to a file. */
export function isReadOnlySort(argv: readonly string[]): boolean {
	return !argv.some((a) => a === "-o" || a === "--output" || a.startsWith("--output="));
}

/**
 * The POSIX `command` builtin runs its operand while bypassing shell functions/aliases,
 * so `command <program> <args…>` is only as safe as `<program> <args…>` itself (which
 * policy.ts unwraps and classifies). Its `-v`/`-V` *query* forms merely describe a
 * command (read-only, like `type`/`which`) and are the ONLY read-only shape. Options
 * precede the operand, so we stop scanning at the first non-flag token — this keeps a
 * later `-v` argument to the inner program (e.g. `command git -v`) from being mistaken
 * for a query flag.
 */
export function commandIsQuery(argv: readonly string[]): boolean {
	for (let k = 1; k < argv.length; k++) {
		const a = argv[k];
		if (a === "--") return false;
		if (a === "-v" || a === "-V") return true;
		if (a.startsWith("-")) continue;
		return false;
	}
	return false;
}

const SPECIAL_READ_ONLY: Record<string, (argv: readonly string[]) => boolean> = {
	find: isReadOnlyFind,
	fd: isReadOnlyFd,
	sed: isReadOnlySed,
	awk: isReadOnlyAwk,
	gawk: isReadOnlyAwk,
	mawk: isReadOnlyAwk,
	nawk: isReadOnlyAwk,
	sort: isReadOnlySort,
	command: commandIsQuery,
};

/** Programs that are read-only only under an argument-specific predicate. */
export function specialReadOnly(program: string, argv: readonly string[]): boolean | undefined {
	const pred = SPECIAL_READ_ONLY[program];
	return pred ? pred(argv) : undefined;
}

/** Block-device / kernel pseudo-file targets that must never be written (incl. LVM/device-mapper and md-RAID). */
const DEVICE_TARGET = /^\/dev\/(sd|hd|vd|nvme|mmcblk|disk|rdisk|loop|mem|kmem|port|mapper\/|dm-|md\d)/;

function targetsRawDevice(target: string): boolean {
	return DEVICE_TARGET.test(target);
}

// biome-ignore lint/suspicious/noTemplateCurlyInString: these are literal shell-variable target strings, not JS templates
const ROOT_LITERAL_TARGET = new Set(["/", "/*", "/.", "~", "~/", "/~", "$HOME", "${HOME}", "$HOME/", "/root"]);
const SYSTEM_DIR_TARGET =
	/^\/(usr|etc|bin|sbin|lib|lib64|boot|var|opt|sys|proc|dev|home|System|Library|Applications)(\/\*?|\*)?$/;

/** A root-ish or top-level system target whose recursive deletion is catastrophic. */
function isRootTarget(target: string): boolean {
	return ROOT_LITERAL_TARGET.has(target) || SYSTEM_DIR_TARGET.test(target);
}

/** Does this `rm` invocation recursively delete a root-ish target? (force flag irrelevant.) */
function isCatastrophicRm(argv: readonly string[]): boolean {
	if (argv[0] !== "rm") return false;
	let recursive = false;
	const targets: string[] = [];
	for (let k = 1; k < argv.length; k++) {
		const a = argv[k];
		if (a === "--recursive" || a === "--no-preserve-root") {
			recursive = true;
		} else if (a.startsWith("--")) {
			// other long flag, ignore
		} else if (a.startsWith("-")) {
			if (a.includes("r") || a.includes("R")) recursive = true;
		} else {
			targets.push(a);
		}
	}
	return recursive && targets.some(isRootTarget);
}

/**
 * Detect a catastrophic, no-legitimate-reason command. Returns a justification
 * string when the command is forbidden, otherwise undefined. Operates on the
 * tokenized argv of a single segment plus its redirects and the raw line (for
 * patterns that defy tokenization, like the fork bomb).
 */
export function detectForbidden(
	argv: readonly string[],
	redirects: readonly RedirectInfo[],
	rawCommand: string,
): string | undefined {
	// Fork bomb — match against the whitespace-stripped raw line.
	const compact = rawCommand.replace(/\s+/g, "");
	if (compact.includes(":(){:|:&};:") || /\(\)\{[^}]*\|[^}]*&[^}]*\}/.test(compact)) {
		return "fork bomb: exhausts all system processes";
	}
	// Output redirect onto a raw block device or kernel memory.
	for (const r of redirects) {
		if (r.writes && targetsRawDevice(r.target)) {
			return `writes directly to device ${r.target}`;
		}
	}
	if (argv.length === 0) return undefined;
	const program = argv[0];
	// rm -rf / (and friends).
	if (isCatastrophicRm(argv)) {
		return "recursive force-delete of a root or home directory";
	}
	// Filesystem creation over an existing device.
	if (/^mkfs(\.|$)/.test(program)) {
		return "formats a filesystem (destroys all data on the target)";
	}
	if (program === "wipefs") {
		return "erases filesystem signatures";
	}
	// dd writing to a raw disk device.
	if (program === "dd" && argv.some((a) => a.startsWith("of=") && targetsRawDevice(a.slice(3)))) {
		return "dd writing directly to a raw disk device";
	}
	// Partition-table editors and whole-device wipers targeting a real device.
	if (DISK_DESTROYERS.has(program) && argv.some((a) => /^\/dev\//.test(a))) {
		return `${program} destroying a raw disk or partition table`;
	}
	return undefined;
}

/** Programs that, pointed at a /dev/ node, irrecoverably destroy a disk or partition table. */
const DISK_DESTROYERS: ReadonlySet<string> = new Set([
	"sgdisk",
	"parted",
	"fdisk",
	"sfdisk",
	"cfdisk",
	"gdisk",
	"blkdiscard",
	"mkswap",
	"shred",
	"badblocks",
]);
