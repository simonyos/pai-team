/**
 * Ref / SHA validation (Wave 2.2, slice G1).
 *
 * Guards user- or model-supplied ref names and object ids before they reach a git
 * invocation. Even though git-helpers spawns argv directly (shell:false, no shell
 * metacharacter surface), an unvalidated name like `--upload-pack=…` or `-x` can be
 * misread as an option, and `..` / `@{` ranges can widen a diff unexpectedly. Callers
 * that pass a ref/base into a git command MUST validate it here first.
 */

/**
 * A safe git ref/branch name: no leading `-` (option injection) or `/`, no `..` range
 * or `@{` reflog syntax, no whitespace/control/glob characters. A conservative subset
 * of `git check-ref-format` — rejects more than git does, never accepts what git rejects.
 */
export function isSafeRefName(name: string): boolean {
	if (!name || name.length > 255) return false;
	if (name.startsWith("-") || name.startsWith("/") || name.endsWith("/")) return false;
	if (name.includes("..") || name.includes("@{") || name.endsWith(".lock")) return false;
	// Control chars, space, and the characters git itself forbids in ref names.
	if (/[\x00-\x20\x7f ~^:?*[\\]/.test(name)) return false;
	return /^[A-Za-z0-9/._+@-]+$/.test(name);
}

/** A full-length git object id: 40 hex (SHA-1) or 64 hex (SHA-256). Abbreviated ids are rejected. */
export function isValidGitSha(s: string): boolean {
	return /^[0-9a-f]{40}$/.test(s) || /^[0-9a-f]{64}$/.test(s);
}
