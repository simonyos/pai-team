import type { AssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BranchCommandResult } from "../src/core/git/branch-command.ts";
import type { CommitCommandResult } from "../src/core/git/commit-command.ts";
import { runPrintMode } from "../src/modes/print-mode.ts";

// Exercises the /commit and /branch coded-command interception in print/headless
// mode (Wave 2.2 slice G4), following the /ping-builtin interception test
// conventions (see print-mode-coded-command.test.ts).

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

const printIo = vi.hoisted(() => ({ outputLines: [] as string[] }));

vi.mock("../src/core/output-guard.js", () => ({
	flushRawStdout: vi.fn(async () => {}),
	takeOverStdout: vi.fn(),
	waitForRawStdoutBackpressure: vi.fn(async () => {}),
	writeRawStdout: (line: string) => {
		printIo.outputLines.push(line);
	},
}));

type FakeSession = {
	sessionManager: { getHeader: () => object | undefined; getCwd: () => string };
	agent: { waitForIdle: () => Promise<void> };
	state: { messages: AssistantMessage[] };
	extensionRunner: { hasHandlers: (eventType: string) => boolean; emit: ReturnType<typeof vi.fn> };
	bindExtensions: ReturnType<typeof vi.fn>;
	subscribe: ReturnType<typeof vi.fn>;
	prompt: ReturnType<typeof vi.fn>;
	sendUserMessage: ReturnType<typeof vi.fn>;
	reload: ReturnType<typeof vi.fn>;
};

type FakeRuntimeHost = {
	session: FakeSession;
	newSession: ReturnType<typeof vi.fn>;
	fork: ReturnType<typeof vi.fn>;
	switchSession: ReturnType<typeof vi.fn>;
	dispose: ReturnType<typeof vi.fn>;
	setRebindSession: ReturnType<typeof vi.fn>;
};

function createRuntimeHost(): FakeRuntimeHost {
	const session: FakeSession = {
		sessionManager: { getHeader: () => undefined, getCwd: () => "/repo" },
		agent: { waitForIdle: async () => {} },
		state: { messages: [] },
		extensionRunner: { hasHandlers: () => false, emit: vi.fn(async () => {}) },
		bindExtensions: vi.fn(async () => {}),
		subscribe: vi.fn(() => () => {}),
		prompt: vi.fn(async () => {}),
		sendUserMessage: vi.fn(async () => {}),
		reload: vi.fn(async () => {}),
	};

	return {
		session,
		newSession: vi.fn(async () => undefined),
		fork: vi.fn(async () => ({ selectedText: "" })),
		switchSession: vi.fn(async () => undefined),
		dispose: vi.fn(async () => {}),
		setRebindSession: vi.fn(),
	};
}

afterEach(() => {
	printIo.outputLines = [];
	vi.restoreAllMocks();
	vi.clearAllMocks();
});

describe("runPrintMode /commit dispatch", () => {
	it("prints the refusal message and does not call sendUserMessage or prompt (text mode)", async () => {
		const runtimeHost = createRuntimeHost();
		const { session } = runtimeHost;
		mocks.buildCommitCommand.mockResolvedValue({ kind: "refuse", message: "nothing to commit" });

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
			initialMessage: "/commit",
		});

		expect(exitCode).toBe(0);
		expect(mocks.buildCommitCommand).toHaveBeenCalledWith("/repo", "");
		expect(session.sendUserMessage).not.toHaveBeenCalled();
		expect(session.prompt).not.toHaveBeenCalled();
		expect(printIo.outputLines.join("")).toContain("nothing to commit");
	});

	it("emits a structured refused coded_command event in json mode", async () => {
		const runtimeHost = createRuntimeHost();
		const { session } = runtimeHost;
		mocks.buildCommitCommand.mockResolvedValue({ kind: "refuse", message: "nothing to commit" });

		await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "json",
			messages: ["/commit"],
		});

		expect(session.sendUserMessage).not.toHaveBeenCalled();
		const events = printIo.outputLines
			.flatMap((line) => line.split("\n"))
			.filter((line) => line.trim().length > 0)
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		expect(events).toContainEqual({
			type: "coded_command",
			command: "commit",
			refused: true,
			message: "nothing to commit",
		});
	});

	it("calls sendUserMessage with the primed prompt text when not refused", async () => {
		const runtimeHost = createRuntimeHost();
		const { session } = runtimeHost;
		mocks.buildCommitCommand.mockResolvedValue({ kind: "prompt", text: "<git_safety_protocol>...diff..." });

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
			initialMessage: "/commit --allow-secrets",
		});

		expect(exitCode).toBe(0);
		expect(mocks.buildCommitCommand).toHaveBeenCalledWith("/repo", "--allow-secrets");
		expect(session.sendUserMessage).toHaveBeenCalledWith("<git_safety_protocol>...diff...");
		expect(session.prompt).not.toHaveBeenCalled();
	});

	it("emits a structured refused:false coded_command event in json mode when not refused", async () => {
		const runtimeHost = createRuntimeHost();
		const { session } = runtimeHost;
		mocks.buildCommitCommand.mockResolvedValue({ kind: "prompt", text: "<git_safety_protocol>...diff..." });

		await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "json",
			messages: ["/commit"],
		});

		expect(session.sendUserMessage).toHaveBeenCalledWith("<git_safety_protocol>...diff...");
		const events = printIo.outputLines
			.flatMap((line) => line.split("\n"))
			.filter((line) => line.trim().length > 0)
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		expect(events).toContainEqual({ type: "coded_command", command: "commit", refused: false });
	});
});

describe("runPrintMode /branch dispatch", () => {
	it("prints the refusal message and does not call sendUserMessage or prompt (text mode)", async () => {
		const runtimeHost = createRuntimeHost();
		const { session } = runtimeHost;
		mocks.buildBranchCommand.mockResolvedValue({ kind: "refuse", message: "Usage: /branch <purpose>" });

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
			initialMessage: "/branch",
		});

		expect(exitCode).toBe(0);
		expect(mocks.buildBranchCommand).toHaveBeenCalledWith("/repo", "");
		expect(session.sendUserMessage).not.toHaveBeenCalled();
		expect(session.prompt).not.toHaveBeenCalled();
		expect(printIo.outputLines.join("")).toContain("Usage: /branch <purpose>");
	});

	it("calls sendUserMessage with the primed prompt text and trailing free-text args", async () => {
		const runtimeHost = createRuntimeHost();
		const { session } = runtimeHost;
		mocks.buildBranchCommand.mockResolvedValue({ kind: "prompt", text: "<git_safety_protocol>...branch..." });

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
			initialMessage: "/branch fix the login bug",
		});

		expect(exitCode).toBe(0);
		expect(mocks.buildBranchCommand).toHaveBeenCalledWith("/repo", "fix the login bug");
		expect(session.sendUserMessage).toHaveBeenCalledWith("<git_safety_protocol>...branch...");
		expect(session.prompt).not.toHaveBeenCalled();
	});

	it("emits a structured coded_command event in json mode (refused and not refused)", async () => {
		const runtimeHost = createRuntimeHost();
		const { session } = runtimeHost;
		mocks.buildBranchCommand.mockResolvedValueOnce({ kind: "refuse", message: "Usage: /branch <purpose>" });

		await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "json",
			messages: ["/branch"],
		});

		expect(session.sendUserMessage).not.toHaveBeenCalled();
		let events = printIo.outputLines
			.flatMap((line) => line.split("\n"))
			.filter((line) => line.trim().length > 0)
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		expect(events).toContainEqual({
			type: "coded_command",
			command: "branch",
			refused: true,
			message: "Usage: /branch <purpose>",
		});

		printIo.outputLines = [];
		mocks.buildBranchCommand.mockResolvedValueOnce({ kind: "prompt", text: "<git_safety_protocol>...branch..." });

		await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "json",
			messages: ["/branch fix the login bug"],
		});

		expect(session.sendUserMessage).toHaveBeenCalledWith("<git_safety_protocol>...branch...");
		events = printIo.outputLines
			.flatMap((line) => line.split("\n"))
			.filter((line) => line.trim().length > 0)
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		expect(events).toContainEqual({ type: "coded_command", command: "branch", refused: false });
	});

	it("still forwards ordinary prompts to the model", async () => {
		const runtimeHost = createRuntimeHost();
		const { session } = runtimeHost;

		await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
			initialMessage: "hello world",
		});

		expect(session.prompt).toHaveBeenCalledWith("hello world", { images: undefined });
		expect(mocks.buildCommitCommand).not.toHaveBeenCalled();
		expect(mocks.buildBranchCommand).not.toHaveBeenCalled();
	});
});
