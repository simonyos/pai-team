import { describe, expect, it } from "vitest";
import { isSandboxSupported, type SandboxRuntimeConfig } from "../src/core/sandbox/sandbox-adapter.ts";
import { createSandboxRuntimeBackend } from "../src/core/sandbox/sandbox-runtime-backend.ts";

const supported = isSandboxSupported();
const config: SandboxRuntimeConfig = {
	network: { allowedDomains: [], deniedDomains: [] },
	filesystem: { denyRead: [], allowWrite: ["."], denyWrite: [] },
};

function fakeModule() {
	const calls = { init: 0, wrap: 0, reset: 0 };
	return {
		calls,
		mod: {
			SandboxManager: {
				initialize: async () => {
					calls.init++;
				},
				wrapWithSandbox: async (command: string) => {
					calls.wrap++;
					return `wrapped:${command}`;
				},
				reset: async () => {
					calls.reset++;
				},
			},
		},
	};
}

describe.skipIf(!supported)("createSandboxRuntimeBackend (supported platform)", () => {
	it("initializes once and wraps commands through the sandbox", async () => {
		const { calls, mod } = fakeModule();
		const backend = createSandboxRuntimeBackend(config, { loadModule: async () => mod });
		expect(backend.isEnabled()).toBe(true);
		expect(await backend.wrapCommand("ls")).toBe("wrapped:ls");
		expect(await backend.wrapCommand("pwd")).toBe("wrapped:pwd");
		expect(calls.init).toBe(1); // memoized
		expect(calls.wrap).toBe(2);
		await backend.reset();
		expect(calls.reset).toBe(1);
	});

	it("fails open with a warning when the runtime cannot be loaded", async () => {
		const warnings: string[] = [];
		const backend = createSandboxRuntimeBackend(config, {
			loadModule: async () => {
				throw new Error("module not installed");
			},
			onWarning: (m) => warnings.push(m),
		});
		// First command triggers the (failing) lazy init; command passes through unchanged.
		expect(await backend.wrapCommand("rm -rf build")).toBe("rm -rf build");
		expect(backend.isEnabled()).toBe(false);
		expect(warnings.some((w) => /unavailable/i.test(w))).toBe(true);
	});

	it("fails open when wrapping itself throws", async () => {
		const warnings: string[] = [];
		const backend = createSandboxRuntimeBackend(config, {
			loadModule: async () => ({
				SandboxManager: {
					initialize: async () => {},
					wrapWithSandbox: async () => {
						throw new Error("sandbox-exec missing");
					},
					reset: async () => {},
				},
			}),
			onWarning: (m) => warnings.push(m),
		});
		expect(await backend.wrapCommand("ls")).toBe("ls");
		expect(warnings.some((w) => /wrap failed/i.test(w))).toBe(true);
	});

	it("reset is a no-op before initialization", async () => {
		const { calls, mod } = fakeModule();
		const backend = createSandboxRuntimeBackend(config, { loadModule: async () => mod });
		await backend.reset();
		expect(calls.reset).toBe(0);
	});
});
