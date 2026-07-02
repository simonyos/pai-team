/**
 * MCP client (Wave 2.1) — connect to external Model Context Protocol servers and expose
 * their tools as pi tools namespaced `mcp__<server>__<tool>`, gated by the Wave-1
 * permission resolver.
 */

export {
	DEFAULT_MCP_CONNECT_TIMEOUT_MS,
	defaultMcpClientFactory,
	type McpCallResult,
	type McpCallToolResult,
	type McpClientBundle,
	type McpClientFactory,
	type McpClientLike,
	McpConnection,
	type McpConnectionOptions,
	type McpContentBlock,
	type McpToolInfo,
	type McpToolShape,
	mapMcpContent,
} from "./client.ts";
export { type McpConnectionStatus, McpManager, type McpManagerOptions } from "./manager.ts";
export { buildMcpToolName, isMcpToolName, normalizeMcpName, parseMcpToolName } from "./naming.ts";
export { mcpInputSchemaToTypeBox, mcpToolToDefinition } from "./tool-adapter.ts";
export {
	isHttpServerConfig,
	isStdioServerConfig,
	type McpHttpServerConfig,
	type McpServerConfig,
	type McpServers,
	type McpStdioServerConfig,
} from "./types.ts";
