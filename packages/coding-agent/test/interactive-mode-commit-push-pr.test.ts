import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommitPushPrCommandResult } from "../src/core/git/commit-push-pr-command.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

// Exercises the /commit-push-pr coded-command dispatch entry in interactive mode
// (Wave 2.2 slice G5), following the /commit + /branch dispatch test conventions
// (see interactive-mode-commit-branch.test.ts).

const mocks = vi.hoisted(() => ({
	buildCommitPushPrCommand: vi.fn<(cwd: string, args: string) => Promise<CommitPushPrCommandResult>>(),
}));

vi.mock("../src/core/git/commit-push-pr-command.ts", () => ({
	buildCommitPushPrCommand: mocks.buildCommitPushPrCommand,
}));

type CodedCommand = { match: (text: string) => boolean; run: (text: string) => void | Promise<void> };

type CodedCommandContext = {
	codedCommands?: CodedCommand[];
	editor: { setText: (text: string) => void };
	showStatus: (message: string) => void;
	session: { sendUserMessage: (text: string) => Promise<void> };
	sessionManager: { getCwd: () => string };
	buildCodedCommands: () => CodedCommand[];
	tryHandleCodedCommand: (text: string) => Promise<boolean>;
};

const prototype = InteractiveMode.prototype as unknown as CodedCommandContext;

function createContext(cwd = "/repo"): CodedCommandContext {
	return {
		editor: { setText: vi.fn() },
		showStatus: vi.fn(),
		session: { sendUserMessage: vi.fn(async () => {}) },
		sessionManager: { getCwd: () => cwd },
		buildCodedCommands: prototype.buildCodedCommands,
		tryHandleCodedCommand: prototype.tryHandleCodedCommand,
	};
}

afterEach(() => {
	vi.clearAllMocks();
});

describe("InteractiveMode /commit-push-pr dispatch", () => {
	it("shows the refusal message and does not call sendUserMessage when refused", async () => {
		mocks.buildCommitPushPrCommand.mockResolvedValue({ kind: "refuse", message: "GitHub CLI is not logged in." });
		const context = createContext("/repo");

		const handled = await context.tryHandleCodedCommand.call(context, "/commit-push-pr");

		expect(handled).toBe(true);
		expect(mocks.buildCommitPushPrCommand).toHaveBeenCalledWith("/repo", "");
		expect(context.showStatus).toHaveBeenCalledWith("GitHub CLI is not logged in.");
		expect(context.session.sendUserMessage).not.toHaveBeenCalled();
		expect(context.editor.setText).toHaveBeenCalledWith("");
	});

	it("calls sendUserMessage with the primed prompt text and trailing free-text args", async () => {
		mocks.buildCommitPushPrCommand.mockResolvedValue({ kind: "prompt", text: "<git_safety_protocol>...pr..." });
		const context = createContext("/repo");

		const handled = await context.tryHandleCodedCommand.call(context, "/commit-push-pr --reviewer alice Fix the bug");

		expect(handled).toBe(true);
		expect(mocks.buildCommitPushPrCommand).toHaveBeenCalledWith("/repo", "--reviewer alice Fix the bug");
		expect(context.session.sendUserMessage).toHaveBeenCalledWith("<git_safety_protocol>...pr...");
		expect(context.showStatus).not.toHaveBeenCalled();
	});

	it("does not collide with the /commit dispatch entry", async () => {
		// `/commit-push-pr` must not be swallowed by `/commit`'s matcher.
		mocks.buildCommitPushPrCommand.mockResolvedValue({ kind: "prompt", text: "ok" });
		const context = createContext("/repo");

		const handled = await context.tryHandleCodedCommand.call(context, "/commit-push-pr");

		expect(handled).toBe(true);
		expect(mocks.buildCommitPushPrCommand).toHaveBeenCalledTimes(1);
	});
});
