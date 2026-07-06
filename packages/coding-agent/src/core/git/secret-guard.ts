/**
 * Secret-in-diff guard (Wave 2.2, slice G1).
 *
 * Pre-commit rail: refuse to help commit a diff that introduces a recognizable secret
 * (a leaked `.env` line, an API key, a private-key block). Reuses the 1.6 secret
 * detector (`containsSecret`) so the format coverage stays in one place.
 *
 * Scans ADDED lines only (`+`, excluding the `+++` file header): removing or context
 * lines that merely mention a secret must not block a commit, and a secret already in
 * history is not this guard's concern.
 *
 * NOTE: this operates on a RAW (unredacted) diff. `getDiff()` redacts by default for
 * model/transcript safety; the commit-flow caller must fetch the diff with
 * `{ redact: false }` for this scan and discard the raw text afterwards.
 */

import { containsSecret } from "../security/index.ts";

/** True if the diff's added lines introduce a recognizable secret. */
export function diffContainsLikelySecret(diff: string): boolean {
	if (!diff) return false;
	const addedLines: string[] = [];
	for (const line of diff.split("\n")) {
		if (line.startsWith("+") && !line.startsWith("+++")) {
			addedLines.push(line.slice(1));
		}
	}
	return addedLines.length > 0 && containsSecret(addedLines.join("\n"));
}
