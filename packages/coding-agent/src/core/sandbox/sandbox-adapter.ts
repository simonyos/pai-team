/**
 * OS sandbox adapter (Wave 1, slice S4).
 *
 * Bridges pi's filesystem policy (S3) to an OS-level sandbox that confines bash
 * commands (sandbox-exec on macOS, bubblewrap on Linux). The actual enforcement
 * is delegated to `@anthropic-ai/sandbox-runtime` via a small injected backend
 * (the {@link SandboxBackend} seam) so this module — and pi's core — take on NO
 * dependency on that package: a host (the sandbox extension, or an SDK embedder)
 * provides a backend, and core derives the config and wraps bash commands.
 *
 * What lives here (pure, dependency-free, unit-testable):
 *  - `convertToSandboxRuntimeConfig` — derive the sandbox config from an FsPolicy
 *  - `isSandboxSupported` — platform gate (darwin/linux; Windows degrades to none)
 *  - `createSandboxedBashOperations` — wrap a command via the backend before exec
 *
 * Out of scope here: launching sandbox-exec/bwrap, the network proxy, and
 * runtime violation prompting — those belong to the backend implementation.
 */

import type { BashOperations } from "../tools/bash.ts";
import type { FsPolicy } from "../tools/fs-policy.ts";

/**
 * Structural mirror of `@anthropic-ai/sandbox-runtime`'s NetworkConfig. Declared
 * locally so core needs no dependency on that package; a backend passes this
 * straight to `SandboxManager.initialize` (shape-compatible).
 */
export interface SandboxNetworkConfig {
	allowedDomains: string[];
	deniedDomains: string[];
	httpProxyPort?: number;
	socksProxyPort?: number;
}

/** Structural mirror of `@anthropic-ai/sandbox-runtime`'s FilesystemConfig. */
export interface SandboxFilesystemConfig {
	denyRead: string[];
	allowWrite: string[];
	denyWrite: string[];
	allowGitConfig?: boolean;
}

/** Structural mirror of `@anthropic-ai/sandbox-runtime`'s SandboxRuntimeConfig (subset core derives). */
export interface SandboxRuntimeConfig {
	network: SandboxNetworkConfig;
	filesystem: SandboxFilesystemConfig;
}

export interface ConvertSandboxConfigOptions {
	/** Network allowlist/denylist. Default: deny-all (no network). */
	network?: SandboxNetworkConfig;
	/** Allow reads/writes of the user's global git config. Default: undefined (backend default). */
	allowGitConfig?: boolean;
	/** Extra read-deny rules layered on top of the policy's denyRead. */
	extraDenyRead?: string[];
}

/** No network access — the safe default until a host opts into an allowlist. */
export const NO_NETWORK: SandboxNetworkConfig = { allowedDomains: [], deniedDomains: [] };

/** A pragmatic developer network allowlist (package registries + GitHub) a host may opt into. */
export const DEFAULT_DEV_NETWORK: SandboxNetworkConfig = {
	allowedDomains: [
		"registry.npmjs.org",
		"npmjs.org",
		"*.npmjs.org",
		"registry.yarnpkg.com",
		"pypi.org",
		"*.pypi.org",
		"files.pythonhosted.org",
		"crates.io",
		"static.crates.io",
		"github.com",
		"*.github.com",
		"api.github.com",
		"raw.githubusercontent.com",
		"objects.githubusercontent.com",
	],
	deniedDomains: [],
};

/**
 * Derive a sandbox-runtime config from pi's filesystem policy. Writable roots
 * become the sandbox's writable paths; the policy's deny lists carry over. The
 * network defaults to deny-all unless the caller supplies an allowlist.
 */
export function convertToSandboxRuntimeConfig(
	fsPolicy: FsPolicy,
	options: ConvertSandboxConfigOptions = {},
): SandboxRuntimeConfig {
	return {
		network: options.network ?? NO_NETWORK,
		filesystem: {
			// An empty writableRoots in pi means "no root restriction"; the OS sandbox
			// must still be given at least the cwd, so fall back to ".".
			allowWrite: fsPolicy.writableRoots.length > 0 ? [...fsPolicy.writableRoots] : ["."],
			denyWrite: [...fsPolicy.denyWrite],
			denyRead: [...fsPolicy.denyRead, ...(options.extraDenyRead ?? [])],
			allowGitConfig: options.allowGitConfig,
		},
	};
}

/** Is OS-level sandboxing available on this platform? macOS/Linux yes; everything else no. */
export function isSandboxSupported(platform: NodeJS.Platform = process.platform): boolean {
	return platform === "darwin" || platform === "linux";
}

/**
 * The injected enforcement seam. A host backed by `@anthropic-ai/sandbox-runtime`
 * implements this: `wrapCommand` returns the command rewritten to run under
 * sandbox-exec/bwrap. Core never constructs a backend itself.
 */
export interface SandboxBackend {
	/** Whether sandboxing is active (initialized + supported + not disabled). */
	isEnabled(): boolean;
	/** Rewrite a shell command so it runs confined; returns it unchanged when disabled. */
	wrapCommand(command: string): Promise<string>;
}

/**
 * Wrap a {@link BashOperations} so every command is rewritten by the sandbox
 * backend before execution. When the backend is disabled the base operations run
 * unchanged, so this is safe to install unconditionally.
 */
export function createSandboxedBashOperations(backend: SandboxBackend, baseOps: BashOperations): BashOperations {
	return {
		exec: async (command, cwd, options) => {
			if (!backend.isEnabled()) {
				return baseOps.exec(command, cwd, options);
			}
			const wrapped = await backend.wrapCommand(command);
			return baseOps.exec(wrapped, cwd, options);
		},
	};
}
