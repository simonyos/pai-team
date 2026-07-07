import { afterEach, describe, expect, it, vi } from "vitest";
import type { BranchCommandResult } from "../src/core/git/branch-command.ts";
import type { CommitCommandResult } from "../src/core/git/commit-command.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

// Exercises the /commit and /branch coded-command dispatch entries in interactive
// mode (Wave 2.2 slice G4), following the /ping-builtin dispatch test conventions
// (see interactive-mode-coded-command.test.ts).

const mocks = vi.hoisted(() => ({
	buildCommitCommand: vi.fn<(cwd: string, args: string) => Promise<CommitCommandResult>>(),
	buildBranchCommand: vi.fn<(cwd: string, args: string) => Promise<BranchCommandResult>>(),
}));

vi.mock("../src/core/git/commit-command.ts", () => ({
	buildCommitCommand: mocks.buildCommitCommand,
}));
vi.mock("../src/core/git/branch-command.ts", () => ({
	buildBranchCommand: mocks.buildBranchCommand,
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

describe("InteractiveMode /commit dispatch", () => {
	it("shows the refusal message and does not call sendUserMessage when refused", async () => {
		mocks.buildCommitCommand.mockResolvedValue({ kind: "refuse", message: "nothing to commit" });
		const context = createContext("/repo");

		const handled = await context.tryHandleCodedCommand.call(context, "/commit");

		expect(handled).toBe(true);
		expect(mocks.buildCommitCommand).toHaveBeenCalledWith("/repo", "");
		expect(context.showStatus).toHaveBeenCalledWith("nothing to commit");
		expect(context.session.sendUserMessage).not.toHaveBeenCalled();
		expect(context.editor.setText).toHaveBeenCalledWith("");
	});

	it("calls sendUserMessage with the primed prompt text when not refused", async () => {
		mocks.buildCommitCommand.mockResolvedValue({ kind: "prompt", text: "<git_safety_protocol>...diff..." });
		const context = createContext("/repo");

		const handled = await context.tryHandleCodedCommand.call(context, "/commit --allow-secrets");

		expect(handled).toBe(true);
		expect(mocks.buildCommitCommand).toHaveBeenCalledWith("/repo", "--allow-secrets");
		expect(context.session.sendUserMessage).toHaveBeenCalledWith("<git_safety_protocol>...diff...");
		expect(context.showStatus).not.toHaveBeenCalled();
	});
});

describe("InteractiveMode /branch dispatch", () => {
	it("shows the refusal message and does not call sendUserMessage when refused", async () => {
		mocks.buildBranchCommand.mockResolvedValue({ kind: "refuse", message: "Usage: /branch <purpose>" });
		const context = createContext("/repo");

		const handled = await context.tryHandleCodedCommand.call(context, "/branch");

		expect(handled).toBe(true);
		expect(mocks.buildBranchCommand).toHaveBeenCalledWith("/repo", "");
		expect(context.showStatus).toHaveBeenCalledWith("Usage: /branch <purpose>");
		expect(context.session.sendUserMessage).not.toHaveBeenCalled();
	});

	it("calls sendUserMessage with the primed prompt text and trailing free-text args", async () => {
		mocks.buildBranchCommand.mockResolvedValue({ kind: "prompt", text: "<git_safety_protocol>...branch..." });
		const context = createContext("/repo");

		const handled = await context.tryHandleCodedCommand.call(context, "/branch fix the login bug");

		expect(handled).toBe(true);
		expect(mocks.buildBranchCommand).toHaveBeenCalledWith("/repo", "fix the login bug");
		expect(context.session.sendUserMessage).toHaveBeenCalledWith("<git_safety_protocol>...branch...");
		expect(context.showStatus).not.toHaveBeenCalled();
	});
});
