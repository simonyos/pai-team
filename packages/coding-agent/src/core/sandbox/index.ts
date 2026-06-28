/**
 * OS sandbox integration (Wave 1, slice S4) — public surface.
 *
 * Dependency-free adapter: derives an OS-sandbox config from pi's FsPolicy,
 * gates by platform, and wraps bash commands through an injected backend.
 */

export {
	type ConvertSandboxConfigOptions,
	convertToSandboxRuntimeConfig,
	createSandboxedBashOperations,
	DEFAULT_DEV_NETWORK,
	isSandboxSupported,
	NO_NETWORK,
	type SandboxBackend,
	type SandboxFilesystemConfig,
	type SandboxNetworkConfig,
	type SandboxRuntimeConfig,
} from "./sandbox-adapter.ts";
