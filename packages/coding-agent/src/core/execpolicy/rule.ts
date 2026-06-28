/**
 * Argv-token prefix rules (Wave 1, slice S2).
 *
 * Ported from Codex `execpolicy/src/rule.rs`. A rule matches against the
 * already-tokenized argv vector token-by-token — NO regex, no shell re-parsing
 * of the matched part — which is what makes "git status" structurally distinct
 * from "git push". Erasable-TS: discriminated union, no `enum`.
 */

import type { Decision } from "./decision.ts";

export type PatternToken = { kind: "single"; value: string } | { kind: "alts"; values: string[] };

export interface PrefixPattern {
	/** argv[0] — the program. Rules are indexed by this. */
	first: string;
	/** argv[1..] tokens to match in order. */
	rest: PatternToken[];
}

export interface PrefixRule {
	pattern: PrefixPattern;
	decision: Decision;
	/** Surfaced in approval prompts / denial messages ("blocked because: …"). */
	justification?: string;
}

/** A token that must equal `value` exactly. */
export function single(value: string): PatternToken {
	return { kind: "single", value };
}

/** A token that must equal one of `values`. */
export function alts(...values: string[]): PatternToken {
	return { kind: "alts", values };
}

function tokenMatches(token: PatternToken, arg: string): boolean {
	return token.kind === "single" ? token.value === arg : token.values.includes(arg);
}

/**
 * Does `argv` start with this pattern? The command must be at least as long as
 * the pattern, argv[0] must equal `first`, and each `rest` token must match the
 * corresponding argv token. Trailing args beyond the pattern are ignored, so
 * `["git","status","--short"]` matches the `git status` rule but `["git","push"]`
 * does not.
 */
export function matchPrefix(argv: readonly string[], pattern: PrefixPattern): boolean {
	if (argv.length < pattern.rest.length + 1) return false;
	if (argv[0] !== pattern.first) return false;
	for (let k = 0; k < pattern.rest.length; k++) {
		if (!tokenMatches(pattern.rest[k], argv[k + 1])) return false;
	}
	return true;
}

/** Build an exact-match prefix rule from a concrete argv prefix (runtime "always allow X"). */
export function exactPrefixRule(prefix: readonly string[], decision: Decision, justification?: string): PrefixRule {
	const [first, ...rest] = prefix;
	return {
		pattern: { first: first ?? "", rest: rest.map(single) },
		decision,
		justification,
	};
}
