import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.ts";
import { getTextOutput, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult, truncateHead } from "./truncate.ts";

const webSearchSchema = Type.Object({
	query: Type.String({ description: "The search query." }),
});

export type WebSearchToolInput = Static<typeof webSearchSchema>;

const DEFAULT_ENDPOINT = "http://localhost:8888";
const DEFAULT_MAX_RESULTS = 8;
const DEFAULT_TIMEOUT_MS = 30_000;

export interface WebSearchToolDetails {
	/** The query that was searched. */
	query: string;
	/** Number of results returned (after the maxResults cap). */
	resultCount: number;
	/** The SearXNG endpoint that was queried. */
	endpoint: string;
	/** Truncation info when the formatted results exceeded the limits. */
	truncation?: TruncationResult;
}

/**
 * Pluggable network operations for the web_search tool.
 * Override these in tests to avoid hitting the real network.
 */
export interface WebSearchOperations {
	/** Perform the HTTP request. Defaults to the global (undici-backed) fetch. */
	fetch: (url: string, init: RequestInit) => Promise<Response>;
}

const defaultOperations: WebSearchOperations = {
	fetch: (url, init) => globalThis.fetch(url, init),
};

export interface WebSearchToolOptions {
	/** SearXNG endpoint to query. Default: {@link DEFAULT_ENDPOINT}. */
	endpoint?: string;
	/** Custom network operations. Default: global fetch. */
	operations?: WebSearchOperations;
	/** Maximum number of results to return (default: 8). */
	maxResults?: number;
	/** Per-request timeout in milliseconds (default: 30s). */
	timeoutMs?: number;
	/** Max bytes of formatted output to return (default: 50KB). */
	maxBytes?: number;
}

/** A single SearXNG result, as much of it as we care about. */
interface SearxResult {
	title?: unknown;
	url?: unknown;
	content?: unknown;
}

/** Collapse all whitespace runs (including newlines) into single spaces. */
function singleLine(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

/** Format one SearXNG result as a compact numbered block: title / url / snippet. */
function formatResult(result: SearxResult, index: number): string {
	// Guard against a non-object entry (e.g. a stray null in the results array) so a
	// malformed response yields an "(untitled)" line rather than an opaque TypeError.
	const r: SearxResult = result && typeof result === "object" ? result : {};
	const title = typeof r.title === "string" && r.title.trim() ? singleLine(r.title) : "(untitled)";
	const url = typeof r.url === "string" ? r.url.trim() : "";
	const content = typeof r.content === "string" ? singleLine(r.content) : "";
	const lines = [`${index + 1}. ${title}`];
	if (url) lines.push(`   ${url}`);
	if (content) lines.push(`   ${content}`);
	return lines.join("\n");
}

export function createWebSearchToolDefinition(
	options?: WebSearchToolOptions,
): ToolDefinition<typeof webSearchSchema, WebSearchToolDetails | undefined> {
	const ops = options?.operations ?? defaultOperations;
	const endpoint = options?.endpoint ?? DEFAULT_ENDPOINT;
	const maxResults = options?.maxResults ?? DEFAULT_MAX_RESULTS;
	const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const maxBytes = options?.maxBytes ?? DEFAULT_MAX_BYTES;

	return {
		name: "web_search",
		label: "web_search",
		description:
			"Search the web via a self-hosted SearXNG instance and return the top results (title, URL, and snippet) for a query. The SearXNG endpoint is fixed by operator configuration; only the query is model-supplied. Output is truncated to the configured line/byte limits.",
		promptSnippet: "Search the web and return the top results for a query",
		parameters: webSearchSchema,
		// A pure read against a single fixed, operator-trusted endpoint: auto-allowed and usable in plan mode.
		isReadOnly: true,
		async execute(_toolCallId, { query }: WebSearchToolInput, signal?: AbortSignal, _onUpdate?, _ctx?) {
			if (signal?.aborted) throw new Error("Operation aborted");

			// The host/port (and any base path) are fixed by operator config; the model-supplied
			// query is strictly URL-encoded into `q` and can never change the host it lands on.
			// Resolve "search" relative to a trailing-slashed base so a subpath-hosted endpoint
			// (e.g. behind a reverse proxy at http://host/searxng) keeps its prefix instead of
			// being dropped by an absolute "/search".
			const base = endpoint.endsWith("/") ? endpoint : `${endpoint}/`;
			const u = new URL("search", base);
			u.searchParams.set("q", query);
			u.searchParams.set("format", "json");

			// Per-request timeout combined with the caller's abort signal.
			const controller = new AbortController();
			let timedOut = false;
			const timer = setTimeout(() => {
				timedOut = true;
				controller.abort();
			}, timeoutMs);
			const onAbort = () => controller.abort();
			signal?.addEventListener("abort", onAbort, { once: true });

			try {
				let response: Response;
				try {
					response = await ops.fetch(u.href, {
						signal: controller.signal,
						headers: { accept: "application/json" },
					});
				} catch {
					// Distinguish an abort/timeout (handled by the outer catch) from an actual
					// connection failure (SearXNG not running / wrong endpoint).
					if (controller.signal.aborted) throw new Error("aborted");
					throw new Error(
						`web_search could not reach SearXNG at ${endpoint} (connection refused). Start your SearXNG instance or set PI_SEARXNG_URL / the searxngUrl setting.`,
					);
				}

				if (!response.ok) {
					throw new Error(
						`web_search failed: HTTP ${response.status} from ${endpoint}. Ensure SearXNG has JSON format enabled (search.formats: [json]).`,
					);
				}

				let data: unknown;
				try {
					data = await response.json();
				} catch {
					if (controller.signal.aborted) throw new Error("aborted");
					throw new Error(
						`web_search got a non-JSON response from ${endpoint}; SearXNG's JSON format is likely disabled (add "json" to search.formats).`,
					);
				}

				const results = (data as { results?: unknown } | null)?.results;
				if (!Array.isArray(results)) {
					throw new Error(
						`web_search got a non-JSON response from ${endpoint}; SearXNG's JSON format is likely disabled (add "json" to search.formats).`,
					);
				}

				if (results.length === 0) {
					return {
						content: [{ type: "text", text: `No results found for "${query}".` }],
						details: { query, resultCount: 0, endpoint },
					};
				}

				const top = results.slice(0, maxResults) as SearxResult[];
				const text = top.map((result, index) => formatResult(result, index)).join("\n\n");

				const truncation = truncateHead(text, { maxLines: DEFAULT_MAX_LINES, maxBytes });
				let outputText = truncation.content;
				const details: WebSearchToolDetails = { query, resultCount: top.length, endpoint };
				if (truncation.truncated) {
					details.truncation = truncation;
					const limit = truncation.truncatedBy === "bytes" ? formatSize(maxBytes) : `${DEFAULT_MAX_LINES} lines`;
					outputText += `\n\n[Truncated: ${limit} limit reached (showing ${truncation.outputLines} of ${truncation.totalLines} lines)]`;
				}

				return { content: [{ type: "text", text: outputText }], details };
			} catch (e) {
				if (controller.signal.aborted) {
					throw new Error(
						timedOut
							? `web_search timed out after ${timeoutMs / 1000}s contacting ${endpoint}.`
							: "Operation aborted",
					);
				}
				throw e;
			} finally {
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
			}
		},
		renderCall(args, theme, context) {
			const component = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			component.setText(formatWebSearchCall(args, theme));
			return component;
		},
		renderResult(result, options, theme, context) {
			const component = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			component.setText(formatWebSearchResult(result as any, options, theme, context.showImages));
			return component;
		},
	};
}

function formatWebSearchCall(args: { query?: string } | undefined, theme: Theme): string {
	const query = str(args?.query);
	const queryDisplay = query === null ? theme.fg("error", "[invalid arg]") : theme.fg("accent", query || "...");
	return `${theme.fg("toolTitle", theme.bold("web_search"))} ${queryDisplay}`;
}

function formatWebSearchResult(
	result: { content: Array<{ type: string; text?: string }>; details?: WebSearchToolDetails },
	options: ToolRenderResultOptions,
	theme: Theme,
	showImages: boolean,
): string {
	const output = getTextOutput(result, showImages).trim();
	if (!output) return "";
	const lines = output.split("\n");
	const maxLines = options.expanded ? lines.length : 20;
	const displayLines = lines.slice(0, maxLines);
	const remaining = lines.length - maxLines;
	let text = `\n${displayLines.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
	if (remaining > 0) {
		text += theme.fg("muted", `\n... (${remaining} more lines)`);
	}
	return text;
}

export function createWebSearchTool(options?: WebSearchToolOptions): AgentTool<typeof webSearchSchema> {
	return wrapToolDefinition(createWebSearchToolDefinition(options));
}
