import { describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import type { McpCallResult, McpConnection } from "../src/core/mcp/client.ts";
import { mcpInputSchemaToTypeBox, mcpToolToDefinition } from "../src/core/mcp/tool-adapter.ts";

/** A structural stand-in for McpConnection that records the last call and returns a fixed result. */
function fakeConnection(result: McpCallResult): {
	connection: McpConnection;
	calls: Array<{ toolName: string; args: Record<string, unknown> }>;
} {
	const calls: Array<{ toolName: string; args: Record<string, unknown> }> = [];
	const connection = {
		name: "srv",
		async callTool(toolName: string, args: Record<string, unknown>): Promise<McpCallResult> {
			calls.push({ toolName, args });
			return result;
		},
	} as unknown as McpConnection;
	return { connection, calls };
}

const ctx = {} as ExtensionContext;

describe("mcpInputSchemaToTypeBox", () => {
	it("passes an object schema through unchanged", () => {
		const schema = { type: "object", properties: { x: { type: "string" } }, required: ["x"] };
		const result = mcpInputSchemaToTypeBox(schema) as Record<string, unknown>;
		expect(result.type).toBe("object");
		expect(result.properties).toEqual({ x: { type: "string" } });
		expect(result.required).toEqual(["x"]);
	});

	it("adds a top-level object type when the schema omits it", () => {
		const result = mcpInputSchemaToTypeBox({ properties: {} }) as Record<string, unknown>;
		expect(result.type).toBe("object");
	});

	it("falls back to an empty object schema for non-object input", () => {
		expect((mcpInputSchemaToTypeBox(undefined) as Record<string, unknown>).type).toBe("object");
		expect((mcpInputSchemaToTypeBox(null) as Record<string, unknown>).type).toBe("object");
		expect((mcpInputSchemaToTypeBox([1, 2]) as Record<string, unknown>).type).toBe("object");
	});
});

describe("mcpToolToDefinition", () => {
	const tool = {
		name: "query",
		description: "Run a query",
		inputSchema: { type: "object", properties: { q: { type: "string" } } },
		readOnly: true,
	};

	it("namespaces the tool and carries metadata", () => {
		const { connection } = fakeConnection({ content: [], isError: false });
		const def = mcpToolToDefinition("grafana", tool, connection);
		expect(def.name).toBe("mcp__grafana__query");
		expect(def.label).toBe("grafana: query");
		expect(def.description).toBe("Run a query");
		expect(def.isReadOnly).toBe(true);
	});

	it("uses a title when present and defaults description when missing", () => {
		const { connection } = fakeConnection({ content: [], isError: false });
		const def = mcpToolToDefinition(
			"srv",
			{ name: "t", title: "My Tool", inputSchema: {}, readOnly: false },
			connection,
		);
		expect(def.label).toBe("My Tool");
		expect(def.description).toContain('Tool "t"');
		expect(def.isReadOnly).toBe(false);
	});

	it("forwards the original tool name and arguments on execute and maps content", async () => {
		const { connection, calls } = fakeConnection({
			content: [{ type: "text", text: "hello" }],
			isError: false,
		});
		const def = mcpToolToDefinition("grafana", tool, connection);
		const result = await def.execute("call-1", { q: "up" }, undefined, undefined, ctx);
		expect(calls).toEqual([{ toolName: "query", args: { q: "up" } }]);
		expect(result.content).toEqual([{ type: "text", text: "hello" }]);
		expect(result.details).toEqual({ server: "grafana", tool: "query" });
	});

	it("returns a placeholder when the tool produces no content", async () => {
		const { connection } = fakeConnection({ content: [], isError: false });
		const def = mcpToolToDefinition("grafana", tool, connection);
		const result = await def.execute("call-1", {}, undefined, undefined, ctx);
		expect(result.content).toEqual([{ type: "text", text: "(no output)" }]);
	});

	it("throws with the error text when the tool result is an error", async () => {
		const { connection } = fakeConnection({
			content: [{ type: "text", text: "boom: bad query" }],
			isError: true,
		});
		const def = mcpToolToDefinition("grafana", tool, connection);
		await expect(def.execute("call-1", {}, undefined, undefined, ctx)).rejects.toThrow("boom: bad query");
	});

	it("throws a generic error when an error result has no text", async () => {
		const { connection } = fakeConnection({ content: [], isError: true });
		const def = mcpToolToDefinition("grafana", tool, connection);
		await expect(def.execute("call-1", {}, undefined, undefined, ctx)).rejects.toThrow(/returned an error/);
	});
});
