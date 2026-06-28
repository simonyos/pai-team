/**
 * The three-value command-safety decision (Wave 1, slice S2).
 *
 * Ported from Codex `execpolicy/src/decision.rs`. The ordering is the entire
 * conflict-resolution strategy: when several rules (or pipeline segments) match,
 * the MOST RESTRICTIVE decision wins. Erasable-TS: string union + const rank map,
 * no `enum`.
 */

export type Decision = "allow" | "prompt" | "forbidden";

/** Higher rank == more restrictive. `forbidden` > `prompt` > `allow`. */
const RANK: Record<Decision, number> = { allow: 0, prompt: 1, forbidden: 2 };

/** Return the more restrictive of two decisions. */
export function mostRestrictive(a: Decision, b: Decision): Decision {
	return RANK[a] >= RANK[b] ? a : b;
}

/** Reduce a list of decisions to the most restrictive. Empty list defaults to `allow`. */
export function mostRestrictiveOf(decisions: readonly Decision[]): Decision {
	let worst: Decision = "allow";
	for (const d of decisions) worst = mostRestrictive(worst, d);
	return worst;
}
