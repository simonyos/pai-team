/**
 * `/branch` coded-command core logic (Wave 2.2, slice G4).
 *
 * Mirrors `commit-command.ts`: this module never mutates the repository. It
 * reads live git state via G1 (`git-helpers.ts`), decides whether creating a
 * branch should be refused right now, and — when not refused — composes a
 * Git-Safety-Protocol-primed prompt (G3) that hands branch creation off to the
 * model, which drives it through its own governed tool access (bash / the git
 * tool).
 *
 * Shared by all 3 execution surfaces — see each mode's wiring site for how they
 * call into this function.
 */

import { type GitStatus, getCurrentBranch, getDefaultBranch, getStatus, isTransientState } from "./git-helpers.ts";
import { buildGitSafetySection } from "./git-safety-prompt.ts";

export type BranchCommandResult = { kind: "refuse"; message: string } | { kind: "prompt"; text: string };

/** Human-readable one-line summary of the current status for the primed prompt. */
function formatStatusSummary(status: GitStatus): string {
	if (status.isClean) return "Working tree is clean.";
	const parts: string[] = [];
	if (status.staged.length > 0) parts.push(`${status.staged.length} staged file(s)`);
	if (status.unstaged.length > 0) parts.push(`${status.unstaged.length} unstaged file(s)`);
	if (status.conflicted.length > 0) parts.push(`${status.conflicted.length} conflicted file(s)`);
	if (status.untracked.length > 0) parts.push(`${status.untracked.length} untracked file(s)`);
	return parts.length > 0 ? `Working tree has ${parts.join(", ")}.` : "Working tree is clean.";
}

/**
 * Build the result for a submitted `/branch <free-text purpose>`.
 *
 * There is no required exact syntax — `args` is the user's free-text
 * description of what the branch is for (e.g. "fix the login bug").
 *
 * Refuse conditions (checked in this priority order):
 *   1. A transient git state (in-progress merge/rebase/cherry-pick/bisect) makes
 *      creating a branch unsafe right now.
 *   2. Not a git repository at all (mirrors `commit-command.ts`'s equivalent check).
 *   3. Unresolved merge conflicts are present (`status.conflicted`), regardless of
 *      whether a marker file from #1 is present — e.g. a `git stash pop`/`apply`
 *      conflict leaves unmerged (`UU`) entries in status but writes no marker file.
 *   4. `args` is empty/blank — nothing to name a branch from.
 *
 * Otherwise composes a Git-Safety-Protocol-primed prompt with the current and
 * default branch, the current status, and the user's stated purpose, asking the
 * model to choose a clear conventional branch name and create it.
 */
export async function buildBranchCommand(cwd: string, args: string): Promise<BranchCommandResult> {
	if (await isTransientState(cwd)) {
		return {
			kind: "refuse",
			message:
				"Refusing to create a branch: an in-progress merge/rebase/cherry-pick/bisect makes this unsafe right now. Resolve it first, then run /branch again.",
		};
	}

	const status = await getStatus(cwd);
	if (!status) {
		return { kind: "refuse", message: "Refusing to create a branch: this does not look like a git repository." };
	}

	if (status.conflicted.length > 0) {
		return {
			kind: "refuse",
			message: `Refusing to create a branch: unresolved merge conflicts in ${status.conflicted.map((e) => e.path).join(", ")}. Resolve the conflicts first, then run /branch again.`,
		};
	}

	const purpose = args.trim();
	if (!purpose) {
		return {
			kind: "refuse",
			message:
				"Usage: /branch <what the branch is for> — describe what you want the branch for, e.g. `/branch fix the login bug`.",
		};
	}

	const [currentBranch, defaultBranch] = await Promise.all([getCurrentBranch(cwd), getDefaultBranch(cwd)]);

	const sections = [
		buildGitSafetySection(),
		`Current branch: ${currentBranch ?? "(detached HEAD)"}`,
		`Default branch: ${defaultBranch ?? "(unknown)"}`,
		`Current status: ${formatStatusSummary(status)}`,
		`The user wants a new branch for: ${purpose}`,
		"Choose a clear, conventional branch name (e.g. kebab-case, short, descriptive of the stated purpose), consider whether any uncommitted changes shown above should be carried onto the new branch or handled first, and create the branch using your normal tool access (e.g. `git checkout -b <name>`), following the safety protocol above.",
	];

	return { kind: "prompt", text: sections.join("\n\n") };
}
