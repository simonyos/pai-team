import { describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { BUILTIN_READ_ONLY_TOOLS } from "../src/core/permissions/permission-types.ts";
import {
	createWebFetchToolDefinition,
	type WebFetchOperations,
	type WebFetchToolDetails,
} from "../src/core/tools/web-fetch.ts";

const PUBLIC_IP = [{ address: "93.184.216.34", family: 4 }];

interface RunOptions {
	fetchImpl?: WebFetchOperations["fetch"];
	lookupMap?: Record<string, Array<{ address: string; family: number }>>;
	lookupImpl?: WebFetchOperations["lookup"];
	toolOptions?: Parameters<typeof createWebFetchToolDefinition>[0];
	maxBytes?: number;
	signal?: AbortSignal;
}

function run(url: string, options: RunOptions = {}) {
	const lookup: WebFetchOperations["lookup"] =
		options.lookupImpl ?? (async (host) => options.lookupMap?.[host] ?? PUBLIC_IP);
	const fetchImpl: WebFetchOperations["fetch"] =
		options.fetchImpl ?? (async () => new Response("ok", { headers: { "content-type": "text/plain" } }));
	const def = createWebFetchToolDefinition({
		operations: { fetch: fetchImpl, lookup },
		...options.toolOptions,
	});
	return def.execute("call-1", { url, maxBytes: options.maxBytes }, options.signal, undefined, {} as ExtensionContext);
}

function textOf(result: Awaited<ReturnType<typeof run>>): string {
	return result.content.map((c) => ("text" in c ? c.text : "")).join("");
}

describe("web_fetch permission posture", () => {
	it("is not read-only and not in the builtin read-only set", () => {
		const def = createWebFetchToolDefinition();
		expect(def.isReadOnly).toBeUndefined();
		expect(def.checkPermissions).toBeUndefined();
		expect(BUILTIN_READ_ONLY_TOOLS.has("web_fetch")).toBe(false);
	});

	it("advertises a prompt snippet so it lists in Available tools", () => {
		expect(createWebFetchToolDefinition().promptSnippet).toBeTruthy();
	});
});

describe("web_fetch SSRF defense", () => {
	it("rejects non-http(s) schemes", async () => {
		const fetchSpy = vi.fn();
		await expect(run("file:///etc/passwd", { fetchImpl: fetchSpy })).rejects.toThrow(/non-http/i);
		await expect(run("ftp://example.com/x", { fetchImpl: fetchSpy })).rejects.toThrow(/non-http/i);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("rejects an invalid URL", async () => {
		await expect(run("not a url")).rejects.toThrow(/Invalid URL/i);
	});

	it("rejects literal loopback hosts", async () => {
		const fetchSpy = vi.fn();
		await expect(run("http://127.0.0.1/", { fetchImpl: fetchSpy })).rejects.toThrow(/private|loopback/i);
		await expect(run("http://127.5.5.5/", { fetchImpl: fetchSpy })).rejects.toThrow(/private|loopback/i);
		await expect(run("http://[::1]/", { fetchImpl: fetchSpy })).rejects.toThrow(/private|loopback/i);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("rejects the localhost name without a DNS lookup", async () => {
		const fetchSpy = vi.fn();
		const lookupSpy = vi.fn();
		await expect(run("http://localhost:8080/", { fetchImpl: fetchSpy, lookupImpl: lookupSpy })).rejects.toThrow(
			/loopback/i,
		);
		expect(lookupSpy).not.toHaveBeenCalled();
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("rejects loopback hosts written with a trailing FQDN root dot", async () => {
		const fetchSpy = vi.fn();
		const lookupSpy = vi.fn();
		// "localhost." and "127.0.0.1." resolve the same as without the dot — the trailing
		// root label must not slip past the loopback / literal-IP fast paths (no DNS lookup).
		await expect(run("http://localhost./", { fetchImpl: fetchSpy, lookupImpl: lookupSpy })).rejects.toThrow(
			/loopback/i,
		);
		await expect(run("http://127.0.0.1./", { fetchImpl: fetchSpy, lookupImpl: lookupSpy })).rejects.toThrow(
			/private|loopback/i,
		);
		expect(lookupSpy).not.toHaveBeenCalled();
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("rejects literal link-local, private and unspecified addresses", async () => {
		const hosts = [
			"http://169.254.169.254/latest/meta-data/",
			"http://10.0.0.5/",
			"http://172.16.9.9/",
			"http://192.168.1.1/",
			"http://0.0.0.0/",
		];
		for (const host of hosts) {
			await expect(run(host)).rejects.toThrow(/private|loopback|link-local/i);
		}
	});

	it("rejects an IPv4-mapped IPv6 loopback", async () => {
		await expect(run("http://[::ffff:127.0.0.1]/")).rejects.toThrow(/private|loopback/i);
	});

	it("rejects a hostname that resolves to a private IP, without fetching", async () => {
		const fetchSpy = vi.fn();
		await expect(
			run("http://evil.example.com/", {
				fetchImpl: fetchSpy,
				lookupMap: { "evil.example.com": [{ address: "10.1.2.3", family: 4 }] },
			}),
		).rejects.toThrow(/private|loopback/i);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("rejects when any resolved address is private (mixed results)", async () => {
		await expect(
			run("http://mixed.example.com/", {
				lookupMap: {
					"mixed.example.com": [
						{ address: "93.184.216.34", family: 4 },
						{ address: "192.168.0.9", family: 4 },
					],
				},
			}),
		).rejects.toThrow(/private|loopback/i);
	});

	it("re-validates redirect targets and rejects a redirect to a blocked host", async () => {
		const fetchImpl = vi.fn(async (url: string) => {
			if (url === "http://public.example.com/") {
				return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } });
			}
			return new Response("should not reach", { headers: { "content-type": "text/plain" } });
		});
		await expect(run("http://public.example.com/", { fetchImpl })).rejects.toThrow(/private|loopback|link-local/i);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it("rejects when redirects exceed the hop cap", async () => {
		const fetchImpl = vi.fn(
			async () => new Response(null, { status: 302, headers: { location: "http://public.example.com/next" } }),
		);
		await expect(run("http://public.example.com/", { fetchImpl, toolOptions: { maxRedirects: 2 } })).rejects.toThrow(
			/too many redirects/i,
		);
	});
});

describe("web_fetch content extraction", () => {
	it("follows a redirect to an allowed host and extracts the final body", async () => {
		const fetchImpl = vi.fn(async (url: string) => {
			if (url === "http://public.example.com/") {
				return new Response(null, { status: 301, headers: { location: "http://public.example.com/final" } });
			}
			return new Response("<html><body><p>Landed</p></body></html>", {
				headers: { "content-type": "text/html" },
			});
		});
		const result = await run("http://public.example.com/", { fetchImpl });
		expect(textOf(result)).toContain("Landed");
		expect((result.details as WebFetchToolDetails).url).toBe("http://public.example.com/final");
	});

	it("strips scripts/styles, unwraps tags and decodes entities from HTML", async () => {
		const html = `<!DOCTYPE html><html><head>
			<style>.x{color:red}</style>
			<script>alert('nope')</script>
			<title>Title</title></head>
			<body>
			<h1>Hello&nbsp;World</h1>
			<p>Tom &amp; Jerry &lt;3 &#39;quotes&#39; &#x41;</p>
			<div>line one</div><div>line two</div>
			</body></html>`;
		const result = await run("http://public.example.com/", {
			fetchImpl: async () => new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } }),
		});
		const text = textOf(result);
		expect(text).not.toMatch(/alert\(/);
		expect(text).not.toMatch(/color:red/);
		// No residual HTML tag markup (decoded entities like "<3" are fine).
		expect(text).not.toMatch(/<\/?[a-z][^>]*>/i);
		expect(text).toContain("Hello World");
		expect(text).toContain("Tom & Jerry <3 'quotes' A");
		expect(text).toContain("line one");
		expect(text).toContain("line two");
	});

	it("strips script/style blocks whose closing tag has whitespace before '>'", async () => {
		// HTML5 permits whitespace/newline before ">" in a closing tag; the block (not just
		// the tags) must still be removed so inline JS/CSS never leaks into the output.
		const html = `<html><body><p>Visible</p><script>SECRET_JS_LEAK()</script >
			<style>.a{color:red}</style\n><p>After</p></body></html>`;
		const result = await run("http://public.example.com/", {
			fetchImpl: async () => new Response(html, { headers: { "content-type": "text/html" } }),
		});
		const text = textOf(result);
		expect(text).not.toMatch(/SECRET_JS_LEAK/);
		expect(text).not.toMatch(/color:red/);
		expect(text).toContain("Visible");
		expect(text).toContain("After");
	});

	it("passes non-HTML text content through unchanged", async () => {
		const json = '{"a":1,"b":"<not-html>"}';
		const result = await run("http://public.example.com/data.json", {
			fetchImpl: async () => new Response(json, { headers: { "content-type": "application/json" } }),
		});
		expect(textOf(result)).toBe(json);
		expect((result.details as WebFetchToolDetails).contentType).toBe("application/json");
	});

	it("refuses binary content-types", async () => {
		await expect(
			run("http://public.example.com/img.png", {
				fetchImpl: async () => new Response("\x89PNG", { headers: { "content-type": "image/png" } }),
			}),
		).rejects.toThrow(/non-text content-type/i);
	});

	it("surfaces an HTTP error status", async () => {
		await expect(
			run("http://public.example.com/missing", {
				fetchImpl: async () => new Response("nope", { status: 404, headers: { "content-type": "text/plain" } }),
			}),
		).rejects.toThrow(/HTTP 404/);
	});

	it("truncates a long body and appends a truncation notice", async () => {
		const body = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n");
		const result = await run("http://public.example.com/big", {
			fetchImpl: async () => new Response(body, { headers: { "content-type": "text/plain" } }),
			toolOptions: { maxLines: 100 },
		});
		const text = textOf(result);
		expect(text).toMatch(/\[Truncated:/);
		const details = result.details as WebFetchToolDetails;
		expect(details.truncation?.truncated).toBe(true);
		// Body content lines are capped well below the original 5000.
		expect(text.split("\n").length).toBeLessThan(200);
	});
});

describe("web_fetch abort and timeout", () => {
	it("throws immediately when the signal is already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		const fetchSpy = vi.fn();
		await expect(
			run("http://public.example.com/", { fetchImpl: fetchSpy, signal: controller.signal }),
		).rejects.toThrow(/aborted/i);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("times out a hanging request", async () => {
		const fetchImpl: WebFetchOperations["fetch"] = (_url, init) =>
			new Promise((_resolve, reject) => {
				init.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
			});
		await expect(run("http://public.example.com/", { fetchImpl, toolOptions: { timeoutMs: 20 } })).rejects.toThrow(
			/timed out/i,
		);
	});

	it("aborts a hanging request when the caller signal fires", async () => {
		const controller = new AbortController();
		const fetchImpl: WebFetchOperations["fetch"] = (_url, init) =>
			new Promise((_resolve, reject) => {
				init.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
			});
		const promise = run("http://public.example.com/", { fetchImpl, signal: controller.signal });
		controller.abort();
		await expect(promise).rejects.toThrow(/aborted/i);
	});
});
