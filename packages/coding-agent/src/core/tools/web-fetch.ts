import { lookup as dnsLookup } from "node:dns/promises";
import net from "node:net";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.ts";
import { getTextOutput, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult, truncateHead } from "./truncate.ts";

const webFetchSchema = Type.Object({
	url: Type.String({ description: "The URL to fetch (must be http or https)." }),
	maxBytes: Type.Optional(
		Type.Number({ description: `Maximum bytes of extracted text to return (default: ${DEFAULT_MAX_BYTES}).` }),
	),
});

export type WebFetchToolInput = Static<typeof webFetchSchema>;

/** Hard cap on how many bytes we download before giving up, independent of the text truncation limit. */
const DEFAULT_MAX_DOWNLOAD_BYTES = 5 * 1024 * 1024; // 5MB
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_REDIRECTS = 5;
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

export interface WebFetchToolDetails {
	/** Final URL fetched (after following any redirects). */
	url: string;
	/** Response content-type (mime only, no parameters). */
	contentType?: string;
	/** Truncation info when the extracted text exceeded the limits. */
	truncation?: TruncationResult;
	/** Whether the download was capped before the full body was read. */
	downloadTruncated?: boolean;
}

interface DnsAddress {
	address: string;
	family: number;
}

/**
 * Pluggable network operations for the web_fetch tool.
 * Override these in tests to avoid hitting the real network / DNS.
 */
export interface WebFetchOperations {
	/** Perform the HTTP request. Defaults to the global (undici-backed) fetch. */
	fetch: (url: string, init: RequestInit) => Promise<Response>;
	/** Resolve a hostname to all of its addresses. Defaults to node:dns lookup(all). */
	lookup: (hostname: string) => Promise<DnsAddress[]>;
}

const defaultOperations: WebFetchOperations = {
	fetch: (url, init) => globalThis.fetch(url, init),
	lookup: (hostname) => dnsLookup(hostname, { all: true }),
};

export interface WebFetchToolOptions {
	/** Custom network operations. Default: global fetch + node:dns. */
	operations?: WebFetchOperations;
	/** Max bytes of extracted text to return (default: 50KB). Overridable per call via params.maxBytes. */
	maxBytes?: number;
	/** Max lines of extracted text to return (default: 2000). */
	maxLines?: number;
	/** Per-request timeout in milliseconds (default: 30s). */
	timeoutMs?: number;
	/** Max redirect hops to follow (default: 5). */
	maxRedirects?: number;
	/** Hard cap on downloaded bytes before aborting the read (default: 5MB). */
	maxDownloadBytes?: number;
}

/** Build the block-list of loopback/link-local/private/unspecified ranges (SSRF defense). */
function createBlockList(): net.BlockList {
	const blockList = new net.BlockList();
	// IPv4
	blockList.addSubnet("0.0.0.0", 8, "ipv4"); // "this host" / unspecified
	blockList.addSubnet("10.0.0.0", 8, "ipv4"); // private
	blockList.addSubnet("127.0.0.0", 8, "ipv4"); // loopback
	blockList.addSubnet("169.254.0.0", 16, "ipv4"); // link-local
	blockList.addSubnet("172.16.0.0", 12, "ipv4"); // private
	blockList.addSubnet("192.168.0.0", 16, "ipv4"); // private
	// IPv6
	blockList.addAddress("::", "ipv6"); // unspecified
	blockList.addAddress("::1", "ipv6"); // loopback
	blockList.addSubnet("fc00::", 7, "ipv6"); // unique local (private)
	blockList.addSubnet("fe80::", 10, "ipv6"); // link-local
	return blockList;
}

const blockList = createBlockList();

/** Extract the dotted IPv4 out of an IPv4-mapped IPv6 address (e.g. ::ffff:10.0.0.1), if present. */
function mappedIpv4(ip: string): string | undefined {
	const match = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(ip);
	return match ? match[1] : undefined;
}

/** True if the given IP literal falls in a blocked (loopback/link-local/private/unspecified) range. */
function isBlockedAddress(ip: string): boolean {
	const type = net.isIP(ip);
	if (type === 4) return blockList.check(ip, "ipv4");
	if (type === 6) {
		const mapped = mappedIpv4(ip);
		if (mapped && net.isIP(mapped) === 4 && blockList.check(mapped, "ipv4")) return true;
		return blockList.check(ip, "ipv6");
	}
	return false;
}

/** Normalize a URL hostname: strip IPv6 brackets, lowercase, and drop a trailing FQDN root dot. */
function normalizeHostname(hostname: string): string {
	let host = hostname.toLowerCase();
	if (host.startsWith("[") && host.endsWith("]")) {
		host = host.slice(1, -1);
	}
	// A trailing "." is the DNS root label ("localhost." / "127.0.0.1." resolve the same
	// as without it). Strip it so it can't slip past the loopback / literal-IP checks below.
	host = host.replace(/\.+$/, "");
	return host;
}

/**
 * Validate a URL for fetching: enforce http(s) scheme, reject literal
 * private/loopback/link-local hosts, and resolve DNS names rejecting any that
 * point at a blocked address. Throws with a clear message on rejection.
 *
 * Residual (documented, deferred): this resolves the hostname to validate it, but
 * the subsequent fetch re-resolves the name independently, so a rebinding DNS
 * server with a short TTL could answer "public" here and "private" at connect time
 * (a classic resolve-then-connect TOCTOU). Fully closing it means pinning the
 * validated IP into the connection via a per-request undici dispatcher — which would
 * bypass the configured EnvHttpProxyAgent (core/http-dispatcher.ts) for proxy users,
 * so it needs proxy-aware handling and is left as a follow-up. Mitigations already in
 * place: web_fetch is not auto-allowed (an un-ruled call resolves to "ask"), and the
 * enumerated literal / DNS-resolves-to-private / redirect cases are all covered.
 */
async function assertUrlAllowed(url: URL, lookup: WebFetchOperations["lookup"]): Promise<void> {
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error(`Refusing to fetch non-http(s) URL (scheme "${url.protocol}"): ${url.href}`);
	}
	const host = normalizeHostname(url.hostname);
	if (!host) {
		throw new Error(`Refusing to fetch URL with empty host: ${url.href}`);
	}
	if (host === "localhost" || host.endsWith(".localhost")) {
		throw new Error(`Refusing to fetch loopback host "${host}"`);
	}

	// Literal IP host: check it directly, no DNS needed.
	if (net.isIP(host) !== 0) {
		if (isBlockedAddress(host)) {
			throw new Error(`Refusing to fetch private/loopback/link-local address "${host}"`);
		}
		return;
	}

	// Hostname: resolve and reject if ANY resolved address is blocked (SSRF via DNS).
	let addresses: DnsAddress[];
	try {
		addresses = await lookup(host);
	} catch (e) {
		throw new Error(`Could not resolve host "${host}": ${e instanceof Error ? e.message : String(e)}`);
	}
	if (addresses.length === 0) {
		throw new Error(`Could not resolve host "${host}"`);
	}
	for (const { address } of addresses) {
		if (isBlockedAddress(address)) {
			throw new Error(`Refusing to fetch "${host}": resolves to private/loopback address ${address}`);
		}
	}
}

/** Decode the common named + numeric HTML entities. */
function decodeEntities(input: string): string {
	const named: Record<string, string> = {
		amp: "&",
		lt: "<",
		gt: ">",
		quot: '"',
		apos: "'",
		nbsp: " ",
	};
	return input.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/gi, (match, entity: string) => {
		if (entity[0] === "#") {
			const isHex = entity[1] === "x" || entity[1] === "X";
			const code = isHex ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
			if (Number.isNaN(code)) return match;
			try {
				return String.fromCodePoint(code);
			} catch {
				return match;
			}
		}
		const key = entity.toLowerCase();
		return key in named ? named[key] : match;
	});
}

/** Convert an HTML document to readable plain text without any external dependency. */
function htmlToText(html: string): string {
	let text = html;
	// Drop non-content blocks entirely. The closing tag may carry whitespace before ">"
	// (HTML5 allows "</script >" / "</style\n>"); \s* ensures the whole block — not just
	// the tags — is removed, so inline JS/CSS text never leaks into the extracted output.
	text = text.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, " ");
	text = text.replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, " ");
	text = text.replace(/<!--[\s\S]*?-->/g, " ");
	// Turn block-level boundaries and line breaks into newlines.
	text = text.replace(/<(?:br|hr)\s*\/?>/gi, "\n");
	text = text.replace(/<\/(?:p|div|section|article|header|footer|li|ul|ol|tr|table|h[1-6]|blockquote|pre)>/gi, "\n");
	// Strip all remaining tags.
	text = text.replace(/<[^>]+>/g, " ");
	// Decode entities after tag removal.
	text = decodeEntities(text);
	// Collapse whitespace: horizontal runs to a single space, tidy blank lines.
	text = text.replace(/[^\S\n]+/g, " ");
	text = text.replace(/ *\n */g, "\n");
	text = text.replace(/\n{3,}/g, "\n\n");
	return text.trim();
}

/** Mime types (beyond text/*) we treat as extractable text. */
function isTextualContentType(mime: string): boolean {
	if (mime.startsWith("text/")) return true;
	if (mime.endsWith("+json") || mime.endsWith("+xml")) return true;
	return /^application\/(json|xml|xhtml\+xml|javascript|ecmascript|ld\+json|x-ndjson|rss\+xml|atom\+xml|yaml|x-yaml|graphql)/.test(
		mime,
	);
}

function isHtml(mime: string): boolean {
	return mime === "text/html" || mime === "application/xhtml+xml";
}

/** Read a response body up to a hard byte cap, decoding as UTF-8. */
async function readBodyBounded(res: Response, maxDownloadBytes: number): Promise<{ text: string; truncated: boolean }> {
	const body = res.body;
	if (!body || typeof body.getReader !== "function") {
		const text = await res.text();
		const buf = Buffer.from(text, "utf-8");
		if (buf.byteLength > maxDownloadBytes) {
			return { text: buf.subarray(0, maxDownloadBytes).toString("utf-8"), truncated: true };
		}
		return { text, truncated: false };
	}
	const reader = body.getReader();
	const chunks: Buffer[] = [];
	let total = 0;
	let truncated = false;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		if (value && value.byteLength > 0) {
			chunks.push(Buffer.from(value));
			total += value.byteLength;
			if (total >= maxDownloadBytes) {
				truncated = true;
				await reader.cancel();
				break;
			}
		}
	}
	return { text: Buffer.concat(chunks).toString("utf-8"), truncated };
}

export function createWebFetchToolDefinition(
	options?: WebFetchToolOptions,
): ToolDefinition<typeof webFetchSchema, WebFetchToolDetails | undefined> {
	const ops = options?.operations ?? defaultOperations;
	const defaultMaxBytes = options?.maxBytes ?? DEFAULT_MAX_BYTES;
	const maxLines = options?.maxLines ?? DEFAULT_MAX_LINES;
	const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const maxRedirects = options?.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
	const maxDownloadBytes = options?.maxDownloadBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES;

	return {
		name: "web_fetch",
		label: "web_fetch",
		description:
			"Fetch a URL over http(s) and return its readable text content. HTML is converted to plain text (scripts/styles stripped, tags removed, entities decoded); text, JSON, and XML content pass through as-is. Binary content is refused. Output is truncated to the configured line/byte limits. Blocks requests to private, loopback, and link-local addresses.",
		promptSnippet: "Fetch a URL and return its readable text content",
		parameters: webFetchSchema,
		async execute(
			_toolCallId,
			{ url: rawUrl, maxBytes }: WebFetchToolInput,
			signal?: AbortSignal,
			_onUpdate?,
			_ctx?,
		) {
			if (signal?.aborted) throw new Error("Operation aborted");

			let currentUrl: URL;
			try {
				currentUrl = new URL(rawUrl);
			} catch {
				throw new Error(`Invalid URL: ${rawUrl}`);
			}

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
				let response: Response | undefined;
				let finalUrl = currentUrl;
				for (let hop = 0; ; hop++) {
					// Re-validate every hop (initial + each redirect target).
					await assertUrlAllowed(currentUrl, ops.lookup);
					if (controller.signal.aborted) {
						throw new Error(timedOut ? `Request timed out after ${timeoutMs / 1000}s` : "Operation aborted");
					}

					const res = await ops.fetch(currentUrl.href, {
						redirect: "manual",
						signal: controller.signal,
						headers: { accept: "text/html,text/plain,application/json,application/xml;q=0.9,*/*;q=0.8" },
					});

					if (REDIRECT_STATUS.has(res.status)) {
						const location = res.headers.get("location");
						if (!location) {
							response = res;
							finalUrl = currentUrl;
							break;
						}
						if (hop >= maxRedirects) {
							throw new Error(`Too many redirects (>${maxRedirects}) fetching ${rawUrl}`);
						}
						try {
							currentUrl = new URL(location, currentUrl);
						} catch {
							throw new Error(`Invalid redirect target "${location}" from ${res.url || currentUrl.href}`);
						}
						continue;
					}

					response = res;
					finalUrl = currentUrl;
					break;
				}

				if (!response) throw new Error(`Failed to fetch ${rawUrl}`);
				if (!response.ok) {
					throw new Error(
						`Fetch failed: HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""} for ${finalUrl.href}`,
					);
				}

				const rawContentType = response.headers.get("content-type") ?? "";
				const mime = rawContentType.split(";")[0].trim().toLowerCase();
				if (mime && !isTextualContentType(mime)) {
					throw new Error(`Cannot extract text from non-text content-type "${mime}" (${finalUrl.href})`);
				}

				const { text: body, truncated: downloadTruncated } = await readBodyBounded(response, maxDownloadBytes);
				const extracted = isHtml(mime) ? htmlToText(body) : body;

				const truncation = truncateHead(extracted, { maxLines, maxBytes: maxBytes ?? defaultMaxBytes });
				let outputText = truncation.content;
				const details: WebFetchToolDetails = { url: finalUrl.href };
				if (mime) details.contentType = mime;

				const notices: string[] = [];
				if (truncation.truncated) {
					details.truncation = truncation;
					const limit =
						truncation.truncatedBy === "bytes" ? formatSize(maxBytes ?? defaultMaxBytes) : `${maxLines} lines`;
					notices.push(
						`${limit} limit reached (showing ${truncation.outputLines} of ${truncation.totalLines} lines)`,
					);
				}
				if (downloadTruncated) {
					details.downloadTruncated = true;
					notices.push(`download capped at ${formatSize(maxDownloadBytes)}`);
				}
				if (notices.length > 0) {
					outputText += `\n\n[Truncated: ${notices.join("; ")}]`;
				}

				return { content: [{ type: "text", text: outputText }], details };
			} catch (e) {
				if (controller.signal.aborted) {
					throw new Error(timedOut ? `Request timed out after ${timeoutMs / 1000}s` : "Operation aborted");
				}
				throw e;
			} finally {
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
			}
		},
		renderCall(args, theme, context) {
			const component = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			component.setText(formatWebFetchCall(args, theme));
			return component;
		},
		renderResult(result, options, theme, context) {
			const component = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			component.setText(formatWebFetchResult(result as any, options, theme, context.showImages));
			return component;
		},
	};
}

function formatWebFetchCall(args: { url?: string } | undefined, theme: Theme): string {
	const url = str(args?.url);
	const urlDisplay = url === null ? theme.fg("error", "[invalid arg]") : theme.fg("accent", url || "...");
	return `${theme.fg("toolTitle", theme.bold("web_fetch"))} ${urlDisplay}`;
}

function formatWebFetchResult(
	result: { content: Array<{ type: string; text?: string }>; details?: WebFetchToolDetails },
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

export function createWebFetchTool(options?: WebFetchToolOptions): AgentTool<typeof webFetchSchema> {
	return wrapToolDefinition(createWebFetchToolDefinition(options));
}
