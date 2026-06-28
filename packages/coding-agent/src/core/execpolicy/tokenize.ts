/**
 * Quote-aware shell command tokenizer (Wave 1, slice S2).
 *
 * Splits a command line into pipeline/list segments and tokenizes each into an
 * argv vector, the way Codex matches against an already-tokenized argv rather
 * than re-parsing with a regex. It also surfaces the dangerous constructs the
 * command-safety brain cares about: command/process substitution and output
 * redirections.
 *
 * SAFETY CONTRACT: this parser must never UNDER-report. When the input is
 * ambiguous or unbalanced, it sets `parseError` (callers treat that as
 * "prompt"), and it errs toward flagging substitution/redirection rather than
 * silently dropping it. It is intentionally not a full shell — it does not
 * execute, expand, or recurse into nested `sh -c` strings; those are handled
 * conservatively one layer up.
 */

export interface RedirectInfo {
	/** The operator, e.g. ">", ">>", "&>", "<", "<<", "<<<", "2>". */
	op: string;
	/** The redirect target word (may be empty if the line ended early). */
	target: string;
	/** True when this redirect writes a stream out ("> file"), false for input. */
	writes: boolean;
}

export interface CommandSegment {
	/** Program + operands, quotes removed, redirections excluded. */
	argv: string[];
	/** Redirections found in this segment. */
	redirects: RedirectInfo[];
	/** This segment receives another command's stdout via a pipe. */
	pipedInto: boolean;
}

export interface ParsedCommandLine {
	segments: CommandSegment[];
	/** Any `$(...)` or backtick command substitution was seen. */
	hasCommandSubstitution: boolean;
	/** Any `<(...)` or `>(...)` process substitution was seen. */
	hasProcessSubstitution: boolean;
	/** Set when the line could not be parsed cleanly (unbalanced quotes/parens). */
	parseError?: string;
}

const WHITESPACE = new Set([" ", "\t"]);

/**
 * Does a redirect with this operator/target write to a file? Output operators
 * (">") write UNLESS the target is a bare file descriptor (e.g. `2>&1`, `>&2`)
 * or the close form (`>&-`), which only duplicate/close descriptors.
 */
function redirectWrites(op: string, target: string): boolean {
	if (!op.includes(">")) return false;
	if (target === "-" || /^\d+$/.test(target)) return false;
	return true;
}

/** Is `ch` a shell control operator start at the top level? */
function isOperatorChar(ch: string): boolean {
	return ch === ";" || ch === "&" || ch === "|" || ch === "\n" || ch === ">" || ch === "<";
}

interface ScanState {
	hasCommandSubstitution: boolean;
	hasProcessSubstitution: boolean;
	parseError?: string;
}

/**
 * Consume a balanced `(...)` run starting at `start` (the index of "("), honoring
 * nested parens and quotes. Returns the index just past the closing ")".
 * On imbalance returns the end of string and records a parse error.
 */
function consumeBalancedParen(src: string, start: number, state: ScanState): number {
	let depth = 0;
	let i = start;
	while (i < src.length) {
		const ch = src[i];
		if (ch === "'") {
			i = skipSingleQuote(src, i + 1, state);
			continue;
		}
		if (ch === '"') {
			i = skipDoubleQuote(src, i + 1, state);
			continue;
		}
		if (ch === "\\") {
			i += 2;
			continue;
		}
		if (ch === "(") depth++;
		else if (ch === ")") {
			depth--;
			if (depth === 0) return i + 1;
		}
		i++;
	}
	state.parseError ??= "unbalanced parentheses in substitution";
	return src.length;
}

/** Skip a single-quoted run; `start` is just past the opening quote. Returns index past closing quote. */
function skipSingleQuote(src: string, start: number, state: ScanState): number {
	const close = src.indexOf("'", start);
	if (close === -1) {
		state.parseError ??= "unterminated single quote";
		return src.length;
	}
	return close + 1;
}

/**
 * Skip a double-quoted run; `start` is just past the opening quote. Honors `\`
 * escapes and detects `$(...)`/backtick substitution inside the quotes.
 * Returns index past the closing quote.
 */
function skipDoubleQuote(src: string, start: number, state: ScanState): number {
	let i = start;
	while (i < src.length) {
		const ch = src[i];
		if (ch === "\\") {
			i += 2;
			continue;
		}
		if (ch === '"') return i + 1;
		if (ch === "`") {
			state.hasCommandSubstitution = true;
			const close = src.indexOf("`", i + 1);
			i = close === -1 ? src.length : close + 1;
			continue;
		}
		if (ch === "$" && src[i + 1] === "(") {
			state.hasCommandSubstitution = true;
			i = consumeBalancedParen(src, i + 1, state);
			continue;
		}
		i++;
	}
	state.parseError ??= "unterminated double quote";
	return src.length;
}

/**
 * Read one word starting at `start`, concatenating adjacent quoted/unquoted/escaped
 * runs and substitutions. Returns the literal value (quotes removed) and the index
 * after the word.
 */
function readWord(src: string, start: number, state: ScanState): { value: string; next: number } {
	let i = start;
	let value = "";
	while (i < src.length) {
		const ch = src[i];
		// Unquoted parens are subshell/grouping boundaries, never part of a word — so
		// a glued closer like the "/" in "(rm -rf /)" stays its own token.
		if (WHITESPACE.has(ch) || isOperatorChar(ch) || ch === "(" || ch === ")") break;
		if (ch === "'") {
			const close = src.indexOf("'", i + 1);
			if (close === -1) {
				state.parseError ??= "unterminated single quote";
				value += src.slice(i + 1);
				return { value, next: src.length };
			}
			value += src.slice(i + 1, close);
			i = close + 1;
			continue;
		}
		if (ch === '"') {
			const end = skipDoubleQuote(src, i + 1, state);
			// Strip the surrounding quotes for the literal value; inner escapes are
			// kept verbatim (good enough for argv matching, never re-executed). Only
			// drop the trailing quote when the run was actually terminated, otherwise
			// the last real character would be chopped off.
			const terminated = src[end - 1] === '"' && end > i + 1;
			value += src.slice(i + 1, terminated ? end - 1 : end);
			i = end;
			continue;
		}
		if (ch === "\\") {
			if (src[i + 1] === "\n") {
				// POSIX line continuation: the backslash-newline pair is removed entirely.
				i += 2;
			} else if (i + 1 < src.length) {
				value += src[i + 1];
				i += 2;
			} else {
				i += 1;
			}
			continue;
		}
		if (ch === "`") {
			state.hasCommandSubstitution = true;
			const close = src.indexOf("`", i + 1);
			value += close === -1 ? src.slice(i) : src.slice(i, close + 1);
			i = close === -1 ? src.length : close + 1;
			continue;
		}
		if (ch === "$" && src[i + 1] === "'") {
			// ANSI-C quoting $'…'. Treat like a single-quoted literal so that, e.g.,
			// `rm -rf $'/'` still exposes "/" as the target. Common escapes are not
			// fully decoded (good enough for argv matching, never re-executed).
			const close = src.indexOf("'", i + 2);
			if (close === -1) {
				state.parseError ??= "unterminated ANSI-C quote";
				value += src.slice(i + 2);
				return { value, next: src.length };
			}
			value += src.slice(i + 2, close);
			i = close + 1;
			continue;
		}
		if (ch === "$" && src[i + 1] === "(") {
			state.hasCommandSubstitution = true;
			const end = consumeBalancedParen(src, i + 1, state);
			value += src.slice(i, end);
			i = end;
			continue;
		}
		value += ch;
		i++;
	}
	return { value, next: i };
}

/** Read a redirection operator at `start` (which points at "<" or ">"), returning op text and next index. */
function readRedirectOp(src: string, start: number, fdPrefix: string): { op: string; next: number } {
	let i = start;
	const ch = src[i];
	let op = fdPrefix + ch;
	i++;
	// Doubled forms and combinations: >>, <<, <<<, >|, >&, <&.
	if (ch === ">" && src[i] === ">") {
		op += ">";
		i++;
	} else if (ch === "<" && src[i] === "<") {
		op += "<";
		i++;
		if (src[i] === "<") {
			op += "<";
			i++;
		}
	}
	if (src[i] === "&" && (ch === ">" || ch === "<")) {
		op += "&";
		i++;
	} else if (src[i] === "|" && ch === ">") {
		op += "|";
		i++;
	}
	return { op, next: i };
}

/**
 * Parse a command line into segments plus the danger flags the policy needs.
 * Segments are split on `;`, `&&`, `||`, `|`, `|&`, `&`, and newlines.
 */
export function parseCommandLine(command: string): ParsedCommandLine {
	const state: ScanState = { hasCommandSubstitution: false, hasProcessSubstitution: false };
	const segments: CommandSegment[] = [];
	let argv: string[] = [];
	let redirects: RedirectInfo[] = [];
	let pendingPipeInto = false;
	let i = 0;

	const flushSegment = (): void => {
		if (argv.length > 0 || redirects.length > 0) {
			segments.push({ argv, redirects, pipedInto: pendingPipeInto });
		} else if (pendingPipeInto) {
			// A pipe with an empty right-hand side: record an empty segment so the
			// pipeline danger (e.g. "curl ... |") is still visible to the policy.
			segments.push({ argv: [], redirects: [], pipedInto: true });
		}
		argv = [];
		redirects = [];
	};

	while (i < command.length) {
		const ch = command[i];
		if (WHITESPACE.has(ch)) {
			i++;
			continue;
		}
		// Control operators that end a segment.
		if (ch === "\n" || ch === ";") {
			flushSegment();
			pendingPipeInto = false;
			i++;
			continue;
		}
		if (ch === "&") {
			if (command[i + 1] === "&") {
				flushSegment();
				pendingPipeInto = false;
				i += 2;
			} else {
				// Background "&" (or the rare "&>" output redirect handled below).
				if (command[i + 1] === ">") {
					// "&>" / "&>>" output redirect.
					const { op, next } = readRedirectOp(command, i + 1, "&");
					const wordStart = skipInlineWhitespace(command, next);
					const { value, next: afterTarget } = readWord(command, wordStart, state);
					redirects.push({ op, target: value, writes: redirectWrites(op, value) });
					i = afterTarget;
					continue;
				}
				flushSegment();
				pendingPipeInto = false;
				i += 1;
			}
			continue;
		}
		if (ch === "|") {
			flushSegment();
			// "|" or "|&": the next segment is piped into.
			pendingPipeInto = true;
			i += command[i + 1] === "&" || command[i + 1] === "|" ? 2 : 1;
			continue;
		}
		// Process substitution <(...) / >(...) — must be tested before the redirect
		// branch, since "<"/">" would otherwise be consumed as a redirect operator.
		if ((ch === "<" || ch === ">") && command[i + 1] === "(") {
			state.hasProcessSubstitution = true;
			i = consumeBalancedParen(command, i + 1, state);
			continue;
		}
		if (ch === ">" || ch === "<") {
			// A digit run immediately before the operator is an fd prefix (e.g. "2>").
			let fdPrefix = "";
			if (argv.length > 0 && /^\d+$/.test(argv[argv.length - 1])) {
				// Only treat trailing digits as an fd when they are glued to the
				// operator (no whitespace consumed between them).
				const prev = argv[argv.length - 1];
				if (i >= prev.length && command.slice(i - prev.length, i) === prev) {
					fdPrefix = prev;
					argv.pop();
				}
			}
			const { op, next } = readRedirectOp(command, i, fdPrefix);
			const wordStart = skipInlineWhitespace(command, next);
			const { value, next: afterTarget } = readWord(command, wordStart, state);
			redirects.push({ op, target: value, writes: redirectWrites(op, value) });
			i = afterTarget;
			continue;
		}
		if (ch === "$" && command[i + 1] === "(") {
			// Bare command substitution as (part of) a word.
			const word = readWord(command, i, state);
			if (word.value) argv.push(word.value);
			i = word.next;
			continue;
		}
		if (ch === "(" || ch === ")") {
			// Subshell grouping. Treat the parens as boundaries; contents are parsed
			// as ordinary segments. Skip the paren itself.
			i++;
			continue;
		}
		// Ordinary word.
		const { value, next } = readWord(command, i, state);
		if (value.length > 0) argv.push(value);
		i = Math.max(next, i + 1);
	}
	flushSegment();

	return {
		segments,
		hasCommandSubstitution: state.hasCommandSubstitution,
		hasProcessSubstitution: state.hasProcessSubstitution,
		parseError: state.parseError,
	};
}

function skipInlineWhitespace(src: string, start: number): number {
	let i = start;
	while (i < src.length && WHITESPACE.has(src[i])) i++;
	return i;
}
