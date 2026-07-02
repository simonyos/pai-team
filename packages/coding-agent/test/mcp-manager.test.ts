import { describe, expect, it } from "vitest";
import type { McpClientFactory, McpClientLike, McpToolShape } from "../src/core/mcp/client.ts";
import { McpManager } from "../src/core/mcp/manager.ts";

interface FakeSpec {
	tools?: McpToolShape[];
	failConnect?: boolean;
}

/** One factory that dispatches by server name, recording which servers were closed. */
function fakeFactory(specs: Record<string, FakeSpec>, closed: string[]): McpClientFactory {
	return async (name) => {
		const spec = specs[name] ?? {};
		const client: McpClientLike = {
			async connect() {
				if (spec.failConnect) {
					throw new Error(`connect failed for ${name}`);
				}
			},
			async listTools() {
				return { tools: spec.tools ?? [] };
			},
			async callTool() {
				return { content: [{ type: "text", text: "ok" }] };
			},
			async close() {
				closed.push(name);
			},
		};
		return { client, transport: {} };
	};
}

describe("McpManager", () => {
	it("aggregates namespaced tools from every connected server", async () => {
		const closed: string[] = [];
		const manager = new McpManager({
			servers: { alpha: { command: "a" }, beta: { command: "b" } },
			createClient: fakeFactory(
				{
					alpha: { tools: [{ name: "one" }, { name: "two" }] },
					beta: { tools: [{ name: "three" }] },
				},
				closed,
			),
		});
		await manager.connect();
		const names = manager
			.getToolDefinitions()
			.map((d) => d.name)
			.sort();
		expect(names).toEqual(["mcp__alpha__one", "mcp__alpha__two", "mcp__beta__three"]);
	});

	it("is fail-soft: a server that cannot connect is skipped with a warning", async () => {
		const closed: string[] = [];
		const warnings: string[] = [];
		const manager = new McpManager({
			servers: { good: { command: "g" }, bad: { command: "b" } },
			createClient: fakeFactory({ good: { tools: [{ name: "ok" }] }, bad: { failConnect: true } }, closed),
			onWarning: (m) => warnings.push(m),
		});
		await manager.connect();
		expect(manager.getToolDefinitions().map((d) => d.name)).toEqual(["mcp__good__ok"]);
		expect(warnings.some((w) => w.includes('"bad"') && w.includes("failed to connect"))).toBe(true);
		const statuses = manager.getStatuses();
		expect(statuses.find((s) => s.name === "good")).toMatchObject({ connected: true, toolCount: 1 });
		expect(statuses.find((s) => s.name === "bad")).toMatchObject({ connected: false, toolCount: 0 });
	});

	it("deduplicates tools that collide after normalization within a server", async () => {
		const closed: string[] = [];
		const warnings: string[] = [];
		const manager = new McpManager({
			servers: { srv: { command: "s" } },
			// "a.b" and "a/b" both normalize to "a_b" -> same fully-qualified name.
			createClient: fakeFactory({ srv: { tools: [{ name: "a.b" }, { name: "a/b" }] } }, closed),
			onWarning: (m) => warnings.push(m),
		});
		await manager.connect();
		expect(manager.getToolDefinitions().map((d) => d.name)).toEqual(["mcp__srv__a_b"]);
		expect(warnings.some((w) => w.includes("collision"))).toBe(true);
	});

	it("closes every connected server on dispose", async () => {
		const closed: string[] = [];
		const manager = new McpManager({
			servers: { alpha: { command: "a" }, beta: { command: "b" } },
			createClient: fakeFactory({ alpha: { tools: [] }, beta: { tools: [] } }, closed),
		});
		await manager.connect();
		await manager.dispose();
		expect(closed.sort()).toEqual(["alpha", "beta"]);
		// Idempotent: a second dispose closes nothing further.
		await manager.dispose();
		expect(closed.sort()).toEqual(["alpha", "beta"]);
	});

	it("connect() is idempotent", async () => {
		const closed: string[] = [];
		const manager = new McpManager({
			servers: { alpha: { command: "a" } },
			createClient: fakeFactory({ alpha: { tools: [{ name: "one" }] } }, closed),
		});
		await manager.connect();
		await manager.connect();
		expect(manager.getToolDefinitions().map((d) => d.name)).toEqual(["mcp__alpha__one"]);
	});
});
