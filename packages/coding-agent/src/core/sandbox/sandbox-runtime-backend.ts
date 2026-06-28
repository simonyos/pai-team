/**
 * Built-in OS sandbox backend (Wave 1, slice S4 follow-up).
 *
 * Implements the {@link SandboxBackend} seam on top of `@anthropic-ai/sandbox-runtime`.
 * That package is an OPTIONAL dependency: it vendors platform-specific binaries
 * (seccomp on Linux) and may be skipped or unavailable, so it is loaded via a
 * guarded dynamic import — exactly like the optional native clipboard module. If
 * it is missing, or the platform is unsupported, or initialization fails, the
 * backend disables itself and bash runs unsandboxed (fail-open WITH a warning,
 * the agreed policy for missing Linux sandbox deps).
 */

import { isSandboxSupported, type SandboxBackend, type SandboxRuntimeConfig } from "./sandbox-adapter.ts";

/** The slice of `@anthropic-ai/sandbox-runtime`'s SandboxManager this backend uses. */
interface SandboxManagerModule {
	SandboxManager: {
		initialize(config: SandboxRuntimeConfig, askCallback?: unknown, enableLogMonitor?: boolean): Promise<void>;
		wrapWithSandbox(command: string): Promise<string>;
		reset(): Promise<void>;
	};
}

export interface SandboxRuntimeBackendOptions {
	/** Where to surface a warning when the sandbox can't be enabled. Default: stderr. */
	onWarning?: (message: string) => void;
	/**
	 * How to load the sandbox runtime. Defaults to a guarded dynamic import of
	 * `@anthropic-ai/sandbox-runtime`. Overridable for testing.
	 */
	loadModule?: () => Promise<SandboxManagerModule>;
}

/** A {@link SandboxBackend} that also exposes the sandbox lifecycle reset. */
export interface SandboxRuntimeBackend extends SandboxBackend {
	/** Tear down the sandbox (network proxy etc.). Best-effort; safe to call when never initialized. */
	reset(): Promise<void>;
}

/**
 * Create a sandbox backend backed by `@anthropic-ai/sandbox-runtime`. Construction
 * is synchronous; the native sandbox is initialized lazily (and once) on the first
 * wrapped command, so callers can install it without reordering startup.
 */
export function createSandboxRuntimeBackend(
	config: SandboxRuntimeConfig,
	options: SandboxRuntimeBackendOptions = {},
): SandboxRuntimeBackend {
	const warn = options.onWarning ?? ((message: string) => process.stderr.write(`${message}\n`));
	const loadModule =
		options.loadModule ?? (() => import("@anthropic-ai/sandbox-runtime") as unknown as Promise<SandboxManagerModule>);
	let disabled = !isSandboxSupported();
	let manager: SandboxManagerModule["SandboxManager"] | null = null;
	let initPromise: Promise<SandboxManagerModule["SandboxManager"] | null> | undefined;

	if (disabled) {
		warn(`OS sandbox is not supported on ${process.platform}; bash will run unsandboxed.`);
	}

	const ensureManager = (): Promise<SandboxManagerModule["SandboxManager"] | null> => {
		if (disabled) return Promise.resolve(null);
		if (!initPromise) {
			initPromise = (async () => {
				try {
					const mod = await loadModule();
					await mod.SandboxManager.initialize(config);
					manager = mod.SandboxManager;
					return manager;
				} catch (err) {
					disabled = true;
					warn(
						`OS sandbox unavailable (${err instanceof Error ? err.message : String(err)}); bash will run unsandboxed.`,
					);
					return null;
				}
			})();
		}
		return initPromise;
	};

	return {
		isEnabled: () => !disabled,
		wrapCommand: async (command: string): Promise<string> => {
			const sandbox = await ensureManager();
			if (!sandbox) return command;
			try {
				return await sandbox.wrapWithSandbox(command);
			} catch (err) {
				warn(
					`Sandbox wrap failed (${err instanceof Error ? err.message : String(err)}); running command unsandboxed.`,
				);
				return command;
			}
		},
		reset: async (): Promise<void> => {
			if (!manager) return;
			try {
				await manager.reset();
			} catch {
				// Best-effort teardown; ignore cleanup errors.
			}
		},
	};
}
