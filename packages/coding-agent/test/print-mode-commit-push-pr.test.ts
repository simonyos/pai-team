import type { AssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommitPushPrCommandResult } from "../src/core/git/commit-push-pr-command.ts";
import { runPrintMode } from "../src/modes/print-mode.ts";

// Exercises the /commit-push-pr coded-command interception in print/headless mode
// (Wave 2.2 slice G5), following the /commit + /branch interception test
// conventions (see print-mode-commit-branch.test.ts).

const mocks = vi.hoisted(() => ({
	buildCommitPushPrCommand: vi.fn<(cwd: string, args: string) => Promise<CommitPushPrCommandResult>>(),
}));

vi.mock("../src/core/git/commit-push-pr-command.ts", () => ({
	buildCommitPushPrCommand: mocks.buildCommitPushPrCommand,
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

describe("runPrintMode /commit-push-pr dispatch", () => {
	it("prints the refusal message and does not call sendUserMessage or prompt (text mode)", async () => {
		const runtimeHost = createRuntimeHost();
		const { session } = runtimeHost;
		mocks.buildCommitPushPrCommand.mockResolvedValue({ kind: "refuse", message: "GitHub CLI is not logged in." });

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
			initialMessage: "/commit-push-pr",
		});

		expect(exitCode).toBe(0);
		expect(mocks.buildCommitPushPrCommand).toHaveBeenCalledWith("/repo", "");
		expect(session.sendUserMessage).not.toHaveBeenCalled();
		expect(session.prompt).not.toHaveBeenCalled();
		expect(printIo.outputLines.join("")).toContain("GitHub CLI is not logged in.");
	});

	it("calls sendUserMessage with the primed prompt text and trailing free-text args", async () => {
		const runtimeHost = createRuntimeHost();
		const { session } = runtimeHost;
		mocks.buildCommitPushPrCommand.mockResolvedValue({ kind: "prompt", text: "<git_safety_protocol>...pr..." });

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
			initialMessage: "/commit-push-pr --reviewer alice Fix the bug",
		});

		expect(exitCode).toBe(0);
		expect(mocks.buildCommitPushPrCommand).toHaveBeenCalledWith("/repo", "--reviewer alice Fix the bug");
		expect(session.sendUserMessage).toHaveBeenCalledWith("<git_safety_protocol>...pr...");
		expect(session.prompt).not.toHaveBeenCalled();
	});

	it("emits a structured coded_command event in json mode (refused and not refused)", async () => {
		const runtimeHost = createRuntimeHost();
		const { session } = runtimeHost;
		mocks.buildCommitPushPrCommand.mockResolvedValueOnce({ kind: "refuse", message: "on the default branch" });

		await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "json",
			messages: ["/commit-push-pr"],
		});

		expect(session.sendUserMessage).not.toHaveBeenCalled();
		let events = printIo.outputLines
			.flatMap((line) => line.split("\n"))
			.filter((line) => line.trim().length > 0)
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		expect(events).toContainEqual({
			type: "coded_command",
			command: "commit-push-pr",
			refused: true,
			message: "on the default branch",
		});

		printIo.outputLines = [];
		mocks.buildCommitPushPrCommand.mockResolvedValueOnce({ kind: "prompt", text: "<git_safety_protocol>...pr..." });

		await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "json",
			messages: ["/commit-push-pr open a PR"],
		});

		expect(session.sendUserMessage).toHaveBeenCalledWith("<git_safety_protocol>...pr...");
		events = printIo.outputLines
			.flatMap((line) => line.split("\n"))
			.filter((line) => line.trim().length > 0)
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		expect(events).toContainEqual({ type: "coded_command", command: "commit-push-pr", refused: false });
	});
});
