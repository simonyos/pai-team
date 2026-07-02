/**
 * MCP server configuration (Wave 2.1).
 *
 * A server is either spawned as a child process over stdio (`command`) or reached over
 * HTTP (`url`). The `type` discriminator is optional: when omitted it is inferred from
 * whether `command` or `url` is present, so a minimal config is just `{ command: "..." }`
 * or `{ url: "..." }`.
 */

/** A stdio MCP server: pi spawns `command` and speaks MCP over its stdin/stdout. */
export interface McpStdioServerConfig {
	type?: "stdio";
	/** Executable to spawn. */
	command: string;
	/** Arguments passed to the executable. */
	args?: string[];
	/**
	 * Extra environment variables for the child, merged over the SDK's safe default
	 * environment. The default environment deliberately excludes the parent's secrets,
	 * so pi's model-provider credentials are never forwarded to an MCP server.
	 */
	env?: Record<string, string>;
	/** Working directory for the child process. */
	cwd?: string;
}

/** An HTTP MCP server reached over Streamable HTTP (default) or legacy SSE. */
export interface McpHttpServerConfig {
	type?: "http" | "sse";
	/** Server endpoint URL. */
	url: string;
	/** Extra HTTP headers sent on every request (e.g. `Authorization`). */
	headers?: Record<string, string>;
}

/** Configuration for a single MCP server. */
export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;

/** A map of server name to its configuration, as it appears under `mcpServers` in settings. */
export type McpServers = Record<string, McpServerConfig>;

/** True when `config` describes a stdio server (has a `command`). */
export function isStdioServerConfig(config: McpServerConfig): config is McpStdioServerConfig {
	return typeof (config as McpStdioServerConfig).command === "string";
}

/** True when `config` describes an HTTP/SSE server (has a `url`). */
export function isHttpServerConfig(config: McpServerConfig): config is McpHttpServerConfig {
	return typeof (config as McpHttpServerConfig).url === "string";
}
