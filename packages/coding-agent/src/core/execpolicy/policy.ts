/**
 * The command-safety policy engine (Wave 1, slice S2).
 *
 * Ports the Codex `Policy::check` shape: explicit rules (indexed by program) are
 * the authoritative layer; an unmatched command falls back to the read-only
 * heuristic safelist; everything else is "prompt". Conflicts resolve to the most
 * restrictive decision. Pure logic — no IO, no execution.
 *
 * Persistence of "always allow X" is intentionally NOT done here: pi's S1
 * resolver already checks the user's settings allow-rules BEFORE consulting a
 * tool's checkPermissions(), so a learned `bash(git push:*)` short-circuits to
 * allow before this engine ever runs. This keeps the policy a pure decision
 * brain with a single source of truth for learned rules (settings).
 */

import { type Decision, mostRestrictive } from "./decision.ts";
import { matchPrefix, type PrefixRule, single } from "./rule.ts";
import {
	detectForbidden,
	PRIVILEGE_WRAPPERS,
	READ_ONLY_PROGRAMS,
	SHELL_INTERPRETERS,
	SUBCOMMAND_READONLY,
	SUBCOMMAND_TOOLS,
	specialReadOnly,
	WRAPPER_PROGRAMS,
} from "./safelist.ts";
import { type CommandSegment, parseCommandLine, type RedirectInfo } from "./tokenize.ts";

export interface ExecEval {
	decision: Decision;
	justification?: string;
	/** argv prefix to offer as an "always allow" rule (program + verb tokens), when unambiguous. */
	suggestionPrefix?: string[];
}

/** Programs that execute code/compile; only safe when queried for version/help. */
const INTERPRETER_PROGRAMS: ReadonlySet<string> = new Set([
	"node",
	"deno",
	"bun",
	"python",
	"python2",
	"python3",
	"ruby",
	"perl",
	"php",
	"java",
	"Rscript",
	"rustc",
	"gcc",
	"g++",
	"clang",
	"clang++",
	"cc",
	"tsc",
	"ts-node",
	"tsx",
]);

const VERSION_FLAGS = new Set(["--version", "-v", "-V", "--help", "-h", "version", "help"]);

/** Harmless output-redirect sinks that do not count as a filesystem mutation. */
const HARMLESS_REDIRECT_TARGET = new Set(["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty"]);

/** Git global flags that consume the following token as a value. */
const GIT_VALUE_FLAGS = new Set([
	"-C",
	"-c",
	"--git-dir",
	"--work-tree",
	"--namespace",
	"--super-prefix",
	"--exec-path",
]);

/**
 * Per-tool global flags that consume the FOLLOWING token as a value. Without these,
 * the verb scanner would promote a flag's value to the subcommand (e.g.
 * `kubectl -n get delete pod` would read "get" — the namespace value — as the verb
 * and classify a `delete` as read-only). Over-listing only causes extra prompting.
 */
const SUBCOMMAND_VALUE_FLAGS: Record<string, ReadonlySet<string>> = {
	kubectl: new Set([
		"-n",
		"--namespace",
		"--context",
		"--cluster",
		"--user",
		"--kubeconfig",
		"--as",
		"--as-group",
		"--cache-dir",
		"--request-timeout",
		"-s",
		"--server",
		"--token",
		"-o",
		"--output",
		"--field-selector",
		"-l",
		"--selector",
		"--chunk-size",
	]),
	docker: new Set([
		"-H",
		"--host",
		"--context",
		"--config",
		"-l",
		"--log-level",
		"--tlscacert",
		"--tlscert",
		"--tlskey",
	]),
	podman: new Set([
		"-H",
		"--host",
		"--context",
		"--config",
		"-l",
		"--log-level",
		"--connection",
		"--url",
		"--identity",
	]),
	npm: new Set(["--prefix", "--userconfig", "--globalconfig", "-C", "--cwd", "-w", "--workspace", "--registry"]),
	pnpm: new Set(["--prefix", "-C", "--dir", "-w", "--workspace", "--registry", "--filter"]),
	yarn: new Set(["--cwd", "--registry"]),
	systemctl: new Set(["-H", "--host", "-M", "--machine", "-t", "--type", "--state", "-p", "--property"]),
	gh: new Set(["-R", "--repo"]),
	cargo: new Set(["--color", "--config", "-Z", "--manifest-path"]),
};

const NO_VALUE_FLAGS: ReadonlySet<string> = new Set();

/** The value-flag set to use when scanning for a tool's subcommand verb. */
function valueFlagsFor(program: string): ReadonlySet<string> {
	if (program === "git") return GIT_VALUE_FLAGS;
	return SUBCOMMAND_VALUE_FLAGS[program] ?? NO_VALUE_FLAGS;
}

function isVersionQuery(argv: readonly string[]): boolean {
	return argv.slice(1).every((a) => VERSION_FLAGS.has(a));
}

/** Find the subcommand verb, skipping leading flags (and the values of known value-flags). */
function subcommandVerb(argv: readonly string[], valueFlags: ReadonlySet<string>): string | undefined {
	let k = 1;
	while (k < argv.length) {
		const a = argv[k];
		if (valueFlags.has(a)) {
			k += 2;
			continue;
		}
		if (a.startsWith("-")) {
			k += 1;
			continue;
		}
		return a;
	}
	return undefined;
}

const GIT_BRANCH_MUTATING_FLAGS = new Set([
	"-d",
	"-D",
	"--delete",
	"-m",
	"-M",
	"--move",
	"-c",
	"-C",
	"--copy",
	"--edit-description",
	"--set-upstream-to",
	"-u",
	"--unset-upstream",
	"--set-upstream",
]);
const GIT_TAG_MUTATING_FLAGS = new Set(["-d", "--delete", "-a", "--annotate", "-s", "--sign", "-m", "-f", "--force"]);
const GIT_CONFIG_READ_FLAGS = new Set(["--get", "--get-all", "--get-regexp", "--get-urlmatch", "--list", "-l"]);
const GIT_CONFIG_WRITE_FLAGS = new Set([
	"--add",
	"--unset",
	"--unset-all",
	"--replace-all",
	"--edit",
	"-e",
	"--rename-section",
	"--remove-section",
]);
const GIT_REMOTE_READ_VERBS = new Set(["show", "get-url", "-v", "--verbose"]);

/** git flags that turn a read verb into a write or an arbitrary-command exec. */
function gitHasExecOrWriteFlag(argv: readonly string[]): boolean {
	for (let k = 1; k < argv.length; k++) {
		const a = argv[k];
		if (a === "--output" || a.startsWith("--output=")) return true;
		if (a === "--ext-diff" || a === "--open-files-in-pager") return true;
		if (a === "-c" || a === "--config-env") {
			const v = argv[k + 1] ?? "";
			if (/(pager|command|external|alias|sshcommand|uploadpack|fsmonitor|hookspath)/i.test(v)) return true;
		}
		if (a.startsWith("-c") && a.length > 2 && /(pager|command|external|alias|sshcommand|fsmonitor)/i.test(a)) {
			return true;
		}
	}
	return false;
}

/** Nuanced read-only classification for git (the most-used tool). */
function gitReadOnly(argv: readonly string[]): boolean {
	if (gitHasExecOrWriteFlag(argv)) return false;
	const verb = subcommandVerb(argv, GIT_VALUE_FLAGS);
	if (verb === undefined) return false;
	if (SUBCOMMAND_READONLY.git.has(verb)) return true;
	// Position of the verb so we can inspect the rest of the subcommand's args.
	const verbIdx = argv.indexOf(verb);
	const rest = argv.slice(verbIdx + 1);
	const positionals = rest.filter((a) => !a.startsWith("-"));
	switch (verb) {
		case "branch":
			return positionals.length === 0 && !rest.some((a) => GIT_BRANCH_MUTATING_FLAGS.has(a));
		case "tag":
			// Bare `git tag` or `git tag -l/--list [pat]` lists; a positional name (without -l) creates.
			if (rest.some((a) => GIT_TAG_MUTATING_FLAGS.has(a))) return false;
			return positionals.length === 0 || rest.includes("-l") || rest.includes("--list");
		case "config":
			if (rest.some((a) => GIT_CONFIG_WRITE_FLAGS.has(a))) return false;
			if (rest.some((a) => GIT_CONFIG_READ_FLAGS.has(a))) return true;
			// A bare `git config key value` sets; `git config key` reads.
			return positionals.length <= 1;
		case "remote":
			return positionals.length === 0 || GIT_REMOTE_READ_VERBS.has(positionals[0]) || rest.includes("-v");
		case "stash":
			return positionals[0] === "list" || positionals[0] === "show";
		case "submodule":
			return positionals.length === 0 || positionals[0] === "status" || positionals[0] === "summary";
		case "worktree":
			return positionals[0] === "list";
		case "bisect":
			return positionals[0] === "log" || positionals[0] === "view";
		case "notes":
			return positionals.length === 0 || positionals[0] === "list" || positionals[0] === "show";
		case "symbolic-ref":
			// `git symbolic-ref [-q|--short] <name>` reads; a second (ref value) positional or -d/--delete writes.
			return positionals.length <= 1 && !rest.includes("-d") && !rest.includes("--delete");
		case "reflog": {
			// Bare `git reflog` == `reflog show`; only show/exists read — expire/delete/write mutate.
			const sub = positionals[0];
			return sub === undefined || sub === "show" || sub === "exists";
		}
		default:
			return false;
	}
}

/** Does this single segment's program only read state? (Ignores redirects/substitution — caller handles those.) */
function programIsReadOnly(argv: readonly string[]): boolean {
	if (argv.length === 0) return false;
	const program = argv[0];
	const special = specialReadOnly(program, argv);
	if (special !== undefined) return special;
	if (program === "git") return gitReadOnly(argv);
	if (INTERPRETER_PROGRAMS.has(program)) return isVersionQuery(argv);
	if (READ_ONLY_PROGRAMS.has(program)) return true;
	if (SUBCOMMAND_TOOLS.has(program)) {
		const verb = subcommandVerb(argv, valueFlagsFor(program));
		return verb !== undefined && SUBCOMMAND_READONLY[program].has(verb);
	}
	return false;
}

/**
 * Strip privilege/wrapper prefixes to find the command actually being run.
 * Returns the unwrapped argv and whether a privilege escalation (sudo/doas/su)
 * was involved.
 */
function unwrap(argv: readonly string[]): { inner: string[]; privileged: boolean } {
	let cur = [...argv];
	let privileged = false;
	// Bound the loop so a pathological `env env env …` can't spin.
	for (let guard = 0; guard < 8 && cur.length > 0; guard++) {
		const program = cur[0];
		if (PRIVILEGE_WRAPPERS.has(program)) {
			privileged = true;
			cur = stripWrapperFlags(cur.slice(1), program);
			continue;
		}
		if (WRAPPER_PROGRAMS.has(program)) {
			cur = stripWrapperFlags(cur.slice(1), program);
			continue;
		}
		break;
	}
	return { inner: cur, privileged };
}

/** Wrapper options that consume the following token as a value. */
const WRAPPER_VALUE_FLAGS: Record<string, ReadonlySet<string>> = {
	timeout: new Set(["-s", "--signal", "-k", "--kill-after"]),
	nice: new Set(["-n", "--adjustment"]),
	ionice: new Set(["-c", "--class", "-n", "--classdata", "-p", "--pid"]),
	chrt: new Set(["-p"]),
	stdbuf: new Set(["-i", "-o", "-e", "--input", "--output", "--error"]),
};

/** Wrappers that take a leading positional operand (e.g. `timeout 5 cmd`). */
const WRAPPER_LEADING_OPERAND: Record<string, RegExp> = {
	timeout: /^\d+(\.\d+)?[smhdSMHD]?$/,
	chrt: /^\d+$/,
};

/** Drop a wrapper's own options/operands (and `env`'s NAME=value assignments) to reach the inner command. */
function stripWrapperFlags(rest: string[], wrapper: string): string[] {
	const valueFlags = WRAPPER_VALUE_FLAGS[wrapper];
	let k = 0;
	while (k < rest.length) {
		const a = rest[k];
		if (wrapper === "env" && /^[A-Za-z_][A-Za-z0-9_]*=/.test(a)) {
			k++;
			continue;
		}
		if (a === "--") {
			k++;
			break;
		}
		if (valueFlags?.has(a)) {
			k += 2;
			continue;
		}
		if (a.startsWith("-")) {
			k++;
			continue;
		}
		break;
	}
	const leading = WRAPPER_LEADING_OPERAND[wrapper];
	if (leading && k < rest.length && leading.test(rest[k])) {
		k++;
	}
	return rest.slice(k);
}

/** A short-flag bundle containing `c` (e.g. `-c`, `-lc`, `-ec`), i.e. `sh -c <string>`. */
const SHELL_C_FLAG = /^-[a-z]*c[a-z]*$/i;

/** Bound on nested `sh -c "sh -c …"` recursion so a crafted command cannot spin. */
const SHELL_RECURSION_LIMIT = 5;

/** If `inner` is a shell interpreter invoked with `-c`, return the inline command string. */
function extractShellInlineCommand(inner: readonly string[]): string | undefined {
	if (inner.length < 2 || !SHELL_INTERPRETERS.has(inner[0])) return undefined;
	for (let k = 1; k < inner.length; k++) {
		const a = inner[k];
		if (a === "-c" || (a.length <= 5 && SHELL_C_FLAG.test(a))) {
			return inner[k + 1];
		}
		// First non-flag operand without a preceding -c is a script path, not inline code.
		if (!a.startsWith("-")) return undefined;
	}
	return undefined;
}

export class ExecPolicy {
	/** Learned/seeded prefix rules, indexed by argv[0]. */
	private readonly rulesByProgram = new Map<string, PrefixRule[]>();

	/** Seed a prefix rule (e.g. a project policy file). In-memory only. */
	addPrefixRule(rule: PrefixRule): void {
		const key = rule.pattern.first;
		const list = this.rulesByProgram.get(key);
		if (list) list.push(rule);
		else this.rulesByProgram.set(key, [rule]);
	}

	/** Seed an exact-match allow rule from a concrete argv prefix (runtime "always allow"). */
	allowExactPrefix(prefix: readonly string[], justification?: string): void {
		const [first, ...rest] = prefix;
		if (!first) return;
		this.addPrefixRule({ pattern: { first, rest: rest.map(single) }, decision: "allow", justification });
	}

	/** Most-restrictive decision among the seeded rules that match this argv, if any. */
	private ruleDecision(argv: readonly string[]): { decision: Decision; justification?: string } | undefined {
		const list = this.rulesByProgram.get(argv[0] ?? "");
		if (!list) return undefined;
		let hit: { decision: Decision; justification?: string } | undefined;
		for (const rule of list) {
			if (matchPrefix(argv, rule.pattern)) {
				if (!hit || mostRestrictive(hit.decision, rule.decision) === rule.decision) {
					hit = { decision: rule.decision, justification: rule.justification };
				}
			}
		}
		return hit;
	}

	/** Evaluate one already-parsed segment. */
	private evalSegment(segment: CommandSegment, rawCommand: string, depth: number): ExecEval {
		const { inner, privileged } = unwrap(segment.argv);

		const forbidden =
			detectForbidden(inner, segment.redirects, rawCommand) ??
			detectForbidden(segment.argv, segment.redirects, rawCommand);
		if (forbidden) return { decision: "forbidden", justification: forbidden };

		// Output redirect to a real file is a filesystem mutation.
		const writesFile = segment.redirects.some((r) => r.writes && !HARMLESS_REDIRECT_TARGET.has(r.target));

		// A pipe sink that is a shell interpreter (curl … | sh) executes fetched input.
		const pipeIntoShell = segment.pipedInto && inner.length > 0 && SHELL_INTERPRETERS.has(inner[0]);

		// Seeded rule wins as the authoritative layer.
		const ruled = this.ruleDecision(inner) ?? this.ruleDecision(segment.argv);

		// `sh -c "<cmd>"` runs an inline string: recurse into it so a hidden forbidden
		// command (e.g. `bash -c 'rm -rf /'`) is caught rather than seen as a bare shell.
		const inlineCommand = extractShellInlineCommand(inner);

		let decision: Decision;
		let justification: string | undefined;
		let suggestionPrefix: string[] | undefined;

		if (ruled) {
			decision = ruled.decision;
			justification = ruled.justification;
		} else if (inlineCommand !== undefined) {
			if (depth >= SHELL_RECURSION_LIMIT) {
				decision = "prompt";
				justification = "deeply nested shell invocation";
			} else {
				const innerEval = this.check(inlineCommand, depth + 1);
				decision = innerEval.decision;
				justification = innerEval.justification ?? "runs an inline shell command string";
			}
		} else if (programIsReadOnly(inner) && !writesFile && !pipeIntoShell) {
			decision = "allow";
		} else {
			decision = "prompt";
			justification = describeMutation(inner, writesFile, pipeIntoShell);
			suggestionPrefix = suggestPrefix(inner);
		}

		if (privileged) {
			decision = mostRestrictive(decision, "prompt");
			justification ??= "runs with elevated privileges";
			// Don't offer "always allow" for a privileged command.
			suggestionPrefix = undefined;
		}
		if (pipeIntoShell && decision !== "forbidden") {
			decision = mostRestrictive(decision, "prompt");
			justification = "pipes data into a shell interpreter";
		}

		return { decision, justification, suggestionPrefix };
	}

	/**
	 * Classify a whole command line. Returns the most restrictive decision across
	 * all pipeline/list segments, plus a justification and (when unambiguous) an
	 * "always allow" suggestion prefix.
	 */
	check(command: string, depth = 0): ExecEval {
		const parsed = parseCommandLine(command);
		if (parsed.parseError) {
			return { decision: "prompt", justification: `command could not be parsed safely (${parsed.parseError})` };
		}
		if (parsed.segments.length === 0) {
			return { decision: "allow" };
		}

		const evals = parsed.segments.map((seg) => this.evalSegment(seg, command, depth));
		let decision: Decision = "allow";
		let justification: string | undefined;
		for (const e of evals) {
			const next = mostRestrictive(decision, e.decision);
			if (next !== decision) {
				decision = next;
				justification = e.justification;
			} else if (decision === e.decision && justification === undefined) {
				justification = e.justification;
			}
		}

		// Substitution can hide arbitrary commands → never auto-allow.
		if ((parsed.hasCommandSubstitution || parsed.hasProcessSubstitution) && decision === "allow") {
			decision = "prompt";
			justification = "uses command substitution, which can run hidden commands";
		}

		// Offer a suggestion only for a single-segment prompt (compound commands are ambiguous).
		const suggestionPrefix =
			decision === "prompt" &&
			parsed.segments.length === 1 &&
			!parsed.hasCommandSubstitution &&
			!parsed.hasProcessSubstitution
				? evals[0].suggestionPrefix
				: undefined;

		return { decision, justification, suggestionPrefix };
	}

	/** Structural read-only test: true only if every segment purely reads state. */
	isReadOnly(command: string): boolean {
		const parsed = parseCommandLine(command);
		if (parsed.parseError) return false;
		if (parsed.hasCommandSubstitution || parsed.hasProcessSubstitution) return false;
		if (parsed.segments.length === 0) return false;
		for (const seg of parsed.segments) {
			if (writesAnyFile(seg.redirects)) return false;
			const { inner, privileged } = unwrap(seg.argv);
			if (privileged) return false;
			if (seg.pipedInto && inner.length > 0 && SHELL_INTERPRETERS.has(inner[0])) return false;
			if (!programIsReadOnly(inner)) return false;
		}
		return true;
	}
}

function writesAnyFile(redirects: readonly RedirectInfo[]): boolean {
	return redirects.some((r) => r.writes && !HARMLESS_REDIRECT_TARGET.has(r.target));
}

function describeMutation(inner: readonly string[], writesFile: boolean, pipeIntoShell: boolean): string {
	if (pipeIntoShell) return "pipes data into a shell interpreter";
	if (writesFile) return "redirects output into a file";
	const program = inner[0] ?? "command";
	return `${program} may modify state or run code`;
}

/** Compute the "always allow" prefix: program + subcommand verb for subcommand tools, else the program. */
function suggestPrefix(inner: readonly string[]): string[] | undefined {
	if (inner.length === 0) return undefined;
	const program = inner[0];
	if (SUBCOMMAND_TOOLS.has(program) || program === "git") {
		const verb = subcommandVerb(inner, valueFlagsFor(program));
		return verb ? [program, verb] : [program];
	}
	return [program];
}

/** A process-wide default policy instance. Stateless aside from seeded rules (none by default). */
export const defaultExecPolicy: ExecPolicy = new ExecPolicy();
