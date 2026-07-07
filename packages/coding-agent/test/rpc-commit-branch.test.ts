import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import type { BranchCommandResult } from "../src/core/git/branch-command.ts";
import type { CommitCommandResult } from "../src/core/git/commit-command.ts";
import { runRpcMode } from "../src/modes/rpc/rpc-mode.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

// Exercises the /commit and /branch coded-command dispatch cases in RPC mode
// (Wave 2.2 slice G4), following the ping_builtin dispatch test conventions
// (see rpc-ping-builtin.test.ts).

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

const rpcIo = vi.hoisted(() => ({
	outputLines: [] as string[],
	lineHandler: undefined as ((line: string) => void) | undefined,
}));

vi.mock("../src/core/output-guard.js", () => ({
	flushRawStdout: vi.fn(async () => {}),
	takeOverStdout: vi.fn(),
	waitForRawStdoutBackpressure: vi.fn(async () => {}),
	writeRawStdout: (line: string) => {
		rpcIo.outputLines.push(line);
	},
}));

vi.mock("../src/modes/interactive/theme/theme.js", () => ({ theme: {} }));

vi.mock("../src/modes/rpc/jsonl.js", () => ({
	attachJsonlLineReader: vi.fn((_stream: NodeJS.ReadableStream, onLine: (line: string) => void) => {
		rpcIo.lineHandler = onLine;
		return () => {
			rpcIo.lineHandler = undefined;
		};
	}),
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

type NodeListener = Parameters<typeof process.on>[1];

type ListenerSnapshot = {
	stdinEnd: NodeListener[];
	signals: Map<NodeJS.Signals, NodeListener[]>;
};

function takeListenerSnapshot(): ListenerSnapshot {
	const signals: NodeJS.Signals[] = process.platform === "win32" ? ["SIGTERM"] : ["SIGTERM", "SIGHUP"];
	return {
		stdinEnd: process.stdin.listeners("end") as NodeListener[],
		signals: new Map(signals.map((signal) => [signal, process.listeners(signal) as NodeListener[]])),
	};
}

function restoreListeners(snapshot: ListenerSnapshot): void {
	for (const listener of process.stdin.listeners("end") as NodeListener[]) {
		if (!snapshot.stdinEnd.includes(listener)) {
			process.stdin.off("end", listener);
		}
	}

	for (const [signal, previousListeners] of snapshot.signals) {
		for (const listener of process.listeners(signal) as NodeListener[]) {
			if (!previousListeners.includes(listener)) {
				process.off(signal, listener);
			}
		}
	}
}

function parseOutputLines(): Array<Record<string, unknown>> {
	return rpcIo.outputLines
		.flatMap((line) => line.split("\n"))
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function createRuntimeHost(harness: Harness): AgentSessionRuntime {
	return {
		session: harness.session,
		newSession: vi.fn(async () => ({ cancelled: true })),
		switchSession: vi.fn(async () => ({ cancelled: true })),
		fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
		dispose: vi.fn(async () => {}),
		setRebindSession: vi.fn(),
	} as unknown as AgentSessionRuntime;
}

describe("RPC coded-command dispatch (commit/branch)", () => {
	afterEach(() => {
		rpcIo.outputLines = [];
		rpcIo.lineHandler = undefined;
		vi.clearAllMocks();
	});

	test("commit: refusal returns an error response and never calls sendUserMessage", async () => {
		const listenerSnapshot = takeListenerSnapshot();
		const harness = await createHarness();
		const sendUserMessageSpy = vi.spyOn(harness.session, "sendUserMessage");
		mocks.buildCommitCommand.mockResolvedValue({ kind: "refuse", message: "nothing to commit" });

		try {
			void runRpcMode(createRuntimeHost(harness));
			await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());

			rpcIo.lineHandler?.(JSON.stringify({ id: "commit-1", type: "commit" }));

			await vi.waitFor(() => {
				expect(parseOutputLines()).toContainEqual({
					id: "commit-1",
					type: "response",
					command: "commit",
					success: false,
					error: "nothing to commit",
				});
			});
			expect(sendUserMessageSpy).not.toHaveBeenCalled();
		} finally {
			harness.cleanup();
			restoreListeners(listenerSnapshot);
		}
	});

	test("commit: success calls sendUserMessage with the primed prompt and returns a success response", async () => {
		const listenerSnapshot = takeListenerSnapshot();
		const harness = await createHarness();
		harness.setResponses([fauxAssistantMessage("committed")]);
		const sendUserMessageSpy = vi.spyOn(harness.session, "sendUserMessage");
		mocks.buildCommitCommand.mockResolvedValue({ kind: "prompt", text: "<git_safety_protocol>...diff..." });

		try {
			void runRpcMode(createRuntimeHost(harness));
			await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());

			rpcIo.lineHandler?.(JSON.stringify({ id: "commit-2", type: "commit", args: "--allow-secrets" }));

			await vi.waitFor(() => {
				expect(parseOutputLines()).toContainEqual({
					id: "commit-2",
					type: "response",
					command: "commit",
					success: true,
					data: { sent: true },
				});
			});
			expect(mocks.buildCommitCommand).toHaveBeenCalledWith(
				harness.session.sessionManager.getCwd(),
				"--allow-secrets",
			);
			expect(sendUserMessageSpy).toHaveBeenCalledWith("<git_safety_protocol>...diff...");
		} finally {
			harness.cleanup();
			restoreListeners(listenerSnapshot);
		}
	});

	test("branch: refusal returns an error response and never calls sendUserMessage", async () => {
		const listenerSnapshot = takeListenerSnapshot();
		const harness = await createHarness();
		const sendUserMessageSpy = vi.spyOn(harness.session, "sendUserMessage");
		mocks.buildBranchCommand.mockResolvedValue({ kind: "refuse", message: "Usage: /branch <purpose>" });

		try {
			void runRpcMode(createRuntimeHost(harness));
			await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());

			rpcIo.lineHandler?.(JSON.stringify({ id: "branch-1", type: "branch", args: "" }));

			await vi.waitFor(() => {
				expect(parseOutputLines()).toContainEqual({
					id: "branch-1",
					type: "response",
					command: "branch",
					success: false,
					error: "Usage: /branch <purpose>",
				});
			});
			expect(sendUserMessageSpy).not.toHaveBeenCalled();
		} finally {
			harness.cleanup();
			restoreListeners(listenerSnapshot);
		}
	});

	test("branch: success calls sendUserMessage with the primed prompt and returns a success response", async () => {
		const listenerSnapshot = takeListenerSnapshot();
		const harness = await createHarness();
		harness.setResponses([fauxAssistantMessage("branched")]);
		const sendUserMessageSpy = vi.spyOn(harness.session, "sendUserMessage");
		mocks.buildBranchCommand.mockResolvedValue({ kind: "prompt", text: "<git_safety_protocol>...branch..." });

		try {
			void runRpcMode(createRuntimeHost(harness));
			await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());

			rpcIo.lineHandler?.(JSON.stringify({ id: "branch-2", type: "branch", args: "fix the login bug" }));

			await vi.waitFor(() => {
				expect(parseOutputLines()).toContainEqual({
					id: "branch-2",
					type: "response",
					command: "branch",
					success: true,
					data: { sent: true },
				});
			});
			expect(mocks.buildBranchCommand).toHaveBeenCalledWith(
				harness.session.sessionManager.getCwd(),
				"fix the login bug",
			);
			expect(sendUserMessageSpy).toHaveBeenCalledWith("<git_safety_protocol>...branch...");
		} finally {
			harness.cleanup();
			restoreListeners(listenerSnapshot);
		}
	});
});
