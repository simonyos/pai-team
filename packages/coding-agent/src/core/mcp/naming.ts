/**
 * MCP tool-name namespacing (Wave 2.1).
 *
 * A tool discovered on an MCP server is surfaced to the agent (and the LLM) under a
 * fully-qualified name `mcp__<server>__<tool>` so that (a) tools from different servers
 * never collide, (b) MCP tools never shadow a built-in tool name, and (c) the Wave-1
 * permission resolver can write allow/deny rules keyed on the exact server+tool pair.
 *
 * Server and tool segments are normalized to the `[A-Za-z0-9_-]` charset the LLM tool
 * schema allows. The ORIGINAL (un-normalized) tool name is what gets sent back to the
 * server on a call — the fully-qualified name is only ever a pi-facing identifier, so
 * normalization does not need to be reversible.
 */

const MCP_PREFIX = "mcp";
const SEPARATOR = "__";

/** Reduce an arbitrary server/tool name to the charset permitted in a tool identifier. */
export function normalizeMcpName(name: string): string {
	return name.replace(/[^A-Za-z0-9_-]/g, "_");
}

/** Build the pi-facing `mcp__<server>__<tool>` identifier from raw server and tool names. */
export function buildMcpToolName(serverName: string, toolName: string): string {
	return `${MCP_PREFIX}${SEPARATOR}${normalizeMcpName(serverName)}${SEPARATOR}${normalizeMcpName(toolName)}`;
}

/**
 * Parse a fully-qualified MCP tool name back into its (normalized) server and tool parts.
 * Returns null when `fullName` is not an MCP tool identifier.
 *
 * The tool segment is re-joined on `__` so tool names that themselves contain `__`
 * survive; a server name containing `__` cannot be recovered (documented limitation),
 * which is why normalization collapses nothing here.
 */
export function parseMcpToolName(fullName: string): { serverName: string; toolName: string } | null {
	const parts = fullName.split(SEPARATOR);
	const [prefix, serverName, ...toolParts] = parts;
	if (prefix !== MCP_PREFIX || !serverName || toolParts.length === 0) {
		return null;
	}
	return { serverName, toolName: toolParts.join(SEPARATOR) };
}

/** True when `name` is a fully-qualified MCP tool identifier. */
export function isMcpToolName(name: string): boolean {
	return parseMcpToolName(name) !== null;
}
