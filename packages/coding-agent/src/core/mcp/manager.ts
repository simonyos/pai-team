/**
 * MCP manager (Wave 2.1).
 *
 * Owns the set of MCP server connections for a session: it connects every configured
 * server (concurrently, fail-soft — one bad server never blocks the others or startup),
 * aggregates their tools into pi {@link ToolDefinition}s, and closes every connection on
 * dispose.
 *
 * Connections open concurrently, but tool definitions are merged sequentially against a
 * single `seen` set so the fully-qualified `mcp__<server>__<tool>` names are deduplicated
 * deterministically without racing.
 */

import type { ToolDefinition } from "../extensions/types.ts";
import { type McpClientFactory, McpConnection, type McpToolInfo } from "./client.ts";
import { buildMcpToolName } from "./naming.ts";
import { mcpToolToDefinition } from "./tool-adapter.ts";
import type { McpServerConfig, McpServers } from "./types.ts";

export interface McpManagerOptions {
	/** Server name to configuration map (the `mcpServers` block from settings). */
	servers: McpServers;
	/** Test/override seam for building SDK clients. Defaults to the real SDK. */
	createClient?: McpClientFactory;
	/** Per-server connect timeout in ms. */
	connectTimeoutMs?: number;
	/** Invoked with a human-readable message when a server fails or a tool is skipped. */
	onWarning?: (message: string) => void;
}

/** Post-connect status for one configured server. */
export interface McpConnectionStatus {
	name: string;
	connected: boolean;
	toolCount: number;
	error?: string;
}

interface OpenedServer {
	name: string;
	connection: McpConnection;
	tools: McpToolInfo[];
}

export class McpManager {
	private readonly servers: McpServers;
	private readonly createClient: McpClientFactory | undefined;
	private readonly connectTimeoutMs: number | undefined;
	private readonly onWarning: (message: string) => void;
	private readonly connections: McpConnection[] = [];
	private readonly toolDefinitions: ToolDefinition[] = [];
	private readonly statuses: McpConnectionStatus[] = [];
	private connectStarted = false;

	constructor(options: McpManagerOptions) {
		this.servers = options.servers;
		this.createClient = options.createClient;
		this.connectTimeoutMs = options.connectTimeoutMs;
		this.onWarning = options.onWarning ?? (() => {});
	}

	/** Connect all configured servers and build their tool definitions. Idempotent. */
	async connect(): Promise<void> {
		if (this.connectStarted) {
			return;
		}
		this.connectStarted = true;

		const entries = Object.entries(this.servers);
		const opened = await Promise.all(entries.map(([name, config]) => this.openServer(name, config)));

		const seen = new Set<string>();
		for (const result of opened) {
			if (!result) {
				continue;
			}
			this.connections.push(result.connection);
			let added = 0;
			for (const tool of result.tools) {
				const fullName = buildMcpToolName(result.name, tool.name);
				if (seen.has(fullName)) {
					this.onWarning(
						`MCP tool name collision: "${fullName}" (server "${result.name}", tool "${tool.name}") already registered; skipping.`,
					);
					continue;
				}
				seen.add(fullName);
				this.toolDefinitions.push(mcpToolToDefinition(result.name, tool, result.connection));
				added++;
			}
			this.statuses.push({ name: result.name, connected: true, toolCount: added });
		}
	}

	private async openServer(name: string, config: McpServerConfig): Promise<OpenedServer | null> {
		const connection = new McpConnection({
			name,
			config,
			createClient: this.createClient,
			connectTimeoutMs: this.connectTimeoutMs,
		});
		try {
			await connection.connect();
			const tools = await connection.listTools();
			return { name, connection, tools };
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.onWarning(`MCP server "${name}" failed to connect: ${message}`);
			this.statuses.push({ name, connected: false, toolCount: 0, error: message });
			try {
				await connection.close();
			} catch {
				// Best-effort cleanup of a half-open connection.
			}
			return null;
		}
	}

	/** All tool definitions discovered across every connected server. */
	getToolDefinitions(): ToolDefinition[] {
		return this.toolDefinitions;
	}

	/** Per-server connection status (for diagnostics / a future `/mcp` command). */
	getStatuses(): McpConnectionStatus[] {
		return this.statuses;
	}

	/** Close every connection. Best-effort and safe to call more than once. */
	async dispose(): Promise<void> {
		const connections = this.connections.splice(0, this.connections.length);
		await Promise.all(
			connections.map((connection) =>
				connection.close().catch(() => {
					// Best-effort teardown; a failed close must not block disposing the rest.
				}),
			),
		);
	}
}
