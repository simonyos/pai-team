import { describe, expect, it } from "vitest";
import {
	type McpCallToolResult,
	type McpClientFactory,
	type McpClientLike,
	McpConnection,
	type McpContentBlock,
	type McpToolShape,
	mapMcpContent,
} from "../src/core/mcp/client.ts";

interface FakeSpec {
	tools?: McpToolShape[];
	failConnect?: boolean;
	hangConnect?: boolean;
	callResult?: McpCallToolResult;
	onClose?: () => void;
	onCall?: (params: { name: string; arguments?: Record<string, unknown>; signal?: AbortSignal }) => void;
}

function fakeFactory(spec: FakeSpec): McpClientFactory {
	return async () => {
		const client: McpClientLike = {
			async connect() {
				if (spec.failConnect) throw new Error("connect failed");
				if (spec.hangConnect) await new Promise<void>(() => {});
			},
			async listTools() {
				return { tools: spec.tools ?? [] };
			},
			async callTool(params, _schema, options) {
				spec.onCall?.({ ...params, signal: options?.signal });
				return spec.callResult ?? { content: [{ type: "text", text: "ok" }] };
			},
			async close() {
				spec.onClose?.();
			},
		};
		return { client, transport: {} };
	};
}

describe("McpConnection", () => {
	it("lists tools normalized with readOnly from readOnlyHint", async () => {
		const conn = new McpConnection({
			name: "srv",
			config: { command: "x" },
			createClient: fakeFactory({
				tools: [
					{ name: "a", description: "A", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
					{ name: "b" },
				],
			}),
		});
		await conn.connect();
		const tools = await conn.listTools();
		expect(tools).toEqual([
			{ name: "a", title: undefined, description: "A", inputSchema: { type: "object" }, readOnly: true },
			{ name: "b", title: undefined, description: undefined, inputSchema: undefined, readOnly: false },
		]);
	});

	it("forwards the abort signal and maps error results", async () => {
		let seenSignal: AbortSignal | undefined;
		const controller = new AbortController();
		const conn = new McpConnection({
			name: "srv",
			config: { command: "x" },
			createClient: fakeFactory({
				callResult: { content: [{ type: "text", text: "bad" }], isError: true },
				onCall: (p) => {
					seenSignal = p.signal;
				},
			}),
		});
		await conn.connect();
		const result = await conn.callTool("a", { k: 1 }, controller.signal);
		expect(seenSignal).toBe(controller.signal);
		expect(result.isError).toBe(true);
		expect(result.content).toEqual([{ type: "text", text: "bad" }]);
	});

	it("rejects and does not hang when connect exceeds the timeout", async () => {
		const conn = new McpConnection({
			name: "slow",
			config: { command: "x" },
			createClient: fakeFactory({ hangConnect: true }),
			connectTimeoutMs: 20,
		});
		await expect(conn.connect()).rejects.toThrow(/did not respond within 20ms/);
	});

	it("closes the half-open client when connect times out", async () => {
		let closed = 0;
		const conn = new McpConnection({
			name: "slow",
			config: { command: "x" },
			createClient: fakeFactory({ hangConnect: true, onClose: () => closed++ }),
			connectTimeoutMs: 20,
		});
		await expect(conn.connect()).rejects.toThrow(/did not respond/);
		expect(closed).toBe(1);
	});

	it("closes the client when connect throws", async () => {
		let closed = 0;
		const conn = new McpConnection({
			name: "bad",
			config: { command: "x" },
			createClient: fakeFactory({ failConnect: true, onClose: () => closed++ }),
		});
		await expect(conn.connect()).rejects.toThrow(/connect failed/);
		expect(closed).toBe(1);
	});

	it("throws when calling before connect", async () => {
		const conn = new McpConnection({ name: "srv", config: { command: "x" }, createClient: fakeFactory({}) });
		await expect(conn.callTool("a", {})).rejects.toThrow(/not connected/);
	});

	it("closes the underlying client", async () => {
		let closed = 0;
		const conn = new McpConnection({
			name: "srv",
			config: { command: "x" },
			createClient: fakeFactory({ onClose: () => closed++ }),
		});
		await conn.connect();
		await conn.close();
		await conn.close(); // idempotent
		expect(closed).toBe(1);
	});
});

describe("mapMcpContent", () => {
	it("maps text and image blocks", () => {
		const blocks: McpContentBlock[] = [
			{ type: "text", text: "hi" },
			{ type: "image", data: "AAAA", mimeType: "image/png" },
		];
		expect(mapMcpContent(blocks)).toEqual([
			{ type: "text", text: "hi" },
			{ type: "image", data: "AAAA", mimeType: "image/png" },
		]);
	});

	it("extracts embedded resource text", () => {
		const blocks: McpContentBlock[] = [{ type: "resource", resource: { text: "file body", uri: "file:///x" } }];
		expect(mapMcpContent(blocks)).toEqual([{ type: "text", text: "file body" }]);
	});

	it("renders a placeholder for unsupported blocks", () => {
		expect(mapMcpContent([{ type: "audio", data: "AAAA", mimeType: "audio/wav" }])).toEqual([
			{ type: "text", text: "[unsupported MCP content: audio]" },
		]);
	});

	it("returns an empty array for empty or missing content", () => {
		expect(mapMcpContent([])).toEqual([]);
		expect(mapMcpContent(undefined)).toEqual([]);
	});
});
