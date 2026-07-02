import { describe, expect, it } from "vitest";
import { buildMcpToolName, isMcpToolName, normalizeMcpName, parseMcpToolName } from "../src/core/mcp/naming.ts";

describe("normalizeMcpName", () => {
	it("keeps the tool-name charset intact", () => {
		expect(normalizeMcpName("query_loki-logs2")).toBe("query_loki-logs2");
	});

	it("replaces disallowed characters with underscores", () => {
		expect(normalizeMcpName("foo.bar/baz")).toBe("foo_bar_baz");
		expect(normalizeMcpName("weird name!")).toBe("weird_name_");
	});
});

describe("buildMcpToolName", () => {
	it("produces the mcp__server__tool shape", () => {
		expect(buildMcpToolName("grafana", "query_prometheus")).toBe("mcp__grafana__query_prometheus");
	});

	it("normalizes both segments", () => {
		expect(buildMcpToolName("my.server", "do/thing")).toBe("mcp__my_server__do_thing");
	});
});

describe("parseMcpToolName", () => {
	it("round-trips a simple name", () => {
		const parsed = parseMcpToolName("mcp__grafana__query_prometheus");
		expect(parsed).toEqual({ serverName: "grafana", toolName: "query_prometheus" });
	});

	it("preserves double underscores in the tool segment", () => {
		const parsed = parseMcpToolName("mcp__srv__weird__tool__name");
		expect(parsed).toEqual({ serverName: "srv", toolName: "weird__tool__name" });
	});

	it("returns null for non-MCP names", () => {
		expect(parseMcpToolName("bash")).toBeNull();
		expect(parseMcpToolName("mcp__server")).toBeNull(); // no tool segment
		expect(parseMcpToolName("notmcp__server__tool")).toBeNull();
		expect(parseMcpToolName("")).toBeNull();
	});
});

describe("isMcpToolName", () => {
	it("recognizes fully-qualified MCP tool names", () => {
		expect(isMcpToolName("mcp__server__tool")).toBe(true);
		expect(isMcpToolName("read")).toBe(false);
		expect(isMcpToolName("mcp__onlyserver")).toBe(false);
	});
});
