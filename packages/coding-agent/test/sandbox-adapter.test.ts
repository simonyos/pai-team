import { describe, expect, it } from "vitest";
import {
	convertToSandboxRuntimeConfig,
	createSandboxedBashOperations,
	DEFAULT_DEV_NETWORK,
	isSandboxSupported,
	NO_NETWORK,
	type SandboxBackend,
} from "../src/core/sandbox/sandbox-adapter.ts";
import type { BashOperations } from "../src/core/tools/bash.ts";
import type { FsPolicy } from "../src/core/tools/fs-policy.ts";

const fsPolicy: FsPolicy = {
	writableRoots: ["/work", "/tmp"],
	denyRead: [".env", "*.pem"],
	denyWrite: [".git", ".env"],
};

describe("convertToSandboxRuntimeConfig", () => {
	it("maps writable roots and deny lists onto the sandbox filesystem config", () => {
		const config = convertToSandboxRuntimeConfig(fsPolicy);
		expect(config.filesystem.allowWrite).toEqual(["/work", "/tmp"]);
		expect(config.filesystem.denyWrite).toEqual([".git", ".env"]);
		expect(config.filesystem.denyRead).toEqual([".env", "*.pem"]);
		expect(config.network).toEqual(NO_NETWORK);
	});

	it("falls back to '.' when no writable roots are set", () => {
		const config = convertToSandboxRuntimeConfig({ writableRoots: [], denyRead: [], denyWrite: [] });
		expect(config.filesystem.allowWrite).toEqual(["."]);
	});

	it("applies network override, allowGitConfig, and extra read-denies", () => {
		const config = convertToSandboxRuntimeConfig(fsPolicy, {
			network: DEFAULT_DEV_NETWORK,
			allowGitConfig: true,
			extraDenyRead: ["secrets/"],
		});
		expect(config.network).toBe(DEFAULT_DEV_NETWORK);
		expect(config.filesystem.allowGitConfig).toBe(true);
		expect(config.filesystem.denyRead).toEqual([".env", "*.pem", "secrets/"]);
	});

	it("does not alias the source policy arrays", () => {
		const config = convertToSandboxRuntimeConfig(fsPolicy);
		config.filesystem.allowWrite.push("/etc");
		expect(fsPolicy.writableRoots).toEqual(["/work", "/tmp"]);
	});
});

describe("isSandboxSupported", () => {
	it("supports macOS and Linux, nothing else", () => {
		expect(isSandboxSupported("darwin")).toBe(true);
		expect(isSandboxSupported("linux")).toBe(true);
		expect(isSandboxSupported("win32")).toBe(false);
		expect(isSandboxSupported("aix")).toBe(false);
	});
});

describe("createSandboxedBashOperations", () => {
	function recordingOps(): { ops: BashOperations; commands: string[] } {
		const commands: string[] = [];
		const ops: BashOperations = {
			exec: async (command) => {
				commands.push(command);
				return { exitCode: 0 };
			},
		};
		return { ops, commands };
	}

	const execOpts = { onData: () => {} };

	it("wraps the command through an enabled backend before delegating", async () => {
		const { ops, commands } = recordingOps();
		const backend: SandboxBackend = {
			isEnabled: () => true,
			wrapCommand: async (cmd) => `sandbox-exec -- ${cmd}`,
		};
		const sandboxed = createSandboxedBashOperations(backend, ops);
		await sandboxed.exec("rm -rf build", "/work", execOpts);
		expect(commands).toEqual(["sandbox-exec -- rm -rf build"]);
	});

	it("passes the command through unchanged when the backend is disabled", async () => {
		const { ops, commands } = recordingOps();
		let wrapCalls = 0;
		const backend: SandboxBackend = {
			isEnabled: () => false,
			wrapCommand: async (cmd) => {
				wrapCalls++;
				return cmd;
			},
		};
		const sandboxed = createSandboxedBashOperations(backend, ops);
		await sandboxed.exec("ls", "/work", execOpts);
		expect(commands).toEqual(["ls"]);
		expect(wrapCalls).toBe(0);
	});
});
