/**
 * Tests for the Wave 2.2 slice G1 git-helpers read module.
 *
 * Uses real temp git repositories (matching test/git-update.test.ts conventions) to
 * exercise path/worktree discovery, porcelain parsing, the read-only assertion, the
 * supply-chain hardening rails, validation, the secret guard, and the footer refactor.
 */

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FooterDataProvider } from "../src/core/footer-data-provider.ts";
import {
	GIT_READ_HARDENING,
	getCurrentBranch,
	getDefaultBranch,
	getDiff,
	getGitRoot,
	getHeadSha,
	getRecentCommits,
	getRemoteUrl,
	getStagedFiles,
	getStatus,
	hasUnpushedCommits,
	isTransientState,
	runGitRead,
} from "../src/core/git/git-helpers.ts";
import { findGitPaths } from "../src/core/git/paths.ts";
import { diffContainsLikelySecret } from "../src/core/git/secret-guard.ts";
import { isSafeRefName, isValidGitSha } from "../src/core/git/validate.ts";

function git(args: string[], cwd: string): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf-8" });
	if (result.status !== 0) {
		throw new Error(`git ${args.join(" ")} failed:\n${result.stderr}`);
	}
	return result.stdout.trim();
}

const createdDirs: string[] = [];

function makeRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "git-helpers-"));
	createdDirs.push(dir);
	git(["init", "--initial-branch=main"], dir);
	git(["config", "user.email", "test@test.com"], dir);
	git(["config", "user.name", "Test"], dir);
	git(["config", "commit.gpgsign", "false"], dir);
	return dir;
}

function commit(dir: string, file: string, content: string, message: string): void {
	writeFileSync(join(dir, file), content);
	git(["add", file], dir);
	git(["commit", "-m", message], dir);
}

afterEach(() => {
	while (createdDirs.length > 0) {
		const dir = createdDirs.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

describe("findGitPaths", () => {
	it("resolves a normal .git directory", () => {
		const dir = makeRepo();
		const paths = findGitPaths(dir);
		expect(paths).not.toBeNull();
		expect(paths?.repoDir).toBe(dir);
		expect(paths?.commonGitDir).toBe(join(dir, ".git"));
	});

	it("resolves a linked worktree via the .git-file gitdir pointer", () => {
		const dir = makeRepo();
		commit(dir, "a.txt", "1", "init");
		const wt = mkdtempSync(join(tmpdir(), "git-helpers-wt-"));
		createdDirs.push(wt);
		rmSync(wt, { recursive: true, force: true }); // git worktree add wants a non-existent path
		git(["worktree", "add", "-b", "feature", wt], dir);
		const paths = findGitPaths(wt);
		expect(paths).not.toBeNull();
		expect(paths?.repoDir).toBe(wt);
		// commonGitDir points back into the MAIN repo's .git, not the worktree's private dir.
		// Compare via realpath: git canonicalizes commondir (macOS /var -> /private/var).
		expect(realpathSync(paths?.commonGitDir as string)).toBe(realpathSync(join(dir, ".git")));
	});

	it("returns null outside a repo", () => {
		const dir = mkdtempSync(join(tmpdir(), "git-helpers-none-"));
		createdDirs.push(dir);
		expect(findGitPaths(dir)).toBeNull();
	});
});

describe("read helpers", () => {
	it("getGitRoot / getCurrentBranch / getHeadSha on a fresh repo", async () => {
		const dir = makeRepo();
		commit(dir, "a.txt", "1", "init");
		expect(await getGitRoot(dir)).toBe(dir);
		expect(await getCurrentBranch(dir)).toBe("main");
		const sha = await getHeadSha(dir);
		expect(sha).not.toBeNull();
		expect(isValidGitSha(sha as string)).toBe(true);
	});

	it("getHeadSha is null on an empty repo", async () => {
		const dir = makeRepo();
		expect(await getHeadSha(dir)).toBeNull();
	});

	it("getStatus reports staged / unstaged / untracked / clean", async () => {
		const dir = makeRepo();
		commit(dir, "tracked.txt", "one\n", "init");
		expect((await getStatus(dir))?.isClean).toBe(true);

		writeFileSync(join(dir, "tracked.txt"), "two\n"); // modify, then stage the modification
		git(["add", "tracked.txt"], dir);
		writeFileSync(join(dir, "new.txt"), "new\n"); // untracked
		writeFileSync(join(dir, "added.txt"), "x\n"); // brand-new, staged
		git(["add", "added.txt"], dir);

		const status = await getStatus(dir);
		expect(status).not.toBeNull();
		expect(status?.branch).toBe("main");
		expect(status?.isClean).toBe(false);
		const stagedPaths = status?.staged.map((e) => e.path) ?? [];
		expect(stagedPaths).toContain("added.txt");
		expect(stagedPaths).toContain("tracked.txt");
		expect(status?.untracked).toContain("new.txt");
		expect(status?.conflicted).toEqual([]);
	});

	it("round-trips filenames with spaces and non-ASCII via NUL framing", async () => {
		const dir = makeRepo();
		commit(dir, "seed.txt", "1", "init");
		writeFileSync(join(dir, "space file.txt"), "u\n"); // untracked, contains a space
		writeFileSync(join(dir, "café.txt"), "s\n"); // staged, non-ASCII
		git(["add", "café.txt"], dir);
		const status = await getStatus(dir);
		expect(status?.untracked).toContain("space file.txt");
		expect(status?.staged.map((e) => e.path)).toContain("café.txt");
		expect(await getStagedFiles(dir)).toContain("café.txt");
	});

	it("routes merge-conflict entries to conflicted, not staged/unstaged", async () => {
		const dir = makeRepo();
		commit(dir, "a.txt", "base\n", "base");
		git(["checkout", "-b", "other"], dir);
		commit(dir, "a.txt", "other side\n", "other change");
		git(["checkout", "main"], dir);
		commit(dir, "a.txt", "main side\n", "main change");
		spawnSync("git", ["merge", "other"], { cwd: dir, encoding: "utf-8" }); // conflicts on a.txt
		const status = await getStatus(dir);
		expect(status?.conflicted.map((e) => e.path)).toContain("a.txt");
		expect(status?.staged.map((e) => e.path)).not.toContain("a.txt");
		expect(status?.unstaged.map((e) => e.path)).not.toContain("a.txt");
		expect(status?.isClean).toBe(false);
	});

	it("getStagedFiles lists only staged paths", async () => {
		const dir = makeRepo();
		commit(dir, "a.txt", "1", "init");
		writeFileSync(join(dir, "b.txt"), "staged\n");
		git(["add", "b.txt"], dir);
		writeFileSync(join(dir, "c.txt"), "untracked\n"); // not staged
		const staged = await getStagedFiles(dir);
		expect(staged).toEqual(["b.txt"]);
	});

	it("getStatus parses renames to the new path", async () => {
		const dir = makeRepo();
		commit(dir, "old.txt", "content that is long enough to be detected as a rename\n", "init");
		git(["mv", "old.txt", "new.txt"], dir);
		const status = await getStatus(dir);
		const stagedPaths = status?.staged.map((e) => e.path) ?? [];
		expect(stagedPaths).toContain("new.txt");
		expect(stagedPaths).not.toContain("old.txt -> new.txt");
	});

	it("getRecentCommits returns newest-first with full subjects", async () => {
		const dir = makeRepo();
		commit(dir, "a.txt", "1", "first commit");
		commit(dir, "b.txt", "2", "second commit with spaces");
		const commits = await getRecentCommits(dir, 5);
		expect(commits.length).toBe(2);
		expect(commits[0].subject).toBe("second commit with spaces");
		expect(commits[1].subject).toBe("first commit");
		expect(isValidGitSha(commits[0].sha)).toBe(true);
	});

	it("getRecentCommits is empty on a repo with no commits", async () => {
		const dir = makeRepo();
		expect(await getRecentCommits(dir, 5)).toEqual([]);
	});

	it("isTransientState detects an in-progress merge", async () => {
		const dir = makeRepo();
		commit(dir, "a.txt", "base\n", "base");
		git(["checkout", "-b", "other"], dir);
		commit(dir, "a.txt", "other\n", "other change");
		git(["checkout", "main"], dir);
		commit(dir, "a.txt", "main\n", "main change");
		expect(await isTransientState(dir)).toBe(false);
		// Force a conflicting merge that stops mid-way, leaving MERGE_HEAD.
		spawnSync("git", ["merge", "other"], { cwd: dir, encoding: "utf-8" });
		expect(await isTransientState(dir)).toBe(true);
	});
});

describe("remote-aware helpers", () => {
	function makeRepoWithRemote(): { work: string; bare: string } {
		const bare = mkdtempSync(join(tmpdir(), "git-helpers-bare-"));
		createdDirs.push(bare);
		git(["init", "--bare", "--initial-branch=main"], bare);
		const work = makeRepo();
		commit(work, "a.txt", "1", "init");
		git(["remote", "add", "origin", bare], work);
		git(["push", "-u", "origin", "main"], work);
		return { work, bare };
	}

	it("getRemoteUrl returns the origin url", async () => {
		const { work, bare } = makeRepoWithRemote();
		expect(await getRemoteUrl(work)).toBe(bare);
		expect(await getRemoteUrl(work, "nope")).toBeNull();
	});

	it("getDefaultBranch prefers origin/HEAD, falls back to local main", async () => {
		const { work } = makeRepoWithRemote();
		// origin/HEAD not set by push -> falls back to existing local main
		expect(await getDefaultBranch(work)).toBe("main");
		// Now set the symref explicitly and confirm it is honored.
		git(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], work);
		expect(await getDefaultBranch(work)).toBe("main");
	});

	it("hasUnpushedCommits reflects commits ahead of upstream", async () => {
		const { work } = makeRepoWithRemote();
		expect(await hasUnpushedCommits(work)).toBe(false);
		commit(work, "b.txt", "2", "ahead by one");
		expect(await hasUnpushedCommits(work)).toBe(true);
		const status = await getStatus(work);
		expect(status?.ahead).toBe(1);
	});
});

describe("runGitRead read-only assertion (no mutation path)", () => {
	it("throws on mutating subcommands", async () => {
		const dir = makeRepo();
		commit(dir, "a.txt", "1", "init");
		await expect(runGitRead(["commit", "-m", "x"], dir)).rejects.toThrow(/non-read-only/);
		await expect(runGitRead(["push"], dir)).rejects.toThrow(/non-read-only/);
		await expect(runGitRead(["reset", "--hard"], dir)).rejects.toThrow(/non-read-only/);
		await expect(runGitRead(["checkout", "main"], dir)).rejects.toThrow(/non-read-only/);
	});

	it("allows read-only subcommands including nuanced config --get", async () => {
		const dir = makeRepo();
		commit(dir, "a.txt", "1", "init");
		await expect(runGitRead(["status", "--porcelain"], dir)).resolves.toBeDefined();
		await expect(runGitRead(["config", "--get", "user.name"], dir)).resolves.toBeDefined();
		await expect(runGitRead(["rev-parse", "HEAD"], dir)).resolves.toBeDefined();
	});

	it("classifies look-read-but-write verbs by form (stash/tag/symbolic-ref/reflog)", async () => {
		const dir = makeRepo();
		commit(dir, "a.txt", "1", "init");
		// Mutating forms are refused...
		await expect(runGitRead(["stash"], dir)).rejects.toThrow(/non-read-only/);
		await expect(runGitRead(["tag", "v1"], dir)).rejects.toThrow(/non-read-only/);
		await expect(runGitRead(["symbolic-ref", "HEAD", "refs/heads/x"], dir)).rejects.toThrow(/non-read-only/);
		await expect(runGitRead(["reflog", "expire", "--all"], dir)).rejects.toThrow(/non-read-only/);
		// ...read forms are allowed.
		await expect(runGitRead(["stash", "list"], dir)).resolves.toBeDefined();
		await expect(runGitRead(["tag"], dir)).resolves.toBeDefined();
		await expect(runGitRead(["symbolic-ref", "--short", "HEAD"], dir)).resolves.toBeDefined();
		await expect(runGitRead(["reflog", "show"], dir)).resolves.toBeDefined();
	});

	it("rejects an empty-string argument", async () => {
		const dir = makeRepo();
		await expect(runGitRead(["status", ""], dir)).rejects.toThrow(/empty argument/);
	});
});

describe("supply-chain hardening", () => {
	it("does NOT execute a hostile core.fsmonitor during status/diff", async () => {
		const dir = makeRepo();
		commit(dir, "a.txt", "1", "init");
		const sentinel = join(dir, "fsmonitor-ran");
		const hook = join(dir, "evil-fsmonitor.sh");
		writeFileSync(hook, `#!/bin/sh\ntouch "${sentinel}"\nexit 0\n`);
		chmodSync(hook, 0o755);
		git(["config", "core.fsmonitor", hook], dir);

		// Baseline: a raw git status (no override) is expected to invoke fsmonitor.
		rmSync(sentinel, { force: true });
		spawnSync("git", ["status"], { cwd: dir, encoding: "utf-8" });
		const baselineRan = existsSync(sentinel);

		// Our hardened readers pass `-c core.fsmonitor=false` and must NOT invoke it.
		rmSync(sentinel, { force: true });
		await getStatus(dir);
		await getDiff(dir);
		expect(existsSync(sentinel)).toBe(false);

		// Sanity: the baseline actually triggered it, so the test above is meaningful.
		// (Guarded — some git builds ignore a protocol-incorrect fsmonitor.)
		if (!baselineRan) {
			console.warn("fsmonitor baseline did not run; hardening assertion is weaker on this git build");
		}
	});

	it("redacts secrets from captured stdout by default, raw only when asked", async () => {
		const dir = makeRepo();
		commit(dir, "a.txt", "1", "init");
		writeFileSync(join(dir, "keys.txt"), "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY\n");
		git(["add", "keys.txt"], dir);

		const redacted = await getDiff(dir, { staged: true });
		expect(redacted).toContain("[REDACTED]");
		expect(redacted).not.toContain("wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY");

		const raw = await getDiff(dir, { staged: true, redact: false });
		expect(raw).toContain("wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY");
	});
});

describe("documented return paths", () => {
	it("getGitRoot returns null outside a repo", async () => {
		const none = mkdtempSync(join(tmpdir(), "git-helpers-noroot-"));
		createdDirs.push(none);
		expect(await getGitRoot(none)).toBeNull();
	});

	it("getDefaultBranch returns null with no origin/HEAD and no main/master", async () => {
		const dir = makeRepo();
		commit(dir, "a.txt", "1", "init");
		git(["branch", "-m", "main", "topic"], dir); // no main/master, no remote
		expect(await getDefaultBranch(dir)).toBeNull();
	});

	it("getDiff base= diffs against a ref and rejects an unsafe base", async () => {
		const dir = makeRepo();
		commit(dir, "a.txt", "1\n", "first");
		const base = await getHeadSha(dir);
		commit(dir, "a.txt", "2\n", "second");
		const diff = await getDiff(dir, { base: base as string });
		expect(diff).toContain("+2");
		await expect(getDiff(dir, { base: "--upload-pack=evil" })).rejects.toThrow(/unsafe base/);
	});
});

describe("hardening rails (deterministic)", () => {
	it("prepends the three supply-chain rails in order", () => {
		expect([...GIT_READ_HARDENING]).toEqual([
			"--no-optional-locks",
			"-c",
			"core.hooksPath=/dev/null",
			"-c",
			"core.fsmonitor=false",
		]);
	});

	it("isTransientState detects an in-progress merge inside a linked worktree", async () => {
		const dir = makeRepo();
		commit(dir, "a.txt", "base\n", "base");
		const baseSha = await getHeadSha(dir);
		commit(dir, "a.txt", "main side\n", "main change");
		git(["branch", "other", baseSha as string], dir);
		const wt = mkdtempSync(join(tmpdir(), "git-helpers-wtx-"));
		createdDirs.push(wt);
		rmSync(wt, { recursive: true, force: true });
		git(["worktree", "add", wt, "other"], dir);
		writeFileSync(join(wt, "a.txt"), "other side\n");
		git(["commit", "-am", "other change"], wt);
		spawnSync("git", ["merge", "main"], { cwd: wt, encoding: "utf-8" }); // conflict -> MERGE_HEAD in wt gitdir
		expect(await isTransientState(wt)).toBe(true); // per-worktree gitdir (would miss with commonGitDir)
		expect(await isTransientState(dir)).toBe(false); // main worktree is not merging
	});
});

describe("validate", () => {
	it("isSafeRefName accepts normal refs and rejects injection/range forms", () => {
		for (const ok of ["main", "feature/git-helpers", "release-1.2.3", "v1.0", "user@host"]) {
			expect(isSafeRefName(ok)).toBe(true);
		}
		for (const bad of [
			"-x",
			"--upload-pack=x",
			"/leading",
			"trailing/",
			"a..b",
			"ref@{0}",
			"with space",
			"star*",
			"ends.lock",
			"",
		]) {
			expect(isSafeRefName(bad)).toBe(false);
		}
	});

	it("isValidGitSha accepts 40/64 hex, rejects abbreviations and junk", () => {
		expect(isValidGitSha("a".repeat(40))).toBe(true);
		expect(isValidGitSha("a".repeat(64))).toBe(true);
		expect(isValidGitSha("abc123")).toBe(false);
		expect(isValidGitSha("A".repeat(40))).toBe(false); // uppercase not produced by git
		expect(isValidGitSha("g".repeat(40))).toBe(false); // non-hex
	});
});

describe("diffContainsLikelySecret", () => {
	it("flags an added .env-style secret line", () => {
		const diff = [
			"diff --git a/.env b/.env",
			"+++ b/.env",
			"+AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY",
		].join("\n");
		expect(diffContainsLikelySecret(diff)).toBe(true);
	});

	it("ignores secrets on removed or context lines and the +++ header", () => {
		const removed = ["--- a/.env", "-AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY"].join("\n");
		expect(diffContainsLikelySecret(removed)).toBe(false);
		expect(diffContainsLikelySecret("")).toBe(false);
		expect(diffContainsLikelySecret("+just a normal code line\n+const x = 1;")).toBe(false);
	});
});

describe("footer-data-provider refactor regression", () => {
	it("still reports the current branch after extracting git-paths", () => {
		const dir = makeRepo();
		commit(dir, "a.txt", "1", "init");
		git(["checkout", "-b", "feature/x"], dir);
		const footer = new FooterDataProvider(dir);
		try {
			expect(footer.getGitBranch()).toBe("feature/x");
		} finally {
			footer.dispose();
		}
	});
});
