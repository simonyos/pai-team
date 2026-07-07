/**
 * `/commit` coded-command core logic (Wave 2.2, slice G4).
 *
 * This module never mutates the repository itself. It reads live, real git state
 * via G1 (`git-helpers.ts`) and G1's secret guard (`secret-guard.ts`), decides
 * whether committing should be refused right now, and — when not refused —
 * composes a Git-Safety-Protocol-primed prompt (G3, `git-safety-prompt.ts`) that
 * hands the actual commit off to the model, which drives it through its own
 * governed tool access (bash / the git tool). "Invoking the command IS the
 * explicit ask" — the command's job is pre-flight state + guardrails, not the
 * mutation.
 *
 * Shared by all 3 execution surfaces (interactive, RPC, print/headless) so the
 * refuse/compose logic lives in exactly one place — see each mode's wiring site
 * (interactive-mode.ts buildCodedCommands, rpc-mode.ts handleCommand's "commit"
 * case, print-mode.ts handleCodedCommand) for how they call into this function.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { type GitStatus, getCurrentBranch, getDiff, getStatus } from "./git-helpers.ts";
import { buildGitSafetySection } from "./git-safety-prompt.ts";
import { findGitPaths } from "./paths.ts";
import { diffContainsLikelySecret } from "./secret-guard.ts";

/** Explicit user-typed flag (`/commit --allow-secrets ...`) that overrides the staged-secret refusal. */
const ALLOW_SECRETS_FLAG = "--allow-secrets";

export type CommitCommandResult = { kind: "refuse"; message: string } | { kind: "prompt"; text: string };

/**
 * Outcome of the shared commit preconditions check (transient state, not-a-repo,
 * conflicts, nothing-to-commit, likely-secret), plus — when committing is viable —
 * the real current status and a ready-to-embed diff section describing what should
 * be committed. Extracted so `/commit-push-pr` (G5) can reuse the exact same refuse
 * logic and diff selection without duplicating it (see commit-push-pr-command.ts).
 */
export type CommitPreconditions =
	| { kind: "refuse"; message: string }
	| { kind: "ready"; status: GitStatus; diffSection: string };

/**
 * The same markers `isTransientState` (git-helpers.ts) checks, paired with a
 * human-readable description so a refusal can tell the user what it detected.
 * Kept in sync manually (small, stable list) rather than widening
 * `isTransientState`'s return type, which other G1 callers depend on staying a
 * plain boolean.
 */
const TRANSIENT_STATE_MARKERS: ReadonlyArray<readonly [marker: string, description: string]> = [
	["MERGE_HEAD", "an in-progress merge"],
	["rebase-merge", "an in-progress rebase"],
	["rebase-apply", "an in-progress rebase"],
	["CHERRY_PICK_HEAD", "an in-progress cherry-pick"],
	["BISECT_LOG", "an in-progress bisect"],
];

/** Best-effort description of the detected transient git state, or null if none / not a repo. */
function describeTransientState(cwd: string): string | null {
	const paths = findGitPaths(cwd);
	if (!paths) return null;
	// Per-worktree gitdir, matching isTransientState's own resolution.
	const gitDir = dirname(paths.headPath);
	for (const [marker, description] of TRANSIENT_STATE_MARKERS) {
		if (existsSync(join(gitDir, marker))) return description;
	}
	return null;
}

/** Human-readable summary of the current status for the primed prompt. */
export function formatStatusSummary(status: GitStatus): string {
	const lines: string[] = [`Current branch (per status): ${status.branch ?? "(detached HEAD)"}`];
	lines.push(`Staged: ${status.staged.length === 0 ? "(none)" : status.staged.map((e) => e.path).join(", ")}`);
	lines.push(`Unstaged: ${status.unstaged.length === 0 ? "(none)" : status.unstaged.map((e) => e.path).join(", ")}`);
	if (status.conflicted.length > 0) {
		lines.push(`Conflicted: ${status.conflicted.map((e) => e.path).join(", ")}`);
	}
	if (status.untracked.length > 0) {
		lines.push(`Untracked: ${status.untracked.join(", ")}`);
	}
	return lines.join("\n");
}

/**
 * Build the result for a submitted `/commit [args]`.
 *
 * Refuse conditions (checked in this priority order):
 *   1. A transient git state (in-progress merge/rebase/cherry-pick/bisect) makes
 *      committing unsafe right now.
 *   2. Unresolved merge conflicts are present (`status.conflicted`), regardless of
 *      whether a marker file from #1 is present — e.g. a `git stash pop`/`apply`
 *      conflict leaves unmerged (`UU`) entries in status but writes no marker file
 *      (only `AUTO_MERGE`, which #1 does not check), so this must be checked
 *      independently rather than folded into #1.
 *   3. Nothing is staged, unstaged, or untracked — genuinely nothing to commit
 *      (determined by reading the REAL current status, never assumed).
 *   4. The REAL diff that will be shown to the model (staged if present, else
 *      unstaged) looks like it contains a secret, unless the user explicitly
 *      passed `--allow-secrets` in `args`.
 *
 * Otherwise composes a Git-Safety-Protocol-primed prompt containing the real
 * status and real diff (staged if present, else the unstaged diff with an
 * instruction to stage first) for the model to act on.
 */
export async function evaluateCommitPreconditions(cwd: string, args: string): Promise<CommitPreconditions> {
	const transientDescription = describeTransientState(cwd);
	if (transientDescription) {
		return {
			kind: "refuse",
			message: `Refusing to commit: ${transientDescription} is in progress, which makes committing unsafe right now. Resolve it (finish or abort the operation) first, then run /commit again.`,
		};
	}

	const status = await getStatus(cwd);
	if (!status) {
		return { kind: "refuse", message: "Refusing to commit: this does not look like a git repository." };
	}

	if (status.conflicted.length > 0) {
		return {
			kind: "refuse",
			message: `Refusing to commit: unresolved merge conflicts in ${status.conflicted.map((e) => e.path).join(", ")}. Resolve the conflicts (remove the <<<<<<< / ======= / >>>>>>> markers and stage the resolved files), then run /commit again.`,
		};
	}

	if (status.isClean) {
		return {
			kind: "refuse",
			message: "Nothing to commit — the working tree is clean (no staged, unstaged, or untracked changes).",
		};
	}

	const allowSecrets = args.trim().split(/\s+/).includes(ALLOW_SECRETS_FLAG);
	const hasStaged = status.staged.length > 0;

	if (hasStaged) {
		// Read the REAL currently-staged diff (never trust a model/prompt claim about what
		// is staged) — raw (unredacted) so the secret scan sees actual values, then discard
		// that raw copy immediately in favor of the redacted one used in the prompt.
		const rawStagedDiff = await getDiff(cwd, { staged: true, redact: false });
		if (!allowSecrets && diffContainsLikelySecret(rawStagedDiff)) {
			return {
				kind: "refuse",
				message:
					"Refusing to commit: the staged changes look like they contain a secret (an API key, credential, or similar). Review what's staged and remove it, or re-run `/commit --allow-secrets` if this is a false positive.",
			};
		}
		const stagedDiff = await getDiff(cwd, { staged: true });
		return { kind: "ready", status, diffSection: `Staged diff:\n${stagedDiff}` };
	}

	if (status.unstaged.length > 0) {
		// Same raw-then-discard pattern as the staged case: scan the real unstaged diff for
		// secrets before it is shown to the model, since this is the diff /commit is about
		// to hand off (nothing is staged, so this is what the model will be told to stage).
		const rawUnstagedDiff = await getDiff(cwd, { redact: false });
		if (!allowSecrets && diffContainsLikelySecret(rawUnstagedDiff)) {
			return {
				kind: "refuse",
				message:
					"Refusing to commit: the unstaged changes look like they contain a secret (an API key, credential, or similar). Review the changes and remove it, or re-run `/commit --allow-secrets` if this is a false positive.",
			};
		}
		const unstagedDiff = await getDiff(cwd);
		return {
			kind: "ready",
			status,
			diffSection: `Nothing is staged yet, but there are unstaged changes. Stage the files relevant to this commit first (e.g. \`git add <files>\`), then commit.\n\nUnstaged diff:\n${unstagedDiff}`,
		};
	}

	// Only untracked file(s) — `git diff` shows nothing for these, so there is no diff to
	// scan or display; the file list is already in the status summary above.
	return {
		kind: "ready",
		status,
		diffSection:
			"Nothing is staged yet, but there are untracked file(s) that may be relevant (see Untracked above). Review them and `git add` the ones relevant to this commit, then commit.",
	};
}

export async function buildCommitCommand(cwd: string, args: string): Promise<CommitCommandResult> {
	const preconditions = await evaluateCommitPreconditions(cwd, args);
	if (preconditions.kind === "refuse") {
		return preconditions;
	}

	const branch = await getCurrentBranch(cwd);

	const sections = [
		buildGitSafetySection(),
		`Current branch: ${branch ?? "(detached HEAD)"}`,
		`Current status:\n${formatStatusSummary(preconditions.status)}`,
		preconditions.diffSection,
		"The user has asked to commit. Write a clear, descriptive commit message for this change, then create the commit using your normal tool access (bash or the git tool), following the safety protocol above.",
	];

	return { kind: "prompt", text: sections.join("\n\n") };
}
