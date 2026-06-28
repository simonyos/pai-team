export {
	type BashOperations,
	type BashSpawnContext,
	type BashSpawnHook,
	type BashToolDetails,
	type BashToolInput,
	type BashToolOptions,
	createBashTool,
	createBashToolDefinition,
	createLocalBashOperations,
} from "./bash.ts";
export {
	createEditTool,
	createEditToolDefinition,
	type EditOperations,
	type EditToolDetails,
	type EditToolInput,
	type EditToolOptions,
} from "./edit.ts";
export { withFileMutationQueue } from "./file-mutation-queue.ts";
export {
	createFindTool,
	createFindToolDefinition,
	type FindOperations,
	type FindToolDetails,
	type FindToolInput,
	type FindToolOptions,
} from "./find.ts";
export {
	assertReadable,
	assertWritable,
	createDefaultFsPolicy,
	type FsPolicy,
	FsPolicyError,
	isInside,
	isReadDenied,
} from "./fs-policy.ts";
export {
	createGrepTool,
	createGrepToolDefinition,
	type GrepOperations,
	type GrepToolDetails,
	type GrepToolInput,
	type GrepToolOptions,
} from "./grep.ts";
export {
	createLsTool,
	createLsToolDefinition,
	type LsOperations,
	type LsToolDetails,
	type LsToolInput,
	type LsToolOptions,
} from "./ls.ts";
export {
	createReadTool,
	createReadToolDefinition,
	type ReadOperations,
	type ReadToolDetails,
	type ReadToolInput,
	type ReadToolOptions,
} from "./read.ts";
export {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationOptions,
	type TruncationResult,
	truncateHead,
	truncateLine,
	truncateTail,
} from "./truncate.ts";
export {
	createWriteTool,
	createWriteToolDefinition,
	type WriteOperations,
	type WriteToolInput,
	type WriteToolOptions,
} from "./write.ts";

import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolDefinition } from "../extensions/types.ts";
import { type BashToolOptions, createBashTool, createBashToolDefinition } from "./bash.ts";
import { createEditTool, createEditToolDefinition, type EditToolOptions } from "./edit.ts";
import { createFindTool, createFindToolDefinition, type FindToolOptions } from "./find.ts";
import type { FsPolicy } from "./fs-policy.ts";
import { createGrepTool, createGrepToolDefinition, type GrepToolOptions } from "./grep.ts";
import { createLsTool, createLsToolDefinition, type LsToolOptions } from "./ls.ts";
import { createReadTool, createReadToolDefinition, type ReadToolOptions } from "./read.ts";
import { createWriteTool, createWriteToolDefinition, type WriteToolOptions } from "./write.ts";

export type Tool = AgentTool<any>;
export type ToolDef = ToolDefinition<any, any>;
export type ToolName = "read" | "bash" | "edit" | "write" | "grep" | "find" | "ls";
export const allToolNames: Set<ToolName> = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);

export interface ToolsOptions {
	read?: ReadToolOptions;
	bash?: BashToolOptions;
	write?: WriteToolOptions;
	edit?: EditToolOptions;
	grep?: GrepToolOptions;
	find?: FindToolOptions;
	ls?: LsToolOptions;
	/**
	 * Filesystem scoping policy applied to the read/write/edit/grep tools (slice S3).
	 * A per-tool `fsPolicy` overrides this. Omitted = no scoping (current behavior).
	 */
	fsPolicy?: FsPolicy;
}

/** Thread a top-level {@link ToolsOptions.fsPolicy} into the read/write/edit tool options. */
function normalizeToolsOptions(options?: ToolsOptions): ToolsOptions {
	const fsPolicy = options?.fsPolicy;
	if (!fsPolicy) return options ?? {};
	return {
		...options,
		read: { ...options?.read, fsPolicy: options?.read?.fsPolicy ?? fsPolicy },
		write: { ...options?.write, fsPolicy: options?.write?.fsPolicy ?? fsPolicy },
		edit: { ...options?.edit, fsPolicy: options?.edit?.fsPolicy ?? fsPolicy },
		grep: { ...options?.grep, fsPolicy: options?.grep?.fsPolicy ?? fsPolicy },
	};
}

export function createToolDefinition(toolName: ToolName, cwd: string, options?: ToolsOptions): ToolDef {
	const opts = normalizeToolsOptions(options);
	switch (toolName) {
		case "read":
			return createReadToolDefinition(cwd, opts.read);
		case "bash":
			return createBashToolDefinition(cwd, opts.bash);
		case "edit":
			return createEditToolDefinition(cwd, opts.edit);
		case "write":
			return createWriteToolDefinition(cwd, opts.write);
		case "grep":
			return createGrepToolDefinition(cwd, opts.grep);
		case "find":
			return createFindToolDefinition(cwd, opts.find);
		case "ls":
			return createLsToolDefinition(cwd, opts.ls);
		default:
			throw new Error(`Unknown tool name: ${toolName}`);
	}
}

export function createTool(toolName: ToolName, cwd: string, options?: ToolsOptions): Tool {
	const opts = normalizeToolsOptions(options);
	switch (toolName) {
		case "read":
			return createReadTool(cwd, opts.read);
		case "bash":
			return createBashTool(cwd, opts.bash);
		case "edit":
			return createEditTool(cwd, opts.edit);
		case "write":
			return createWriteTool(cwd, opts.write);
		case "grep":
			return createGrepTool(cwd, opts.grep);
		case "find":
			return createFindTool(cwd, opts.find);
		case "ls":
			return createLsTool(cwd, opts.ls);
		default:
			throw new Error(`Unknown tool name: ${toolName}`);
	}
}

export function createCodingToolDefinitions(cwd: string, options?: ToolsOptions): ToolDef[] {
	const opts = normalizeToolsOptions(options);
	return [
		createReadToolDefinition(cwd, opts.read),
		createBashToolDefinition(cwd, opts.bash),
		createEditToolDefinition(cwd, opts.edit),
		createWriteToolDefinition(cwd, opts.write),
	];
}

export function createReadOnlyToolDefinitions(cwd: string, options?: ToolsOptions): ToolDef[] {
	const opts = normalizeToolsOptions(options);
	return [
		createReadToolDefinition(cwd, opts.read),
		createGrepToolDefinition(cwd, opts.grep),
		createFindToolDefinition(cwd, opts.find),
		createLsToolDefinition(cwd, opts.ls),
	];
}

export function createAllToolDefinitions(cwd: string, options?: ToolsOptions): Record<ToolName, ToolDef> {
	const opts = normalizeToolsOptions(options);
	return {
		read: createReadToolDefinition(cwd, opts.read),
		bash: createBashToolDefinition(cwd, opts.bash),
		edit: createEditToolDefinition(cwd, opts.edit),
		write: createWriteToolDefinition(cwd, opts.write),
		grep: createGrepToolDefinition(cwd, opts.grep),
		find: createFindToolDefinition(cwd, opts.find),
		ls: createLsToolDefinition(cwd, opts.ls),
	};
}

export function createCodingTools(cwd: string, options?: ToolsOptions): Tool[] {
	const opts = normalizeToolsOptions(options);
	return [
		createReadTool(cwd, opts.read),
		createBashTool(cwd, opts.bash),
		createEditTool(cwd, opts.edit),
		createWriteTool(cwd, opts.write),
	];
}

export function createReadOnlyTools(cwd: string, options?: ToolsOptions): Tool[] {
	const opts = normalizeToolsOptions(options);
	return [
		createReadTool(cwd, opts.read),
		createGrepTool(cwd, opts.grep),
		createFindTool(cwd, opts.find),
		createLsTool(cwd, opts.ls),
	];
}

export function createAllTools(cwd: string, options?: ToolsOptions): Record<ToolName, Tool> {
	const opts = normalizeToolsOptions(options);
	return {
		read: createReadTool(cwd, opts.read),
		bash: createBashTool(cwd, opts.bash),
		edit: createEditTool(cwd, opts.edit),
		write: createWriteTool(cwd, opts.write),
		grep: createGrepTool(cwd, opts.grep),
		find: createFindTool(cwd, opts.find),
		ls: createLsTool(cwd, opts.ls),
	};
}
