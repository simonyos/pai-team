/**
 * `/commit-push-pr` coded-command core logic (Wave 2.2, slice G5).
 *
 * Mirrors `commit-command.ts`/`branch-command.ts`: this module NEVER mutates the
 * repository — it never runs `git push` or `gh pr create`. It only performs reads
 * (G1's `git-helpers.ts` plus a couple of direct `gh` read invocations, the same
 * `spawnSync("gh", ...)` shape `handleShareCommand` uses for `/share`), decides
 * whether the flow should be refused right now, and — when not refused — composes a
 * Git-Safety-Protocol-primed prompt (G3) that hands the actual branch → commit →
 * push → PR sequence to the model, which drives it through its own governed tool
 * access (bash / the git tool). The model's mutations flow through the already
 * shipped permission gate; the primed prompt only supplies state + guardrails.
 *
 * Corrected per D6 (resolved 2026-07-07): no `git fetch`/`git pull` anywhere.
 * Existing-PR detection is a live `gh pr list` read (a GitHub API call, so it can't
 * go stale); existing-branch/unpushed detection relies on G1's local-ref helpers,
 * kept accurate for free by the flow's own fast-forward-only `git push`.
 *
 * Shared by all 3 execution surfaces (interactive, RPC, print/headless) — see each
 * mode's wiring site for how they call into this function.
 */

import { spawnSync } from "node:child_process";
import { type CommitPreconditions, evaluateCommitPreconditions, formatStatusSummary } from "./commit-command.ts";
import { getCurrentBranch, getDefaultBranch } from "./git-helpers.ts";
import { buildGitSafetySection } from "./git-safety-prompt.ts";
import { getMainRepoRoot } from "./paths.ts";

/** `/commit-push-pr --reviewer <name> ...` — request a review from `<name>` on the created PR. */
const REVIEWER_FLAG = "--reviewer";
/** Passed through to `/commit`'s preconditions; stripped from the free-text PR title/description hint. */
const ALLOW_SECRETS_FLAG = "--allow-secrets";

/** Force `gh` / `git` non-interactive for this module's own read invocations (mirrors getShellEnv's G5 default). */
const NON_INTERACTIVE_ENV: NodeJS.ProcessEnv = {
	...process.env,
	GH_PROMPT_DISABLED: "1",
	GIT_TERMINAL_PROMPT: "0",
};

export type CommitPushPrCommandResult = { kind: "refuse"; message: string } | { kind: "prompt"; text: string };

interface ParsedArgs {
	/** `--reviewer` value, or null when not supplied. */
	reviewer: string | null;
	/** Remaining free text (known flags removed): a PR title/description hint for the model. */
	hint: string;
}

/**
 * Parse the optional `--reviewer <name>` passthrough out of `args` (the same
 * token-split style `/commit` uses for `--allow-secrets`), returning the reviewer
 * and the remaining free text as a PR title/description hint. `--allow-secrets`
 * is recognized (so it reaches the commit preconditions) but kept out of the hint.
 */
function parseArgs(args: string): ParsedArgs {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	let reviewer: string | null = null;
	const rest: string[] = [];
	for (let i = 0; i < tokens.length; i++) {
		if (tokens[i] === REVIEWER_FLAG) {
			const next = tokens[i + 1];
			if (next !== undefined) {
				reviewer = next;
				i++;
			}
			continue;
		}
		if (tokens[i] === ALLOW_SECRETS_FLAG) continue;
		rest.push(tokens[i]);
	}
	return { reviewer, hint: rest.join(" ") };
}

/**
 * `gh auth status` preflight, matching `handleShareCommand`'s two distinct messages
 * (not-installed vs not-authenticated). Returns a refusal or null (gh is usable).
 * ENOENT (gh missing) surfaces as `result.error`; a non-zero exit means logged out.
 */
function checkGhAvailable(cwd: string): { kind: "refuse"; message: string } | null {
	const result = spawnSync("gh", ["auth", "status"], { cwd, encoding: "utf-8", env: NON_INTERACTIVE_ENV });
	if (result.error) {
		return {
			kind: "refuse",
			message: "GitHub CLI (gh) is not installed. Install it from https://cli.github.com/",
		};
	}
	if (result.status !== 0) {
		return { kind: "refuse", message: "GitHub CLI is not logged in. Run 'gh auth login' first." };
	}
	return null;
}

/** An already-open PR whose head is `branch`, via a live `gh pr list` read, or null. */
function findExistingOpenPr(cwd: string, branch: string): { url: string; number: number } | null {
	const result = spawnSync("gh", ["pr", "list", "--head", branch, "--state", "open", "--json", "url,number"], {
		cwd,
		encoding: "utf-8",
		env: NON_INTERACTIVE_ENV,
	});
	if (result.status !== 0 || !result.stdout.trim()) return null;
	try {
		const parsed = JSON.parse(result.stdout) as Array<{ url: string; number: number }>;
		return Array.isArray(parsed) && parsed.length > 0 ? parsed[0] : null;
	} catch {
		return null;
	}
}

/**
 * Build the result for a submitted `/commit-push-pr [args]`.
 *
 * `args` may carry an optional `--reviewer <name>` (passed through to
 * `gh pr create`), an optional `--allow-secrets` (forwarded to the commit
 * preconditions), and any remaining free text used as a PR title/description hint.
 *
 * Refuse conditions (checked in this priority order):
 *   1. `gh` is not installed, or not authenticated (`gh auth status`).
 *   2. Any of `/commit`'s preconditions fail — transient git state, not a repo,
 *      unresolved conflicts, nothing to commit, or a likely secret in the diff
 *      (reused verbatim via `evaluateCommitPreconditions`, not re-derived here).
 *   3. On the default branch — opening a PR from the repo's default branch itself
 *      makes no sense (mirrors `/branch`'s current-vs-default comparison).
 *   4. An open PR already exists for the current branch (idempotency): surface its
 *      URL instead of proceeding.
 *
 * Otherwise composes a Git-Safety-Protocol-primed prompt instructing the model to
 * branch (if needed) → commit → `git push -u` → `gh pr create --title --body`
 * (never `--base`, no footer/Co-Authored-By), in that order.
 */
export async function buildCommitPushPrCommand(cwd: string, args: string): Promise<CommitPushPrCommandResult> {
	// Resolve to the main repository root so the `gh` reads run against the canonical
	// repo even when invoked from a linked worktree (e.g. a .paperclip/worktrees tree).
	const repoRoot = getMainRepoRoot(cwd) ?? cwd;

	const ghUnavailable = checkGhAvailable(repoRoot);
	if (ghUnavailable) return ghUnavailable;

	const preconditions: CommitPreconditions = await evaluateCommitPreconditions(cwd, args);
	if (preconditions.kind === "refuse") return preconditions;

	const [currentBranch, defaultBranch] = await Promise.all([getCurrentBranch(cwd), getDefaultBranch(cwd)]);

	if (currentBranch && defaultBranch && currentBranch === defaultBranch) {
		return {
			kind: "refuse",
			message: `Refusing to open a PR from the default branch (${defaultBranch}). Create a feature branch first (e.g. run /branch), then run /commit-push-pr again.`,
		};
	}

	if (currentBranch) {
		const existingPr = findExistingOpenPr(repoRoot, currentBranch);
		if (existingPr) {
			return {
				kind: "refuse",
				message: `An open pull request already exists for branch ${currentBranch}: ${existingPr.url} (#${existingPr.number}). Push new commits to update it rather than opening another.`,
			};
		}
	}

	const { reviewer, hint } = parseArgs(args);

	const sections = [
		buildGitSafetySection(),
		`Current branch: ${currentBranch ?? "(detached HEAD)"}`,
		`Default branch: ${defaultBranch ?? "(unknown)"}`,
		`Current status:\n${formatStatusSummary(preconditions.status)}`,
		preconditions.diffSection,
	];

	if (hint) {
		sections.push(`Suggested PR title/description from the user: ${hint}`);
	}

	const prCreateLine = reviewer
		? `4. Open the pull request with \`gh pr create\`, ALWAYS passing explicit \`--title\` and \`--body\` (gh prompts interactively otherwise, which breaks non-interactive execution) and \`--reviewer ${reviewer}\` to request a review. Do NOT pass a \`--base\` flag — let gh resolve the base branch itself. Do not add any "Generated with"/footer text or Co-Authored-By trailer to the PR.`
		: `4. Open the pull request with \`gh pr create\`, ALWAYS passing explicit \`--title\` and \`--body\` (gh prompts interactively otherwise, which breaks non-interactive execution). Do NOT pass a \`--base\` flag — let gh resolve the base branch itself. Do not add any "Generated with"/footer text or Co-Authored-By trailer to the PR.`;

	sections.push(
		[
			"The user has asked to commit the current changes, push the branch, and open a pull request. Do these steps in order, using your normal tool access (bash or the git tool) and following the safety protocol above:",
			"1. Make sure you are on a dedicated feature branch, not the default branch. If the current branch is unsuitable, create and switch to a new descriptively named branch first.",
			"2. Stage the relevant changes and create a commit with a clear, descriptive message (see the staged/unstaged guidance above). Do not add a Co-Authored-By trailer.",
			"3. Push the branch to the remote before touching the PR: `git push -u origin <branch>`. Always push first — `gh pr create` on a not-fully-pushed branch falls back to an interactive prompt and will hang.",
			prCreateLine,
		].join("\n"),
	);

	return { kind: "prompt", text: sections.join("\n\n") };
}
