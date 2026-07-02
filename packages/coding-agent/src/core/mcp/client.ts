/**
 * MCP client connection (Wave 2.1).
 *
 * Wraps one connection to a single MCP server: it owns the SDK `Client` + transport,
 * lists the server's tools, forwards tool calls, and closes the connection on teardown.
 *
 * The SDK is imported dynamically inside {@link defaultMcpClientFactory} so a pi startup
 * with no `mcpServers` configured never loads it. The factory is also the test seam:
 * callers (and tests) can inject a fake client to avoid spawning real subprocesses.
 *
 * The connection is typed against the local structural {@link McpClientLike} interface
 * rather than the SDK's Zod-inferred types, so this module has no compile-time coupling
 * to the SDK's exact type exports.
 */

import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { isStdioServerConfig, type McpServerConfig } from "./types.ts";

/** Client identity reported to MCP servers on connect. */
const MCP_CLIENT_INFO = { name: "pi", version: "0.1.0" };

/** Default per-server connect timeout. A hung/slow server must not stall pi startup. */
export const DEFAULT_MCP_CONNECT_TIMEOUT_MS = 30_000;

/** A single content block as returned by an MCP tool call. */
export interface McpContentBlock {
	type: string;
	text?: string;
	data?: string;
	mimeType?: string;
	resource?: { text?: string; uri?: string; mimeType?: string };
	[key: string]: unknown;
}

/** Result of an MCP `tools/call`. */
export interface McpCallToolResult {
	content?: McpContentBlock[];
	isError?: boolean;
	[key: string]: unknown;
}

/** A tool as advertised by an MCP server (`tools/list`). */
export interface McpToolShape {
	name: string;
	title?: string;
	description?: string;
	inputSchema?: unknown;
	annotations?: { readOnlyHint?: boolean; title?: string };
}

/** Minimal structural view of the SDK `Client` this module depends on. */
export interface McpClientLike {
	connect(transport: unknown, options?: unknown): Promise<void>;
	listTools(params?: unknown, options?: unknown): Promise<{ tools: McpToolShape[] }>;
	callTool(
		params: { name: string; arguments?: Record<string, unknown> },
		resultSchema?: unknown,
		options?: { signal?: AbortSignal; timeout?: number },
	): Promise<McpCallToolResult>;
	close(): Promise<void>;
}

/** A connected SDK client plus the transport it owns. */
export interface McpClientBundle {
	client: McpClientLike;
	transport: unknown;
}

/**
 * Builds (but does not connect) an SDK client + transport for `config`. Injectable so
 * tests can substitute a fake client. `connect()` is called by the connection.
 */
export type McpClientFactory = (serverName: string, config: McpServerConfig) => Promise<McpClientBundle>;

/** Normalized tool metadata, decoupled from the SDK shape. */
export interface McpToolInfo {
	/** Original tool name as registered on the server (used when calling it back). */
	name: string;
	title?: string;
	description?: string;
	/** Raw JSON Schema for the tool's input, as provided by the server. */
	inputSchema: unknown;
	/** True when the server hints the tool only reads state (`annotations.readOnlyHint`). */
	readOnly: boolean;
}

/** Normalized tool-call result: content mapped to pi's model content blocks. */
export interface McpCallResult {
	content: (TextContent | ImageContent)[];
	isError: boolean;
}

/** The real SDK-backed factory. Dynamically imports the SDK so it is only loaded when used. */
export const defaultMcpClientFactory: McpClientFactory = async (_serverName, config) => {
	const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
	const client = new Client(MCP_CLIENT_INFO, { capabilities: {} }) as unknown as McpClientLike;
	const transport = await createTransport(config);
	return { client, transport };
};

async function createTransport(config: McpServerConfig): Promise<unknown> {
	if (isStdioServerConfig(config)) {
		const { StdioClientTransport, getDefaultEnvironment } = await import("@modelcontextprotocol/sdk/client/stdio.js");
		// Start from the SDK's safe default env (which excludes the parent's secrets) and
		// layer any explicitly-configured vars on top. `stderr: "ignore"` keeps a chatty
		// server from corrupting pi's TUI rendering.
		const env = config.env ? { ...getDefaultEnvironment(), ...config.env } : undefined;
		return new StdioClientTransport({
			command: config.command,
			args: config.args ?? [],
			env,
			cwd: config.cwd,
			stderr: "ignore",
		});
	}

	const url = new URL(config.url);
	const requestInit = config.headers ? { headers: config.headers } : undefined;
	if (config.type === "sse") {
		const { SSEClientTransport } = await import("@modelcontextprotocol/sdk/client/sse.js");
		return new SSEClientTransport(url, requestInit ? { requestInit } : undefined);
	}
	const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
	return new StreamableHTTPClientTransport(url, requestInit ? { requestInit } : undefined);
}

/** Map MCP content blocks to pi's model content, with text fallbacks for non-text/image blocks. */
export function mapMcpContent(blocks: McpContentBlock[] | undefined): (TextContent | ImageContent)[] {
	if (!blocks || blocks.length === 0) {
		return [];
	}
	const out: (TextContent | ImageContent)[] = [];
	for (const block of blocks) {
		if (block.type === "text") {
			out.push({ type: "text", text: block.text ?? "" });
		} else if (block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") {
			out.push({ type: "image", data: block.data, mimeType: block.mimeType });
		} else if (block.type === "resource" && typeof block.resource?.text === "string") {
			out.push({ type: "text", text: block.resource.text });
		} else {
			out.push({ type: "text", text: `[unsupported MCP content: ${block.type}]` });
		}
	}
	return out;
}

/** Await `promise`, rejecting with `message` if it does not settle within `timeoutMs`. */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
	if (timeoutMs <= 0) {
		return promise;
	}
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(err) => {
				clearTimeout(timer);
				reject(err);
			},
		);
	});
}

export interface McpConnectionOptions {
	/** pi-facing server name (the `<server>` in `mcp__<server>__<tool>`). */
	name: string;
	config: McpServerConfig;
	/** Test/override seam for building the SDK client. Defaults to the real SDK. */
	createClient?: McpClientFactory;
	/** Per-connect timeout in ms. Defaults to {@link DEFAULT_MCP_CONNECT_TIMEOUT_MS}. */
	connectTimeoutMs?: number;
}

/** One live connection to a single MCP server. */
export class McpConnection {
	readonly name: string;
	private readonly config: McpServerConfig;
	private readonly factory: McpClientFactory;
	private readonly connectTimeoutMs: number;
	private client: McpClientLike | undefined;

	constructor(options: McpConnectionOptions) {
		this.name = options.name;
		this.config = options.config;
		this.factory = options.createClient ?? defaultMcpClientFactory;
		this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_MCP_CONNECT_TIMEOUT_MS;
	}

	/** Build the client, open the transport, and run the MCP initialize handshake. */
	async connect(): Promise<void> {
		const { client, transport } = await this.factory(this.name, this.config);
		try {
			await withTimeout(
				client.connect(transport),
				this.connectTimeoutMs,
				`MCP server "${this.name}" did not respond within ${this.connectTimeoutMs}ms`,
			);
		} catch (err) {
			// On timeout or handshake failure the transport may already have spawned a child
			// process / opened a socket. Close the half-open client so it is not leaked, then
			// rethrow so the manager records the failure. `this.client` stays unset.
			try {
				await client.close();
			} catch {
				// Best-effort: releasing a never-fully-connected client may itself throw.
			}
			throw err;
		}
		this.client = client;
	}

	/** List the server's tools, normalized to {@link McpToolInfo}. */
	async listTools(): Promise<McpToolInfo[]> {
		const client = this.requireClient();
		const { tools } = await client.listTools();
		return tools.map((tool) => ({
			name: tool.name,
			title: tool.title,
			description: tool.description,
			inputSchema: tool.inputSchema,
			readOnly: tool.annotations?.readOnlyHint === true,
		}));
	}

	/** Call `toolName` with `args`, returning content mapped to pi's model content blocks. */
	async callTool(toolName: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallResult> {
		const client = this.requireClient();
		const result = await client.callTool({ name: toolName, arguments: args }, undefined, { signal });
		return { content: mapMcpContent(result.content), isError: result.isError === true };
	}

	/** Close the connection. Safe to call more than once. */
	async close(): Promise<void> {
		const client = this.client;
		this.client = undefined;
		if (client) {
			await client.close();
		}
	}

	private requireClient(): McpClientLike {
		if (!this.client) {
			throw new Error(`MCP server "${this.name}" is not connected`);
		}
		return this.client;
	}
}
