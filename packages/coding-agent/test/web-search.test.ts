import { describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import {
	createWebSearchToolDefinition,
	type WebSearchOperations,
	type WebSearchToolDetails,
} from "../src/core/tools/web-search.ts";

interface RunOptions {
	fetchImpl?: WebSearchOperations["fetch"];
	toolOptions?: Parameters<typeof createWebSearchToolDefinition>[0];
	signal?: AbortSignal;
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
	return new Response(JSON.stringify(body), {
		...init,
		headers: { "content-type": "application/json", ...init?.headers },
	});
}

function run(query: string, options: RunOptions = {}) {
	const fetchImpl: WebSearchOperations["fetch"] = options.fetchImpl ?? (async () => jsonResponse({ results: [] }));
	const def = createWebSearchToolDefinition({
		operations: { fetch: fetchImpl },
		...options.toolOptions,
	});
	return def.execute("call-1", { query }, options.signal, undefined, {} as ExtensionContext);
}

function textOf(result: Awaited<ReturnType<typeof run>>): string {
	return result.content.map((c) => ("text" in c ? c.text : "")).join("");
}

describe("web_search permission posture", () => {
	it("is read-only (auto-allowed, usable in plan mode)", () => {
		const def = createWebSearchToolDefinition();
		expect(def.isReadOnly).toBe(true);
	});

	it("advertises a prompt snippet so it lists in Available tools", () => {
		expect(createWebSearchToolDefinition().promptSnippet).toBeTruthy();
	});
});

describe("web_search URL construction", () => {
	it("encodes a hostile query into ?q= and cannot change the host", async () => {
		const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => jsonResponse({ results: [] }));
		const hostile = "foo&engines=x#@evil.com";
		await run(hostile, { fetchImpl, toolOptions: { endpoint: "http://localhost:8888" } });
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		const calledUrl = new URL(fetchImpl.mock.calls[0][0] as string);
		// Host/port and path are fixed by operator config, never influenced by the query.
		expect(calledUrl.host).toBe("localhost:8888");
		expect(calledUrl.hostname).toBe("localhost");
		expect(calledUrl.pathname).toBe("/search");
		// The whole hostile string lands verbatim in q, URL-encoded (fragment/`&` do not split it).
		expect(calledUrl.searchParams.get("q")).toBe(hostile);
		expect(calledUrl.searchParams.get("format")).toBe("json");
		expect(calledUrl.searchParams.get("engines")).toBeNull();
	});

	it("honors a custom endpoint host/port", async () => {
		const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => jsonResponse({ results: [] }));
		await run("hello", { fetchImpl, toolOptions: { endpoint: "http://searx.internal:9999" } });
		const calledUrl = new URL(fetchImpl.mock.calls[0][0] as string);
		expect(calledUrl.host).toBe("searx.internal:9999");
		expect(calledUrl.pathname).toBe("/search");
		expect(calledUrl.searchParams.get("q")).toBe("hello");
	});

	it("preserves a base path on a subpath-hosted endpoint (reverse proxy)", async () => {
		const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => jsonResponse({ results: [] }));
		await run("hello", { fetchImpl, toolOptions: { endpoint: "http://host/searxng" } });
		const calledUrl = new URL(fetchImpl.mock.calls[0][0] as string);
		expect(calledUrl.host).toBe("host");
		// The "/searxng" prefix must survive — not be dropped by an absolute "/search".
		expect(calledUrl.pathname).toBe("/searxng/search");
		expect(calledUrl.searchParams.get("q")).toBe("hello");
	});

	it("sends an application/json Accept header", async () => {
		const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => jsonResponse({ results: [] }));
		await run("hello", { fetchImpl });
		const init = fetchImpl.mock.calls[0][1];
		expect((init.headers as Record<string, string>).accept).toBe("application/json");
	});
});

describe("web_search result formatting", () => {
	it("parses SearXNG JSON and formats results with title/url/snippet", async () => {
		const fetchImpl = async () =>
			jsonResponse({
				results: [
					{
						title: "TypeScript",
						url: "https://www.typescriptlang.org/",
						content: "TypeScript is JavaScript with syntax\nfor types.",
						engine: "google",
					},
				],
			});
		const result = await run("typescript", { fetchImpl });
		const text = textOf(result);
		expect(text).toContain("1. TypeScript");
		expect(text).toContain("https://www.typescriptlang.org/");
		// Snippet is single-lined.
		expect(text).toContain("TypeScript is JavaScript with syntax for types.");
		expect(text).not.toMatch(/syntax\nfor/);
		const details = result.details as WebSearchToolDetails;
		expect(details.query).toBe("typescript");
		expect(details.resultCount).toBe(1);
		expect(details.endpoint).toBe("http://localhost:8888");
	});

	it("caps the number of results to maxResults", async () => {
		const results = Array.from({ length: 20 }, (_, i) => ({
			title: `Result ${i}`,
			url: `https://example.com/${i}`,
			content: `snippet ${i}`,
		}));
		const result = await run("many", {
			fetchImpl: async () => jsonResponse({ results }),
			toolOptions: { maxResults: 3 },
		});
		const text = textOf(result);
		expect(text).toContain("1. Result 0");
		expect(text).toContain("3. Result 2");
		expect(text).not.toContain("4. Result 3");
		expect((result.details as WebSearchToolDetails).resultCount).toBe(3);
	});

	it("handles results with missing title/url/content gracefully", async () => {
		const result = await run("sparse", {
			fetchImpl: async () => jsonResponse({ results: [{ url: "https://example.com/x" }] }),
		});
		const text = textOf(result);
		expect(text).toContain("1. (untitled)");
		expect(text).toContain("https://example.com/x");
	});

	it("does not throw on a non-object entry in the results array", async () => {
		const result = await run("weird", {
			// A stray null / non-object entry must render as "(untitled)", not crash with a TypeError.
			fetchImpl: async () => jsonResponse({ results: [null, { title: "Real", url: "https://e.com" }] }),
		});
		const text = textOf(result);
		expect(text).toContain("1. (untitled)");
		expect(text).toContain("2. Real");
	});

	it("returns an explicit no-results message for an empty results array", async () => {
		const result = await run("nothingmatches", {
			fetchImpl: async () => jsonResponse({ results: [] }),
		});
		expect(textOf(result)).toBe('No results found for "nothingmatches".');
		expect((result.details as WebSearchToolDetails).resultCount).toBe(0);
	});

	it("truncates a large result set and appends a truncation notice", async () => {
		const results = Array.from({ length: 200 }, (_, i) => ({
			title: `Result ${i}`,
			url: `https://example.com/${i}`,
			content: "x".repeat(2000),
		}));
		const result = await run("big", {
			fetchImpl: async () => jsonResponse({ results }),
			toolOptions: { maxResults: 200, maxBytes: 4096 },
		});
		const text = textOf(result);
		expect(text).toMatch(/\[Truncated:/);
		expect((result.details as WebSearchToolDetails).truncation?.truncated).toBe(true);
	});
});

describe("web_search failure handling", () => {
	it("throws an actionable connection-refused error when fetch rejects", async () => {
		await expect(
			run("q", {
				fetchImpl: async () => {
					throw new Error("ECONNREFUSED");
				},
			}),
		).rejects.toThrow(/could not reach SearXNG at http:\/\/localhost:8888 \(connection refused\)/i);
	});

	it("throws a timeout error when the request hangs past the timeout", async () => {
		const fetchImpl: WebSearchOperations["fetch"] = (_url, init) =>
			new Promise((_resolve, reject) => {
				init.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
			});
		await expect(run("q", { fetchImpl, toolOptions: { timeoutMs: 20 } })).rejects.toThrow(
			/web_search timed out after .* contacting http:\/\/localhost:8888/i,
		);
	});

	it("throws immediately when the signal is already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		const fetchSpy = vi.fn();
		await expect(run("q", { fetchImpl: fetchSpy, signal: controller.signal })).rejects.toThrow(/aborted/i);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("aborts when the caller signal fires", async () => {
		const controller = new AbortController();
		const fetchImpl: WebSearchOperations["fetch"] = (_url, init) =>
			new Promise((_resolve, reject) => {
				init.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
			});
		const promise = run("q", { fetchImpl, signal: controller.signal });
		controller.abort();
		await expect(promise).rejects.toThrow(/aborted/i);
	});

	it("throws an actionable error on a non-2xx HTTP status", async () => {
		await expect(
			run("q", {
				fetchImpl: async () => jsonResponse({ error: "boom" }, { status: 500 }),
			}),
		).rejects.toThrow(/HTTP 500 from http:\/\/localhost:8888.*JSON format enabled/i);
	});

	it("throws a JSON-disabled error when the body is not JSON", async () => {
		await expect(
			run("q", {
				fetchImpl: async () => new Response("<html>not json</html>", { headers: { "content-type": "text/html" } }),
			}),
		).rejects.toThrow(/non-JSON response from http:\/\/localhost:8888.*json.*search\.formats/i);
	});

	it("throws a JSON-disabled error when the body has no results array", async () => {
		await expect(
			run("q", {
				fetchImpl: async () => jsonResponse({ notResults: true }),
			}),
		).rejects.toThrow(/non-JSON response from http:\/\/localhost:8888/i);
	});
});
