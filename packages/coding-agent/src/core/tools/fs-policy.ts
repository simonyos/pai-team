/**
 * Filesystem scoping policy (Wave 1, slice S3).
 *
 * Pure, path-based read/write guards for the file tools. `assertWritable` keeps
 * writes inside an allowlist of roots and out of protected paths (.git internals,
 * secrets); `assertReadable` blocks reads of secret files. These are the
 * last-line, in-tool enforcement primitive — the resolver (S1) decides allow/ask/
 * deny earlier, and the OS sandbox (S4) provides kernel-level enforcement later.
 *
 * SCOPE: this is intentionally OPT-IN. A tool with no `FsPolicy` enforces nothing
 * (preserving existing behavior); a host that wants scoping passes one (e.g. via
 * `createDefaultFsPolicy`). It guards the structured file tools that take a path
 * argument: read, write, edit, and grep (content reads). Out of scope by design:
 *  - `bash`, which can read/write any path, is governed by the command-safety
 *    engine (S2) and the OS sandbox (S4), not by FsPolicy.
 *  - `ls`/`find` may still reveal the NAMES of denied paths (metadata, not content).
 *  - symlinks are NOT resolved here (pure path math) — that escape is closed by S4.
 * An empty `writableRoots` is an explicit opt-out of write-root confinement (only
 * the deny lists apply); `createDefaultFsPolicy` never produces one. Erasable-TS.
 */

import { tmpdir } from "node:os";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { minimatch } from "minimatch";

export interface FsPolicy {
	/**
	 * Absolute directory roots within which writes are permitted. When empty, writes
	 * are not root-restricted (only the deny lists apply).
	 */
	writableRoots: string[];
	/** Path rules that must never be read (secrets). */
	denyRead: string[];
	/** Path rules that must never be written (.git internals, secrets). */
	denyWrite: string[];
}

/** Raised when a file operation violates the active {@link FsPolicy}. */
export class FsPolicyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "FsPolicyError";
	}
}

/** Is `child` the same as, or nested inside, `parent`? Pure path math (no fs, no symlink resolution). */
export function isInside(child: string, parent: string): boolean {
	const rel = relative(parent, child);
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/**
 * On case-insensitive filesystems (macOS, Windows) `.GIT` and `.git` are the SAME
 * file, so deny rules must match case-insensitively or they are trivially bypassed.
 */
const CASE_INSENSITIVE_FS = process.platform === "darwin" || process.platform === "win32";

/**
 * Does `absPath` match a deny rule? A rule is one of (checked in this order):
 *  - a glob (`*`/`?`/`[`) → matched against the full path AND the basename (dot-aware);
 *    glob is tested before absoluteness so an absolute glob like "/secrets/*" works
 *  - an absolute path → matches that path or anything inside it
 *  - a bare name (e.g. ".git") → matches when any path segment equals it
 * Matching is case-insensitive on case-insensitive filesystems.
 */
function matchesRule(absPath: string, rule: string): boolean {
	if (rule.includes("*") || rule.includes("?") || rule.includes("[")) {
		const opts = { dot: true, nocase: CASE_INSENSITIVE_FS };
		return minimatch(absPath, rule, opts) || minimatch(basename(absPath), rule, opts);
	}
	if (isAbsolute(rule)) {
		return isInside(absPath, rule);
	}
	if (CASE_INSENSITIVE_FS) {
		const lowerRule = rule.toLowerCase();
		return absPath.split(sep).some((segment) => segment.toLowerCase() === lowerRule);
	}
	return absPath.split(sep).includes(rule);
}

function matchesAny(absPath: string, rules: readonly string[]): string | undefined {
	for (const rule of rules) {
		if (matchesRule(absPath, rule)) return rule;
	}
	return undefined;
}

/**
 * Throw if `absPath` (an already-resolved absolute path) may not be written under
 * `policy`: outside every writable root, or matching a denyWrite rule.
 */
export function assertWritable(absPath: string, policy: FsPolicy): void {
	const denied = matchesAny(absPath, policy.denyWrite);
	if (denied !== undefined) {
		throw new FsPolicyError(`Write blocked: ${absPath} is a protected path (matched deny rule "${denied}").`);
	}
	if (policy.writableRoots.length > 0 && !policy.writableRoots.some((root) => isInside(absPath, root))) {
		throw new FsPolicyError(
			`Write blocked: ${absPath} is outside the writable workspace (${policy.writableRoots.join(", ")}).`,
		);
	}
}

/** Throw if `absPath` (an already-resolved absolute path) may not be read under `policy`. */
export function assertReadable(absPath: string, policy: FsPolicy): void {
	const denied = matchesAny(absPath, policy.denyRead);
	if (denied !== undefined) {
		throw new FsPolicyError(`Read blocked: ${absPath} is a protected path (matched deny rule "${denied}").`);
	}
}

/** Non-throwing form of {@link assertReadable}: true when `absPath` is denied for reading. */
export function isReadDenied(absPath: string, policy: FsPolicy): boolean {
	return matchesAny(absPath, policy.denyRead) !== undefined;
}

/** Version-control and credential directories that should never be written, and whose contents are sensitive. */
const PROTECTED_DIRS: readonly string[] = [".git", ".ssh", ".aws", ".gnupg"];
/** Common secret-file globs (keys, env files, credentials). */
const SECRET_GLOBS: readonly string[] = [
	"*.pem",
	"*.key",
	"id_rsa",
	"id_dsa",
	"id_ecdsa",
	"id_ed25519",
	".env",
	".env.*",
	"*.pfx",
	"*.p12",
];

/**
 * A sensible default policy: writes confined to the workspace (cwd) and the OS temp
 * dir, with version-control internals and secrets denied for both read and write.
 * Not applied automatically — a host opts in (sandbox / restricted mode).
 */
export function createDefaultFsPolicy(cwd: string): FsPolicy {
	return {
		writableRoots: [resolve(cwd), resolve(tmpdir())],
		denyRead: [...PROTECTED_DIRS, ...SECRET_GLOBS],
		denyWrite: [...PROTECTED_DIRS, ...SECRET_GLOBS],
	};
}
