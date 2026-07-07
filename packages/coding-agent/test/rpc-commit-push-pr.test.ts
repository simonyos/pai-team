import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import type { CommitPushPrCommandResult } from "../src/core/git/commit-push-pr-command.ts";
import { runRpcMode } from "../src/modes/rpc/rpc-mode.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

// Exercises the /commit-push-pr coded-command dispatch case in RPC mode (Wave 2.2
// slice G5), following the commit/branch dispatch test conventions
// (see rpc-commit-branch.test.ts).

const mocks = vi.hoisted(() => ({
	buildCommitPushPrCommand: vi.fn<(cwd: string, args: string) => Promise<CommitPushPrCommandResult>>(),
}));

vi.mock("../src/core/git/commit-push-pr-command.ts", () => ({
	buildCommitPushPrCommand: mocks.buildCommitPushPrCommand,
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

describe("RPC coded-command dispatch (commit_push_pr)", () => {
	afterEach(() => {
		rpcIo.outputLines = [];
		rpcIo.lineHandler = undefined;
		vi.clearAllMocks();
	});

	test("refusal returns an error response and never calls sendUserMessage", async () => {
		const listenerSnapshot = takeListenerSnapshot();
		const harness = await createHarness();
		const sendUserMessageSpy = vi.spyOn(harness.session, "sendUserMessage");
		mocks.buildCommitPushPrCommand.mockResolvedValue({ kind: "refuse", message: "GitHub CLI is not logged in." });

		try {
			void runRpcMode(createRuntimeHost(harness));
			await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());

			rpcIo.lineHandler?.(JSON.stringify({ id: "cpp-1", type: "commit_push_pr" }));

			await vi.waitFor(() => {
				expect(parseOutputLines()).toContainEqual({
					id: "cpp-1",
					type: "response",
					command: "commit_push_pr",
					success: false,
					error: "GitHub CLI is not logged in.",
				});
			});
			expect(sendUserMessageSpy).not.toHaveBeenCalled();
		} finally {
			harness.cleanup();
			restoreListeners(listenerSnapshot);
		}
	});

	test("success calls sendUserMessage with the primed prompt and returns a success response", async () => {
		const listenerSnapshot = takeListenerSnapshot();
		const harness = await createHarness();
		harness.setResponses([fauxAssistantMessage("opened PR")]);
		const sendUserMessageSpy = vi.spyOn(harness.session, "sendUserMessage");
		mocks.buildCommitPushPrCommand.mockResolvedValue({ kind: "prompt", text: "<git_safety_protocol>...pr..." });

		try {
			void runRpcMode(createRuntimeHost(harness));
			await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());

			rpcIo.lineHandler?.(JSON.stringify({ id: "cpp-2", type: "commit_push_pr", args: "--reviewer alice Fix it" }));

			await vi.waitFor(() => {
				expect(parseOutputLines()).toContainEqual({
					id: "cpp-2",
					type: "response",
					command: "commit_push_pr",
					success: true,
					data: { sent: true },
				});
			});
			expect(mocks.buildCommitPushPrCommand).toHaveBeenCalledWith(
				harness.session.sessionManager.getCwd(),
				"--reviewer alice Fix it",
			);
			expect(sendUserMessageSpy).toHaveBeenCalledWith("<git_safety_protocol>...pr...");
		} finally {
			harness.cleanup();
			restoreListeners(listenerSnapshot);
		}
	});
});
