import type { AssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runPrintMode } from "../src/modes/print-mode.ts";

// Exercises the coded (built-in) command interception in print/headless mode
// via the `/ping-builtin` stub command (issue XZI-6).

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
	sessionManager: { getHeader: () => object | undefined };
	agent: { waitForIdle: () => Promise<void> };
	state: { messages: AssistantMessage[] };
	extensionRunner: { hasHandlers: (eventType: string) => boolean; emit: ReturnType<typeof vi.fn> };
	bindExtensions: ReturnType<typeof vi.fn>;
	subscribe: ReturnType<typeof vi.fn>;
	prompt: ReturnType<typeof vi.fn>;
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
		sessionManager: { getHeader: () => undefined },
		agent: { waitForIdle: async () => {} },
		state: { messages: [] },
		extensionRunner: { hasHandlers: () => false, emit: vi.fn(async () => {}) },
		bindExtensions: vi.fn(async () => {}),
		subscribe: vi.fn(() => () => {}),
		prompt: vi.fn(async () => {}),
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
});

describe("runPrintMode coded-command interception", () => {
	it("handles /ping-builtin without prompting the model (text mode)", async () => {
		const runtimeHost = createRuntimeHost();
		const { session } = runtimeHost;

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
			initialMessage: "/ping-builtin",
		});

		expect(exitCode).toBe(0);
		expect(session.prompt).not.toHaveBeenCalled();
		expect(printIo.outputLines.join("")).toContain("pong");
	});

	it("emits a structured coded_command event in json mode", async () => {
		const runtimeHost = createRuntimeHost();
		const { session } = runtimeHost;

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "json",
			messages: ["/ping-builtin"],
		});

		expect(exitCode).toBe(0);
		expect(session.prompt).not.toHaveBeenCalled();

		const events = printIo.outputLines
			.flatMap((line) => line.split("\n"))
			.filter((line) => line.trim().length > 0)
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		expect(events).toContainEqual({ type: "coded_command", command: "ping-builtin", output: "pong" });
	});

	it("still forwards ordinary prompts to the model", async () => {
		const runtimeHost = createRuntimeHost();
		const { session } = runtimeHost;

		await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
			initialMessage: "hello world",
		});

		expect(session.prompt).toHaveBeenCalledWith("hello world", { images: undefined });
	});
});
