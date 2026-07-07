/**
 * Tests for the Wave 2.2 slice G4 `/commit` core logic (core/git/commit-command.ts).
 *
 * Uses real temp git repositories (matching test/git-helpers.test.ts conventions) so
 * the refusal checks run against genuine git state rather than mocks.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildCommitCommand } from "../src/core/git/commit-command.ts";

function git(args: string[], cwd: string): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf-8" });
	if (result.status !== 0) {
		throw new Error(`git ${args.join(" ")} failed:\n${result.stderr}`);
	}
	return result.stdout.trim();
}

const createdDirs: string[] = [];

function makeRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "commit-command-"));
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

describe("buildCommitCommand", () => {
	it("refuses when not inside a git repository", async () => {
		const dir = mkdtempSync(join(tmpdir(), "commit-command-noroot-"));
		createdDirs.push(dir);
		const result = await buildCommitCommand(dir, "");
		expect(result.kind).toBe("refuse");
		if (result.kind === "refuse") {
			expect(result.message).toContain("git repository");
		}
	});

	it("refuses on an in-progress merge (transient state)", async () => {
		const dir = makeRepo();
		commit(dir, "a.txt", "base\n", "base");
		git(["checkout", "-b", "other"], dir);
		commit(dir, "a.txt", "other\n", "other change");
		git(["checkout", "main"], dir);
		commit(dir, "a.txt", "main\n", "main change");
		// Force a conflicting merge that stops mid-way, leaving MERGE_HEAD.
		spawnSync("git", ["merge", "other"], { cwd: dir, encoding: "utf-8" });

		const result = await buildCommitCommand(dir, "");
		expect(result.kind).toBe("refuse");
		if (result.kind === "refuse") {
			expect(result.message.toLowerCase()).toContain("merge");
			expect(result.message.toLowerCase()).toContain("in progress");
		}
	});

	it("refuses when there is nothing to commit", async () => {
		const dir = makeRepo();
		commit(dir, "a.txt", "1\n", "init");

		const result = await buildCommitCommand(dir, "");
		expect(result.kind).toBe("refuse");
		if (result.kind === "refuse") {
			expect(result.message.toLowerCase()).toContain("nothing to commit");
		}
	});

	it("does NOT refuse as clean when there is only a new untracked file", async () => {
		const dir = makeRepo();
		commit(dir, "a.txt", "1\n", "init");
		writeFileSync(join(dir, "newfile.txt"), "brand new\n");

		const result = await buildCommitCommand(dir, "");
		expect(result.kind).toBe("prompt");
		if (result.kind === "prompt") {
			expect(result.text).toContain("newfile.txt");
			expect(result.text.toLowerCase()).toContain("untracked");
		}
	});

	it("refuses on unresolved conflict markers left by a stash-pop conflict (no MERGE_HEAD)", async () => {
		const dir = makeRepo();
		commit(dir, "a.txt", "base\n", "base");
		writeFileSync(join(dir, "a.txt"), "stashed-change\n");
		git(["stash", "push"], dir);
		writeFileSync(join(dir, "a.txt"), "conflicting-change\n");
		git(["add", "a.txt"], dir);
		git(["commit", "-m", "conflicting change"], dir);
		// This conflicts and leaves an AUTO_MERGE file (not MERGE_HEAD) with UU status.
		spawnSync("git", ["stash", "pop"], { cwd: dir, encoding: "utf-8" });

		const result = await buildCommitCommand(dir, "");
		expect(result.kind).toBe("refuse");
		if (result.kind === "refuse") {
			expect(result.message.toLowerCase()).toContain("conflict");
			expect(result.message).toContain("a.txt");
		}
	});

	it("refuses on a likely secret in the staged diff", async () => {
		const dir = makeRepo();
		commit(dir, "a.txt", "1\n", "init");
		writeFileSync(join(dir, "keys.txt"), "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY\n");
		git(["add", "keys.txt"], dir);

		const result = await buildCommitCommand(dir, "");
		expect(result.kind).toBe("refuse");
		if (result.kind === "refuse") {
			expect(result.message.toLowerCase()).toContain("secret");
			expect(result.message).toContain("--allow-secrets");
		}
	});

	it("an explicit --allow-secrets argument overrides the secret refusal", async () => {
		const dir = makeRepo();
		commit(dir, "a.txt", "1\n", "init");
		writeFileSync(join(dir, "keys.txt"), "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY\n");
		git(["add", "keys.txt"], dir);

		const result = await buildCommitCommand(dir, "--allow-secrets");
		// The override bypasses the refusal, but the composed prompt still uses the
		// default-redacted diff (secrets are never included in cleartext in the prompt).
		expect(result.kind).toBe("prompt");
		if (result.kind === "prompt") {
			expect(result.text).toContain("keys.txt");
			expect(result.text).toContain("[REDACTED]");
			expect(result.text).not.toContain("wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY");
		}
	});

	it("refuses on a likely secret in the unstaged diff when nothing is staged", async () => {
		const dir = makeRepo();
		commit(dir, "keys.txt", "placeholder\n", "init");
		writeFileSync(join(dir, "keys.txt"), "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY\n");

		const result = await buildCommitCommand(dir, "");
		expect(result.kind).toBe("refuse");
		if (result.kind === "refuse") {
			expect(result.message.toLowerCase()).toContain("secret");
			expect(result.message).toContain("--allow-secrets");
		}
	});

	it("an explicit --allow-secrets argument overrides the unstaged secret refusal", async () => {
		const dir = makeRepo();
		commit(dir, "keys.txt", "placeholder\n", "init");
		writeFileSync(join(dir, "keys.txt"), "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY\n");

		const result = await buildCommitCommand(dir, "--allow-secrets");
		expect(result.kind).toBe("prompt");
		if (result.kind === "prompt") {
			expect(result.text).toContain("keys.txt");
			expect(result.text).toContain("[REDACTED]");
			expect(result.text).not.toContain("wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY");
		}
	});

	it("composes a safety-protocol-primed prompt with the real staged diff when not refused", async () => {
		const dir = makeRepo();
		commit(dir, "a.txt", "1\n", "init");
		writeFileSync(join(dir, "a.txt"), "2\n");
		git(["add", "a.txt"], dir);

		const result = await buildCommitCommand(dir, "");
		expect(result.kind).toBe("prompt");
		if (result.kind === "prompt") {
			expect(result.text).toContain("<git_safety_protocol>");
			expect(result.text).toContain("</git_safety_protocol>");
			expect(result.text).toContain("Current branch: main");
			expect(result.text).toContain("+2");
			expect(result.text).toContain("a.txt");
		}
	});

	it("uses the unstaged diff (with a stage-first instruction) when nothing is staged", async () => {
		const dir = makeRepo();
		commit(dir, "a.txt", "1\n", "init");
		writeFileSync(join(dir, "a.txt"), "unstaged change\n");

		const result = await buildCommitCommand(dir, "");
		expect(result.kind).toBe("prompt");
		if (result.kind === "prompt") {
			expect(result.text).toContain("<git_safety_protocol>");
			expect(result.text.toLowerCase()).toContain("stage");
			expect(result.text).toContain("unstaged change");
		}
	});
});
