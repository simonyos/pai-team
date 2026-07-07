import { type Dirent, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { CONFIG_DIR_NAME, getAgentDir } from "../config.ts";
import { parseFrontmatter } from "../utils/frontmatter.ts";
import { canonicalizePath, resolvePath } from "../utils/paths.ts";
import type { ResourceDiagnostic } from "./diagnostics.ts";
import { findExactModelReferenceMatch } from "./model-resolver.ts";
import { createSyntheticSourceInfo, type SourceInfo } from "./source-info.ts";
import { allToolNames } from "./tools/index.ts";

export type AgentDefinitionSource = "project" | "user";

export interface AgentDefinitionFrontmatter {
	name?: string;
	description?: string;
	tools?: string;
	model?: string;
	[key: string]: unknown;
}

/**
 * A declarative agent definition loaded from `.pi/agents/*.md`.
 *
 * Frontmatter provides `name` / `description` / optional `tools` / optional `model`;
 * the markdown body becomes the agent's `systemPrompt`. This is discovery + validation
 * only: the consumer that spawns sub-agents does not exist yet.
 */
export interface AgentDefinition {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	systemPrompt: string;
	filePath: string;
	sourceInfo?: SourceInfo;
	source: AgentDefinitionSource;
}

export interface LoadAgentDefinitionsResult {
	agents: AgentDefinition[];
	diagnostics: ResourceDiagnostic[];
}

export interface LoadAgentDefinitionsOptions {
	/** Working directory for project-local agent definitions (`<cwd>/.pi/agents`). */
	cwd: string;
	/** Agent config directory for user-level agent definitions (`<agentDir>/agents`). */
	agentDir: string;
	/**
	 * Known models used to validate the optional `model` field.
	 * Validation is warn-but-keep; when omitted, `model` is not validated.
	 */
	knownModels?: Model<Api>[];
}

/**
 * Split the comma-separated `tools` frontmatter field into a trimmed list.
 * Frontmatter authors write `tools: read, grep, bash`; tolerate a YAML list too.
 */
function parseToolsField(raw: unknown): string[] | undefined {
	let entries: string[];
	if (typeof raw === "string") {
		entries = raw.split(",");
	} else if (Array.isArray(raw)) {
		entries = raw.map((entry) => String(entry));
	} else {
		return undefined;
	}
	const tools = entries.map((entry) => entry.trim()).filter(Boolean);
	return tools.length > 0 ? tools : undefined;
}

function agentSourceInfo(filePath: string, baseDir: string, source: AgentDefinitionSource): SourceInfo {
	return createSyntheticSourceInfo(filePath, {
		source: "local",
		scope: source,
		baseDir,
	});
}

function loadAgentDefinitionFromFile(
	filePath: string,
	baseDir: string,
	source: AgentDefinitionSource,
	knownModels: Model<Api>[] | undefined,
): { agent: AgentDefinition | null; diagnostics: ResourceDiagnostic[] } {
	const diagnostics: ResourceDiagnostic[] = [];

	let frontmatter: AgentDefinitionFrontmatter;
	let body: string;
	try {
		const rawContent = readFileSync(filePath, "utf-8");
		const parsed = parseFrontmatter<AgentDefinitionFrontmatter>(rawContent);
		frontmatter = parsed.frontmatter;
		body = parsed.body;
	} catch (error) {
		const message = error instanceof Error ? error.message : "failed to parse agent definition file";
		diagnostics.push({ type: "warning", message, path: filePath });
		return { agent: null, diagnostics };
	}

	const name = typeof frontmatter.name === "string" ? frontmatter.name.trim() : "";
	const description = typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";

	if (!name) {
		diagnostics.push({ type: "warning", message: "name is required", path: filePath });
	}
	if (!description) {
		diagnostics.push({ type: "warning", message: "description is required", path: filePath });
	}
	if (!name || !description) {
		return { agent: null, diagnostics };
	}

	const tools = parseToolsField(frontmatter.tools);
	if (tools) {
		for (const tool of tools) {
			if (!(allToolNames as ReadonlySet<string>).has(tool)) {
				diagnostics.push({
					type: "warning",
					message: `tool "${tool}" is not a recognized built-in tool (kept; may resolve at spawn time)`,
					path: filePath,
				});
			}
		}
	}

	const model = typeof frontmatter.model === "string" ? frontmatter.model.trim() : undefined;
	if (model && knownModels && !findExactModelReferenceMatch(model, knownModels)) {
		diagnostics.push({
			type: "warning",
			message: `model "${model}" does not match any known model (kept; may resolve at spawn time)`,
			path: filePath,
		});
	}

	return {
		agent: {
			name,
			description,
			tools,
			model: model || undefined,
			systemPrompt: body,
			filePath,
			sourceInfo: agentSourceInfo(filePath, baseDir, source),
			source,
		},
		diagnostics,
	};
}

function loadAgentDefinitionsFromDir(
	dir: string,
	source: AgentDefinitionSource,
	knownModels: Model<Api>[] | undefined,
): LoadAgentDefinitionsResult {
	const agents: AgentDefinition[] = [];
	const diagnostics: ResourceDiagnostic[] = [];

	if (!existsSync(dir)) {
		return { agents, diagnostics };
	}

	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return { agents, diagnostics };
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;

		const filePath = join(dir, entry.name);

		let isFile = entry.isFile();
		if (entry.isSymbolicLink()) {
			try {
				isFile = statSync(filePath).isFile();
			} catch {
				continue;
			}
		}
		if (!isFile) continue;

		const result = loadAgentDefinitionFromFile(filePath, dir, source, knownModels);
		if (result.agent) {
			agents.push(result.agent);
		}
		diagnostics.push(...result.diagnostics);
	}

	return { agents, diagnostics };
}

/**
 * Load declarative agent definitions from the project (`<cwd>/.pi/agents`) and
 * user (`<agentDir>/agents`) directories. Flat `*.md` files only.
 *
 * Never throws: parse failures and missing required fields are downgraded to
 * warning diagnostics and the offending file is skipped. Definitions are deduped
 * by name with the project definition overriding the user one; each dropped
 * duplicate is reported as a collision diagnostic.
 */
export function loadAgentDefinitions(options: LoadAgentDefinitionsOptions): LoadAgentDefinitionsResult {
	const resolvedCwd = resolvePath(options.cwd);
	const resolvedAgentDir = resolvePath(options.agentDir ?? getAgentDir());
	const knownModels = options.knownModels;

	const projectDir = join(resolvedCwd, CONFIG_DIR_NAME, "agents");
	const userDir = join(resolvedAgentDir, "agents");

	const agentMap = new Map<string, AgentDefinition>();
	const realPathSet = new Set<string>();
	const diagnostics: ResourceDiagnostic[] = [];
	const collisionDiagnostics: ResourceDiagnostic[] = [];

	const addAgents = (result: LoadAgentDefinitionsResult): void => {
		diagnostics.push(...result.diagnostics);
		for (const agent of result.agents) {
			const realPath = canonicalizePath(agent.filePath);
			if (realPathSet.has(realPath)) {
				continue;
			}

			const existing = agentMap.get(agent.name);
			if (existing) {
				collisionDiagnostics.push({
					type: "collision",
					message: `name "${agent.name}" collision`,
					path: agent.filePath,
					collision: {
						resourceType: "agent",
						name: agent.name,
						winnerPath: existing.filePath,
						loserPath: agent.filePath,
					},
				});
			} else {
				agentMap.set(agent.name, agent);
				realPathSet.add(realPath);
			}
		}
	};

	// Project definitions are added first so they win name collisions with user definitions.
	addAgents(loadAgentDefinitionsFromDir(projectDir, "project", knownModels));
	addAgents(loadAgentDefinitionsFromDir(userDir, "user", knownModels));

	return {
		agents: Array.from(agentMap.values()),
		diagnostics: [...diagnostics, ...collisionDiagnostics],
	};
}
