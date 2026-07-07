/**
 * Tests for the Wave 2.2 slice G4 `/branch` core logic (core/git/branch-command.ts).
 *
 * Uses real temp git repositories (matching test/git-helpers.test.ts conventions) so
 * the refusal checks run against genuine git state rather than mocks.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildBranchCommand } from "../src/core/git/branch-command.ts";

function git(args: string[], cwd: string): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf-8" });
	if (result.status !== 0) {
		throw new Error(`git ${args.join(" ")} failed:\n${result.stderr}`);
	}
	return result.stdout.trim();
}

const createdDirs: string[] = [];

function makeRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "branch-command-"));
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

describe("buildBranchCommand", () => {
	it("refuses when not inside a git repository", async () => {
		const dir = mkdtempSync(join(tmpdir(), "branch-command-noroot-"));
		createdDirs.push(dir);
		const result = await buildBranchCommand(dir, "fix the login bug");
		expect(result.kind).toBe("refuse");
		if (result.kind === "refuse") {
			expect(result.message).toContain("git repository");
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
		spawnSync("git", ["stash", "pop"], { cwd: dir, encoding: "utf-8" });

		const result = await buildBranchCommand(dir, "fix the conflict");
		expect(result.kind).toBe("refuse");
		if (result.kind === "refuse") {
			expect(result.message.toLowerCase()).toContain("conflict");
		}
	});

	it("refuses on an in-progress merge (transient state)", async () => {
		const dir = makeRepo();
		commit(dir, "a.txt", "base\n", "base");
		git(["checkout", "-b", "other"], dir);
		commit(dir, "a.txt", "other\n", "other change");
		git(["checkout", "main"], dir);
		commit(dir, "a.txt", "main\n", "main change");
		spawnSync("git", ["merge", "other"], { cwd: dir, encoding: "utf-8" });

		const result = await buildBranchCommand(dir, "fix the conflict");
		expect(result.kind).toBe("refuse");
		if (result.kind === "refuse") {
			expect(result.message.toLowerCase()).toContain("merge");
		}
	});

	it("refuses when args is empty", async () => {
		const dir = makeRepo();
		commit(dir, "a.txt", "1\n", "init");

		const result = await buildBranchCommand(dir, "");
		expect(result.kind).toBe("refuse");
		if (result.kind === "refuse") {
			expect(result.message).toContain("/branch");
		}
	});

	it("refuses when args is blank (whitespace only)", async () => {
		const dir = makeRepo();
		commit(dir, "a.txt", "1\n", "init");

		const result = await buildBranchCommand(dir, "   ");
		expect(result.kind).toBe("refuse");
	});

	it("composes a safety-protocol-primed prompt with the stated purpose when not refused", async () => {
		const dir = makeRepo();
		commit(dir, "a.txt", "1\n", "init");

		const result = await buildBranchCommand(dir, "fix the login bug");
		expect(result.kind).toBe("prompt");
		if (result.kind === "prompt") {
			expect(result.text).toContain("<git_safety_protocol>");
			expect(result.text).toContain("</git_safety_protocol>");
			expect(result.text).toContain("Current branch: main");
			expect(result.text).toContain("fix the login bug");
		}
	});

	it("includes the current status so the model knows about uncommitted changes", async () => {
		const dir = makeRepo();
		commit(dir, "a.txt", "1\n", "init");
		writeFileSync(join(dir, "a.txt"), "2\n");

		const result = await buildBranchCommand(dir, "refactor the parser");
		expect(result.kind).toBe("prompt");
		if (result.kind === "prompt") {
			expect(result.text).toContain("unstaged");
		}
	});
});
