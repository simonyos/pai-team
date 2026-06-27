/**
 * Command-safety engine (Wave 1, slice S2) — public surface.
 *
 * A pure decision brain ported from Codex `execpolicy`: it classifies a bash
 * command line as allow / prompt / forbidden using argv-token prefix rules and a
 * read-only safelist, and exposes the read-only classifier the permission
 * resolver uses for plan-mode gating. Wired into the bash tool via
 * classifyReadOnly + checkPermissions.
 */

export { checkBashPermission, classifyBashReadOnly } from "./command-safety.ts";
export { type Decision, mostRestrictive, mostRestrictiveOf } from "./decision.ts";
export { defaultExecPolicy, type ExecEval, ExecPolicy } from "./policy.ts";
export {
	alts,
	exactPrefixRule,
	matchPrefix,
	type PatternToken,
	type PrefixPattern,
	type PrefixRule,
	single,
} from "./rule.ts";
export { type CommandSegment, type ParsedCommandLine, parseCommandLine, type RedirectInfo } from "./tokenize.ts";
