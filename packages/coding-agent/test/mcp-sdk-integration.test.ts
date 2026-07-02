import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { McpClientFactory, McpClientLike } from "../src/core/mcp/client.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

/** A fake client factory that serves one read-only tool and records closed connections. */
function fakeFactory(closed: string[]): McpClientFactory {
	return async (name) => {
		const client: McpClientLike = {
			async connect() {},
			async listTools() {
				return {
					tools: [
						{
							name: "ping",
							description: "Ping the server",
							inputSchema: { type: "object" },
							annotations: { readOnlyHint: true },
						},
					],
				};
			},
			async callTool() {
				return { content: [{ type: "text", text: "pong" }] };
			},
			async close() {
				closed.push(name);
			},
		};
		return { client, transport: {} };
	};
}

describe("createAgentSession with mcpServers", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-mcp-sdk-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("registers discovered MCP tools and closes connections on dispose", async () => {
		const closed: string[] = [];
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory();
		const resourceLoader = new DefaultResourceLoader({ cwd: tempDir, agentDir, settingsManager });
		await resourceLoader.reload();

		const { session, mcpManager } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager,
			resourceLoader,
			mcpServers: { demo: { command: "x" } },
			mcpClientFactory: fakeFactory(closed),
		});

		const tool = session.getAllTools().find((t) => t.name === "mcp__demo__ping");
		expect(tool).toBeDefined();
		expect(tool?.sourceInfo).toMatchObject({ source: "sdk" });
		expect(mcpManager?.getStatuses()).toEqual([{ name: "demo", connected: true, toolCount: 1 }]);

		session.dispose();
		// onDispose runs detached; allow the microtask/timer queue to flush.
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(closed).toEqual(["demo"]);
	});

	it("does nothing when mcpServers is empty (behavior-preserving)", async () => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory();
		const resourceLoader = new DefaultResourceLoader({ cwd: tempDir, agentDir, settingsManager });
		await resourceLoader.reload();

		const { session, mcpManager } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager,
			resourceLoader,
			mcpServers: {},
			mcpClientFactory: fakeFactory([]),
		});

		expect(mcpManager).toBeUndefined();
		expect(session.getAllTools().some((t) => t.name.startsWith("mcp__"))).toBe(false);
		session.dispose();
	});
});
