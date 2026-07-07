/**
 * Git metadata path + branch discovery (Wave 2.2, slice G1).
 *
 * Extracted verbatim from `footer-data-provider.ts` (previously module-private) so
 * the git-helpers module and the footer share one worktree-correct implementation
 * instead of two. Behaviour is unchanged — the footer now imports these.
 */

import { type ExecFileException, execFile, spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface GitPaths {
	repoDir: string;
	commonGitDir: string;
	headPath: string;
}

/**
 * Find git metadata paths by walking up from cwd.
 * Handles both regular git repos (.git is a directory) and worktrees (.git is a file).
 */
export function findGitPaths(cwd: string): GitPaths | null {
	let dir = cwd;
	while (true) {
		const gitPath = join(dir, ".git");
		if (existsSync(gitPath)) {
			try {
				const stat = statSync(gitPath);
				if (stat.isFile()) {
					const content = readFileSync(gitPath, "utf8").trim();
					if (content.startsWith("gitdir: ")) {
						const gitDir = resolve(dir, content.slice(8).trim());
						const headPath = join(gitDir, "HEAD");
						if (!existsSync(headPath)) return null;
						const commonDirPath = join(gitDir, "commondir");
						const commonGitDir = existsSync(commonDirPath)
							? resolve(gitDir, readFileSync(commonDirPath, "utf8").trim())
							: gitDir;
						return { repoDir: dir, commonGitDir, headPath };
					}
				} else if (stat.isDirectory()) {
					const headPath = join(gitPath, "HEAD");
					if (!existsSync(headPath)) return null;
					return { repoDir: dir, commonGitDir: gitPath, headPath };
				}
			} catch {
				return null;
			}
		}
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

/**
 * Root working-tree directory of the MAIN repository for `cwd`.
 *
 * For a plain repo this equals the repo root. For a linked worktree (`.git` is a
 * file pointing at `<main>/.git/worktrees/<name>`), `findGitPaths` resolves the
 * shared `commonGitDir` (`<main>/.git`) — so the main repo's working-tree root is
 * its parent. This repo's own `.paperclip/worktrees/...` trees are exactly this
 * shape. `git worktree list --porcelain` (read-only; its first `worktree <path>`
 * line is authoritatively the main working tree) is the fallback for non-standard
 * layouts where the git dir lives outside the repo (e.g. `--separate-git-dir`),
 * where `dirname(commonGitDir)` is not the working tree.
 *
 * Returns null when `cwd` is not inside a git repository.
 */
export function getMainRepoRoot(cwd: string): string | null {
	const paths = findGitPaths(cwd);
	if (!paths) return null;
	const candidate = dirname(paths.commonGitDir);
	// Standard layout: the main working tree contains the `.git` entry (a directory
	// for a plain repo, a file for the primary tree of a worktree set). When it does
	// not, the git dir is detached from the working tree — ask git directly.
	if (existsSync(join(candidate, ".git"))) return candidate;
	return mainWorktreeFromGit(cwd) ?? candidate;
}

/** First `worktree <path>` line from `git worktree list --porcelain` — the main working tree — or null. */
function mainWorktreeFromGit(cwd: string): string | null {
	const result = spawnSync("git", ["--no-optional-locks", "worktree", "list", "--porcelain"], {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	});
	if (result.status !== 0) return null;
	for (const line of result.stdout.split("\n")) {
		if (line.startsWith("worktree ")) {
			const path = line.slice("worktree ".length).trim();
			if (path) return path;
		}
	}
	return null;
}

/** Ask git for the current branch. Returns null on detached HEAD or if git is unavailable. */
export function resolveBranchWithGitSync(repoDir: string): string | null {
	const result = spawnSync("git", ["--no-optional-locks", "symbolic-ref", "--quiet", "--short", "HEAD"], {
		cwd: repoDir,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	});
	const branch = result.status === 0 ? result.stdout.trim() : "";
	return branch || null;
}

/** Ask git for the current branch asynchronously. Returns null on detached HEAD or if git is unavailable. */
export function resolveBranchWithGitAsync(repoDir: string): Promise<string | null> {
	return new Promise((resolvePromise) => {
		execFile(
			"git",
			["--no-optional-locks", "symbolic-ref", "--quiet", "--short", "HEAD"],
			{
				cwd: repoDir,
				encoding: "utf8",
			},
			(error: ExecFileException | null, stdout: string) => {
				if (error) {
					resolvePromise(null);
					return;
				}
				const branch = stdout.trim();
				resolvePromise(branch || null);
			},
		);
	});
}
