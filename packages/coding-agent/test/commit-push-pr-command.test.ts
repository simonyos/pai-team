/**
 * Tests for the Wave 2.2 slice G5 `/commit-push-pr` core logic
 * (core/git/commit-push-pr-command.ts).
 *
 * Uses real temp git repositories (matching test/commit-command.test.ts) so the
 * git-state refusal checks run against genuine state. Only the two `gh` reads
 * (`gh auth status`, `gh pr list`) are intercepted — a selective `spawnSync` mock
 * that answers `gh` from a per-test fixture and delegates every other command
 * (git, `git worktree list`) to the real binary.
 */

import type { SpawnSyncReturns } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

type GhResult = Partial<SpawnSyncReturns<string>> & { error?: Error };

const ghFixture = vi.hoisted(() => ({
	auth: { status: 0, stdout: "", stderr: "" } as GhResult,
	prList: { status: 0, stdout: "[]", stderr: "" } as GhResult,
}));

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return {
		...actual,
		spawnSync: (command: string, args: readonly string[], options: unknown) => {
			if (command === "gh") {
				const result = args[0] === "auth" ? ghFixture.auth : ghFixture.prList;
				return { status: 0, stdout: "", stderr: "", signal: null, output: [], pid: 0, ...result };
			}
			return (actual.spawnSync as (...a: unknown[]) => unknown)(command, args, options);
		},
	};
});

const { buildCommitPushPrCommand } = await import("../src/core/git/commit-push-pr-command.ts");
const { spawnSync } = await import("node:child_process");

function git(args: string[], cwd: string): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf-8" });
	if (result.status !== 0) {
		throw new Error(`git ${args.join(" ")} failed:\n${result.stderr}`);
	}
	return result.stdout.trim();
}

const createdDirs: string[] = [];

function makeRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "commit-push-pr-"));
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

/** A repo sitting on a feature branch with a staged change (commit preconditions ready). */
function makeFeatureRepoWithChange(): string {
	const dir = makeRepo();
	commit(dir, "a.txt", "1\n", "init");
	git(["checkout", "-b", "feature/thing"], dir);
	writeFileSync(join(dir, "a.txt"), "2\n");
	git(["add", "a.txt"], dir);
	return dir;
}

afterEach(() => {
	ghFixture.auth = { status: 0, stdout: "", stderr: "" };
	ghFixture.prList = { status: 0, stdout: "[]", stderr: "" };
	vi.clearAllMocks();
	while (createdDirs.length > 0) {
		const dir = createdDirs.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

describe("buildCommitPushPrCommand", () => {
	it("refuses when gh is not installed", async () => {
		ghFixture.auth = { error: Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" }) };
		const dir = makeFeatureRepoWithChange();

		const result = await buildCommitPushPrCommand(dir, "");
		expect(result.kind).toBe("refuse");
		if (result.kind === "refuse") {
			expect(result.message).toContain("not installed");
			expect(result.message).toContain("cli.github.com");
		}
	});

	it("refuses when gh is not authenticated", async () => {
		ghFixture.auth = { status: 1, stdout: "", stderr: "not logged in" };
		const dir = makeFeatureRepoWithChange();

		const result = await buildCommitPushPrCommand(dir, "");
		expect(result.kind).toBe("refuse");
		if (result.kind === "refuse") {
			expect(result.message).toContain("not logged in");
			expect(result.message).toContain("gh auth login");
		}
	});

	it("refuses on an in-progress merge (reused /commit transient-state logic)", async () => {
		const dir = makeRepo();
		commit(dir, "a.txt", "base\n", "base");
		git(["checkout", "-b", "other"], dir);
		commit(dir, "a.txt", "other\n", "other change");
		git(["checkout", "main"], dir);
		commit(dir, "a.txt", "main\n", "main change");
		spawnSync("git", ["merge", "other"], { cwd: dir, encoding: "utf-8" });

		const result = await buildCommitPushPrCommand(dir, "");
		expect(result.kind).toBe("refuse");
		if (result.kind === "refuse") {
			expect(result.message.toLowerCase()).toContain("merge");
			expect(result.message.toLowerCase()).toContain("in progress");
		}
	});

	it("refuses on unresolved conflicts (reused /commit logic)", async () => {
		const dir = makeRepo();
		commit(dir, "a.txt", "base\n", "base");
		writeFileSync(join(dir, "a.txt"), "stashed-change\n");
		git(["stash", "push"], dir);
		writeFileSync(join(dir, "a.txt"), "conflicting-change\n");
		git(["add", "a.txt"], dir);
		git(["commit", "-m", "conflicting change"], dir);
		spawnSync("git", ["stash", "pop"], { cwd: dir, encoding: "utf-8" });

		const result = await buildCommitPushPrCommand(dir, "");
		expect(result.kind).toBe("refuse");
		if (result.kind === "refuse") {
			expect(result.message.toLowerCase()).toContain("conflict");
		}
	});

	it("refuses when there is nothing to commit (reused /commit logic)", async () => {
		const dir = makeRepo();
		commit(dir, "a.txt", "1\n", "init");
		git(["checkout", "-b", "feature/thing"], dir);

		const result = await buildCommitPushPrCommand(dir, "");
		expect(result.kind).toBe("refuse");
		if (result.kind === "refuse") {
			expect(result.message.toLowerCase()).toContain("nothing to commit");
		}
	});

	it("refuses on a likely secret in the staged diff (reused /commit logic)", async () => {
		const dir = makeRepo();
		commit(dir, "a.txt", "1\n", "init");
		git(["checkout", "-b", "feature/thing"], dir);
		writeFileSync(join(dir, "keys.txt"), "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY\n");
		git(["add", "keys.txt"], dir);

		const result = await buildCommitPushPrCommand(dir, "");
		expect(result.kind).toBe("refuse");
		if (result.kind === "refuse") {
			expect(result.message.toLowerCase()).toContain("secret");
			expect(result.message).toContain("--allow-secrets");
		}
	});

	it("refuses when sitting on the default branch", async () => {
		const dir = makeRepo();
		commit(dir, "a.txt", "1\n", "init");
		writeFileSync(join(dir, "a.txt"), "2\n");
		git(["add", "a.txt"], dir);

		const result = await buildCommitPushPrCommand(dir, "");
		expect(result.kind).toBe("refuse");
		if (result.kind === "refuse") {
			expect(result.message.toLowerCase()).toContain("default branch");
			expect(result.message).toContain("main");
		}
	});

	it("refuses (idempotently) when an open PR already exists for the branch", async () => {
		ghFixture.prList = {
			status: 0,
			stdout: JSON.stringify([{ url: "https://github.com/o/r/pull/7", number: 7 }]),
			stderr: "",
		};
		const dir = makeFeatureRepoWithChange();

		const result = await buildCommitPushPrCommand(dir, "");
		expect(result.kind).toBe("refuse");
		if (result.kind === "refuse") {
			expect(result.message).toContain("https://github.com/o/r/pull/7");
			expect(result.message).toContain("#7");
		}
	});

	it("composes a safety-protocol-primed prompt with the required PR-create guidance when not refused", async () => {
		const dir = makeFeatureRepoWithChange();

		const result = await buildCommitPushPrCommand(dir, "");
		expect(result.kind).toBe("prompt");
		if (result.kind === "prompt") {
			expect(result.text).toContain("<git_safety_protocol>");
			expect(result.text).toContain("</git_safety_protocol>");
			expect(result.text).toContain("Current branch: feature/thing");
			expect(result.text).toContain("Default branch: main");
			// Explicit --title / --body requirement.
			expect(result.text).toContain("--title");
			expect(result.text).toContain("--body");
			// No --base: the instruction must tell the model NOT to pass it.
			expect(result.text).toMatch(/do not pass a `--base`/i);
			// Push must be ordered before gh pr create.
			const pushIdx = result.text.indexOf("git push -u origin");
			const prIdx = result.text.indexOf("gh pr create");
			expect(pushIdx).toBeGreaterThanOrEqual(0);
			expect(prIdx).toBeGreaterThan(pushIdx);
			// The prompt must instruct the model NOT to add attribution/footer (D5/D7).
			expect(result.text).toMatch(/do not add.*co-authored-by/i);
			expect(result.text).toMatch(/do not add any "generated with"/i);
		}
	});

	it("passes --reviewer through and uses the remaining free text as a PR title/description hint", async () => {
		const dir = makeFeatureRepoWithChange();

		const result = await buildCommitPushPrCommand(dir, "--reviewer alice --allow-secrets Fix the login bug");
		expect(result.kind).toBe("prompt");
		if (result.kind === "prompt") {
			expect(result.text).toContain("--reviewer alice");
			expect(result.text).toContain("Fix the login bug");
			// Known flags are stripped from the hint text.
			expect(result.text).not.toContain("--allow-secrets");
		}
	});

	it("does not mention --reviewer when the user did not supply one", async () => {
		const dir = makeFeatureRepoWithChange();

		const result = await buildCommitPushPrCommand(dir, "");
		expect(result.kind).toBe("prompt");
		if (result.kind === "prompt") {
			expect(result.text).not.toContain("--reviewer");
		}
	});
});
