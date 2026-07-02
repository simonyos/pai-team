/**
 * Adapt an MCP tool into a pi {@link ToolDefinition} (Wave 2.1).
 *
 * The resulting definition is namespaced `mcp__<server>__<tool>`, exposes the server's
 * JSON Schema as its parameters (via TypeBox `Type.Unsafe`, no conversion), and forwards
 * calls to the live {@link McpConnection}. It sets `isReadOnly` from the server's
 * `readOnlyHint` so read-only MCP tools auto-allow under the Wave-1 resolver and are
 * permitted in plan mode; every other MCP tool defaults to "ask".
 *
 * Errors follow pi's tool contract: a tool that fails throws (so the runtime flags the
 * result as an error) rather than encoding the error into returned content.
 */

import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { type TSchema, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import type { McpConnection, McpToolInfo } from "./client.ts";
import { buildMcpToolName } from "./naming.ts";

/**
 * Wrap an MCP tool's JSON Schema as a TypeBox schema. MCP input schemas are already
 * JSON Schema objects, so `Type.Unsafe` passes them through unchanged; we only ensure a
 * top-level `type: "object"` is present for providers that require an object schema.
 */
export function mcpInputSchemaToTypeBox(schema: unknown): TSchema {
	if (schema && typeof schema === "object" && !Array.isArray(schema)) {
		const record = schema as Record<string, unknown>;
		const withType = record.type === undefined ? { ...record, type: "object" } : record;
		return Type.Unsafe<Record<string, unknown>>(withType);
	}
	return Type.Object({});
}

/** First non-empty text block in mapped model content, or "" when there is none. */
function firstText(content: (TextContent | ImageContent)[]): string {
	for (const block of content) {
		if (block.type === "text" && block.text) {
			return block.text;
		}
	}
	return "";
}

/** Build a pi {@link ToolDefinition} that proxies to `tool` on the given `connection`. */
export function mcpToolToDefinition(serverName: string, tool: McpToolInfo, connection: McpConnection): ToolDefinition {
	const fullName = buildMcpToolName(serverName, tool.name);
	const parameters = mcpInputSchemaToTypeBox(tool.inputSchema);
	const description = tool.description?.trim() || `Tool "${tool.name}" provided by MCP server "${serverName}".`;
	const label = tool.title?.trim() || `${serverName}: ${tool.name}`;

	return {
		name: fullName,
		label,
		description,
		parameters,
		isReadOnly: tool.readOnly,
		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			const args = (params ?? {}) as Record<string, unknown>;
			const result = await connection.callTool(tool.name, args, signal);
			if (result.isError) {
				const text = firstText(result.content);
				throw new Error(text || `MCP tool "${tool.name}" on server "${serverName}" returned an error.`);
			}
			if (result.content.length > 0) {
				return { content: result.content, details: { server: serverName, tool: tool.name } };
			}
			const empty: TextContent[] = [{ type: "text", text: "(no output)" }];
			return { content: empty, details: { server: serverName, tool: tool.name } };
		},
	};
}
