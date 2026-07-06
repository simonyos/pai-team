/**
 * Read-only git state plumbing (Wave 2.2, slice G1).
 *
 * Every read funnels through one hardened runner (`runGitRead`) over `execCommand`
 * (core/exec.ts — argv, shell:false, model-provider credentials withheld via
 * getShellEnv). The runner:
 *   - asserts the invocation is read-only using the S2 execpolicy classifier
 *     (single source of truth — helpers can NEVER become a mutation path), and
 *   - prepends supply-chain hardening flags on every call:
 *       --no-optional-locks              (matches the footer convention)
 *       -c core.hooksPath=/dev/null      (a repo-planted hook can't run during a read)
 *       -c core.fsmonitor=false          (a hostile core.fsmonitor binary can't run during status/diff)
 *   - redacts well-known secret formats from captured stdout by default (1.6).
 *
 * This module adds NO permission surface: read-only git through execCommand
 * legitimately bypasses the bash execpolicy prompt, and the read-only assertion is
 * the guardrail that keeps it honest.
 *
 * Supply-chain scope (G1): the hardening above plus getDiff's `--no-ext-diff --no-textconv`
 * neutralize the config-driven code-execution vectors reachable from a hostile repo during a
 * read (core.fsmonitor, hooks, diff.external, per-path textconv). One residual remains: a
 * `filter.<driver>.clean` smudge/clean filter, driven by an in-tree .gitattributes + the repo's
 * own .git/config, can still run when git normalizes working-tree content during `getDiff()`.
 * Fully closing that requires not applying attributes/filters (no single git flag does this) and
 * is deferred to the OS sandbox (S4) / a project-trust gate rather than solved per-command here.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { execCommand } from "../exec.ts";
import { classifyBashReadOnly } from "../execpolicy/index.ts";
import { redactSecrets } from "../security/index.ts";
import { findGitPaths, resolveBranchWithGitAsync } from "./paths.ts";
import { isSafeRefName, isValidGitSha } from "./validate.ts";

const DEFAULT_READ_TIMEOUT_MS = 20_000;

/** Global hardening flags prepended to every read invocation (before the subcommand). */
export const GIT_READ_HARDENING: readonly string[] = [
	"--no-optional-locks",
	"-c",
	"core.hooksPath=/dev/null",
	"-c",
	"core.fsmonitor=false",
];

export interface GitReadOptions {
	signal?: AbortSignal;
	timeout?: number;
	/** Redact secret-shaped tokens from stdout (default true). Only the secret-scan path sets false. */
	redact?: boolean;
}

export interface GitReadResult {
	stdout: string;
	code: number;
}

export interface GitStatusEntry {
	path: string;
	/** Index (staged) status char from `git status --porcelain`. */
	index: string;
	/** Worktree (unstaged) status char. */
	worktree: string;
}

export interface GitStatus {
	branch: string | null;
	ahead: number;
	behind: number;
	staged: GitStatusEntry[];
	unstaged: GitStatusEntry[];
	/** Unmerged/conflict entries (UU, AA, DD, AU, UD, UA, DU) — kept out of staged/unstaged. */
	conflicted: GitStatusEntry[];
	untracked: string[];
	isClean: boolean;
}

export interface GitCommitEntry {
	sha: string;
	subject: string;
}

/** POSIX single-quote an argv token when reconstructing a command string for the classifier. */
function shellQuote(arg: string): string {
	if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) return arg;
	return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * Assert `args` describe a read-only git invocation, reusing the S2 execpolicy classifier
 * (which understands the nuanced verbs — `config --get`, `remote get-url`, `branch --list`).
 * The classifier is run on the caller's args WITHOUT the hardening flags, because a
 * `-c core.fsmonitor=…` / `core.hooksPath=…` override is itself treated as write-capable.
 */
function assertReadOnly(args: string[]): void {
	// An empty-string arg is dropped by the classifier's tokenizer but still passed to git,
	// so the checked argv would diverge from the executed one. No read helper needs one.
	if (args.some((a) => a.length === 0)) {
		throw new Error("runGitRead: empty argument is not allowed");
	}
	const command = `git ${args.map(shellQuote).join(" ")}`;
	if (!classifyBashReadOnly(command)) {
		throw new Error(`runGitRead refused a non-read-only git invocation: ${command}`);
	}
}

/**
 * Run a read-only git command. Throws if `args` are not classified read-only.
 * Returns captured stdout (redacted by default) and the exit code — non-zero codes
 * are returned, not thrown, so callers can treat "not a repo" / "no upstream" as data.
 */
export async function runGitRead(args: string[], cwd: string, opts?: GitReadOptions): Promise<GitReadResult> {
	assertReadOnly(args);
	const result = await execCommand("git", [...GIT_READ_HARDENING, ...args], cwd, {
		signal: opts?.signal,
		timeout: opts?.timeout ?? DEFAULT_READ_TIMEOUT_MS,
	});
	// A killed child (abort / timeout) yields truncated stdout with an unreliable exit code;
	// treat it as failure rather than letting callers mistake a partial read for success.
	if (result.killed) {
		throw new Error(`runGitRead: git aborted or timed out: git ${args.join(" ")}`);
	}
	const stdout = opts?.redact === false ? result.stdout : redactSecrets(result.stdout);
	return { stdout, code: result.code };
}

/** Repository root (worktree-correct) for `cwd`, or null when not inside a repo. */
export async function getGitRoot(cwd: string, opts?: GitReadOptions): Promise<string | null> {
	const paths = findGitPaths(cwd);
	if (paths) return paths.repoDir;
	const r = await runGitRead(["rev-parse", "--show-toplevel"], cwd, opts);
	const top = r.stdout.trim();
	return r.code === 0 && top ? top : null;
}

/** Current branch, or null on detached HEAD / not a repo. */
export async function getCurrentBranch(cwd: string): Promise<string | null> {
	const root = findGitPaths(cwd)?.repoDir ?? cwd;
	return resolveBranchWithGitAsync(root);
}

/** Full commit SHA of HEAD, or null when there is no HEAD (empty repo / not a repo). */
export async function getHeadSha(cwd: string, opts?: GitReadOptions): Promise<string | null> {
	const r = await runGitRead(["rev-parse", "HEAD"], cwd, opts);
	const sha = r.stdout.trim();
	return r.code === 0 && isValidGitSha(sha) ? sha : null;
}

/**
 * Best-effort default branch: the `origin/HEAD` symref, else a local `main`/`master`
 * that actually exists, else null.
 */
export async function getDefaultBranch(cwd: string, opts?: GitReadOptions): Promise<string | null> {
	const symref = await runGitRead(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], cwd, opts);
	if (symref.code === 0) {
		const name = symref.stdout.trim().replace(/^origin\//, "");
		if (name) return name;
	}
	for (const candidate of ["main", "master"]) {
		const r = await runGitRead(["rev-parse", "--verify", "--quiet", `refs/heads/${candidate}`], cwd, opts);
		if (r.code === 0 && r.stdout.trim()) return candidate;
	}
	return null;
}

/** URL of a remote (default `origin`), or null when unset. */
export async function getRemoteUrl(cwd: string, remote = "origin", opts?: GitReadOptions): Promise<string | null> {
	if (!isSafeRefName(remote)) return null;
	const r = await runGitRead(["config", "--get", `remote.${remote}.url`], cwd, opts);
	const url = r.stdout.trim();
	return r.code === 0 && url ? url : null;
}

/** The seven porcelain-v1 unmerged status pairs (DD, AU, UD, UA, DU, AA, UU). */
function isUnmergedPair(index: string, worktree: string): boolean {
	return (
		index === "U" || worktree === "U" || (index === "A" && worktree === "A") || (index === "D" && worktree === "D")
	);
}

/**
 * Parse NUL-delimited `git status --porcelain=v1 -b -z` output into structured form.
 * NUL framing (`-z`) is used so paths with spaces / non-ASCII bytes arrive verbatim
 * rather than C-quoted; rename/copy entries emit the origin path as a following record.
 */
function parseStatus(stdout: string): GitStatus {
	let branch: string | null = null;
	let ahead = 0;
	let behind = 0;
	const staged: GitStatusEntry[] = [];
	const unstaged: GitStatusEntry[] = [];
	const conflicted: GitStatusEntry[] = [];
	const untracked: string[] = [];

	const records = stdout.split("\0");
	for (let i = 0; i < records.length; i++) {
		const record = records[i];
		if (record.length === 0) continue;
		if (record.startsWith("## ")) {
			const info = record.slice(3);
			if (info.startsWith("No commits yet on ")) {
				branch = info.replace(/^No commits yet on /, "").trim() || null;
			} else if (info.startsWith("HEAD ")) {
				branch = null; // detached
			} else {
				branch = info.split(" ")[0].split("...")[0] || null;
			}
			const aheadMatch = info.match(/\bahead (\d+)/);
			if (aheadMatch) ahead = Number(aheadMatch[1]);
			const behindMatch = info.match(/\bbehind (\d+)/);
			if (behindMatch) behind = Number(behindMatch[1]);
			continue;
		}
		const index = record[0];
		const worktree = record[1];
		const path = record.slice(3);
		// Rename/copy: the origin path is the next NUL record (new path is in this one) — consume it.
		if (index === "R" || index === "C" || worktree === "R" || worktree === "C") {
			i += 1;
		}
		if (index === "?" && worktree === "?") {
			untracked.push(path);
			continue;
		}
		if (isUnmergedPair(index, worktree)) {
			conflicted.push({ path, index, worktree });
			continue;
		}
		if (index !== " " && index !== "?") staged.push({ path, index, worktree });
		if (worktree !== " " && worktree !== "?") unstaged.push({ path, index, worktree });
	}

	const isClean = staged.length === 0 && unstaged.length === 0 && conflicted.length === 0 && untracked.length === 0;
	return { branch, ahead, behind, staged, unstaged, conflicted, untracked, isClean };
}

/** Structured working-tree status, or null when not inside a repo. */
export async function getStatus(cwd: string, opts?: GitReadOptions): Promise<GitStatus | null> {
	const r = await runGitRead(["status", "--porcelain=v1", "-b", "-z", "--untracked-files=normal"], cwd, opts);
	if (r.code !== 0) return null;
	return parseStatus(r.stdout);
}

/** Most recent commits (newest first), up to `limit`. Empty when the repo has no commits. */
export async function getRecentCommits(cwd: string, limit: number, opts?: GitReadOptions): Promise<GitCommitEntry[]> {
	const n = Math.max(1, Math.floor(limit));
	// %x1f = unit-separator between sha and subject, so subjects with spaces parse cleanly.
	const r = await runGitRead(["log", `-${n}`, "--no-color", "--pretty=format:%H%x1f%s"], cwd, opts);
	if (r.code !== 0) return [];
	const commits: GitCommitEntry[] = [];
	for (const line of r.stdout.split("\n")) {
		if (!line) continue;
		const sep = line.indexOf("\x1f");
		if (sep < 0) continue;
		commits.push({ sha: line.slice(0, sep), subject: line.slice(sep + 1) });
	}
	return commits;
}

export interface GitDiffOptions extends GitReadOptions {
	/** Diff the staged (index) changes rather than the working tree. */
	staged?: boolean;
	/** Diff against a base ref/commit (validated as a safe ref or full SHA). */
	base?: string;
}

/**
 * Unified diff. Working tree by default; `staged` diffs the index; `base` diffs against
 * a ref/SHA. Redacted by default — pass `{ redact: false }` (and discard the text) only
 * for the secret pre-scan.
 */
export async function getDiff(cwd: string, opts?: GitDiffOptions): Promise<string> {
	// --no-ext-diff / --no-textconv stop a hostile repo's `diff.external` or a per-path
	// `diff.<driver>.textconv` from executing during a read. (These are diff-subcommand
	// options; they cannot go in the global hardening prefix.) A residual `filter.*.clean`
	// vector on working-tree reads is documented as out of scope for G1 — see module notes.
	const args = ["diff", "--no-color", "--no-ext-diff", "--no-textconv"];
	if (opts?.staged) args.push("--cached");
	if (opts?.base) {
		if (!isSafeRefName(opts.base) && !isValidGitSha(opts.base)) {
			throw new Error(`getDiff: unsafe base ref: ${opts.base}`);
		}
		args.push(opts.base);
	}
	const r = await runGitRead(args, cwd, opts);
	return r.stdout;
}

/** Paths currently staged in the index. */
export async function getStagedFiles(cwd: string, opts?: GitReadOptions): Promise<string[]> {
	// -z yields NUL-terminated, un-quoted paths (spaces / non-ASCII survive verbatim).
	const r = await runGitRead(["diff", "--cached", "--name-only", "-z"], cwd, opts);
	if (r.code !== 0) return [];
	return r.stdout.split("\0").filter((p) => p.length > 0);
}

/** True if an in-progress merge/rebase/cherry-pick/bisect makes it unsafe to commit. */
export async function isTransientState(cwd: string): Promise<boolean> {
	const paths = findGitPaths(cwd);
	if (!paths) return false;
	// Merge/rebase/cherry-pick/bisect state lives in the PER-WORKTREE gitdir (dirname of HEAD),
	// not the shared commonGitDir — otherwise an in-progress op inside a linked worktree is missed.
	const gitDir = dirname(paths.headPath);
	const markers = ["MERGE_HEAD", "rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD", "BISECT_LOG"];
	return markers.some((m) => existsSync(join(gitDir, m)));
}

/** True if HEAD is ahead of its upstream (commits not yet pushed). False when there is no upstream. */
export async function hasUnpushedCommits(cwd: string, opts?: GitReadOptions): Promise<boolean> {
	const r = await runGitRead(["rev-list", "--count", "@{upstream}..HEAD"], cwd, opts);
	if (r.code !== 0) return false;
	return Number(r.stdout.trim() || "0") > 0;
}
