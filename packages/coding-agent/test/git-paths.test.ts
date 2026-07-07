/**
 * Tests for core/git/paths.ts, specifically the Wave 2.2 slice G5 `getMainRepoRoot`
 * helper: resolving a linked worktree back to the main repository's working-tree
 * root. Uses real temp git repositories (matching test/commit-command.test.ts).
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getMainRepoRoot } from "../src/core/git/paths.ts";

function git(args: string[], cwd: string): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf-8" });
	if (result.status !== 0) {
		throw new Error(`git ${args.join(" ")} failed:\n${result.stderr}`);
	}
	return result.stdout.trim();
}

const createdDirs: string[] = [];

function makeRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "git-paths-"));
	createdDirs.push(dir);
	git(["init", "--initial-branch=main"], dir);
	git(["config", "user.email", "test@test.com"], dir);
	git(["config", "user.name", "Test"], dir);
	git(["config", "commit.gpgsign", "false"], dir);
	writeFileSync(join(dir, "a.txt"), "1\n");
	git(["add", "a.txt"], dir);
	git(["commit", "-m", "init"], dir);
	return dir;
}

afterEach(() => {
	while (createdDirs.length > 0) {
		const dir = createdDirs.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

describe("getMainRepoRoot", () => {
	it("returns null when not inside a git repository", () => {
		const dir = mkdtempSync(join(tmpdir(), "git-paths-noroot-"));
		createdDirs.push(dir);
		expect(getMainRepoRoot(dir)).toBeNull();
	});

	it("returns the repo root itself for a plain (non-worktree) repository", () => {
		const dir = makeRepo();
		expect(getMainRepoRoot(dir)).toBe(dir);
	});

	it("resolves the main repo root from a linked worktree", () => {
		const main = makeRepo();
		const worktree = `${main}-wt`;
		createdDirs.push(worktree);
		git(["worktree", "add", worktree], main);

		const result = getMainRepoRoot(worktree);
		expect(result).not.toBeNull();
		// git may store the realpath of the main repo in the worktree's commondir.
		expect(result && realpathSync(result)).toBe(realpathSync(main));
	});
});
