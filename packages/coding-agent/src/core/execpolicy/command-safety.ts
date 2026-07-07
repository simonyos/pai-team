/**
 * Bridge from the command-safety policy to pi's permission system (Wave 1, slice S2).
 *
 * Maps an `ExecEval` (allow / prompt / forbidden) onto a `PermissionResult` that
 * the bash tool returns from checkPermissions(), and provides the read-only
 * classifier the resolver uses for plan-mode gating and auto-allow.
 */

import type { PermissionResult, PermissionRuleValue } from "../permissions/index.ts";
import { defaultExecPolicy, type ExecPolicy } from "./policy.ts";

function truncate(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Build the "always allow" suggestion: a prefix rule (`git push:*`) or the exact command. */
function suggestionFor(command: string, prefix: string[] | undefined): PermissionRuleValue {
	if (prefix && prefix.length > 0) {
		return { toolName: "bash", ruleContent: `${prefix.join(" ")}:*` };
	}
	return { toolName: "bash", ruleContent: command.trim() };
}

/** Is this bash command structurally read-only? Drives plan-mode gating and auto-allow. */
export function classifyBashReadOnly(command: string, policy: ExecPolicy = defaultExecPolicy): boolean {
	return policy.isReadOnly(command);
}

/** Programs whose mutating invocations the headless mutation gate default-denies. */
const GIT_GH_PROGRAMS: ReadonlySet<string> = new Set(["git", "gh"]);

/**
 * Is this bash command a MUTATING git or gh invocation? True when the command names
 * git or gh as a program in any segment AND is not classified read-only. Drives the
 * headless mutation gate (G0b): when no interactive approval is possible, a
 * state-changing git/gh command (e.g. `git push`, `gh pr merge`) with no explicit
 * allow rule is denied rather than silently allowed. Reuses `classifyBashReadOnly`
 * as the single source of truth for "mutating" — no second verb list. Coarse by
 * design: a compound command mixing git/gh with another mutation
 * (`git status && rm foo`) is also treated as mutating, which only tightens the gate.
 */
export function classifyBashGitOrGhMutation(command: string, policy: ExecPolicy = defaultExecPolicy): boolean {
	if (!policy.invokesAnyProgram(command, GIT_GH_PROGRAMS)) return false;
	return !policy.isReadOnly(command);
}

/** Decide whether a bash command may run, asking or blocking per the command-safety policy. */
export function checkBashPermission(command: string, policy: ExecPolicy = defaultExecPolicy): PermissionResult {
	const evaluation = policy.check(command);
	switch (evaluation.decision) {
		case "forbidden":
			return {
				behavior: "deny",
				message: `Blocked dangerous command: ${evaluation.justification ?? "matches a forbidden pattern"}`,
			};
		case "prompt": {
			const reason = evaluation.justification ? ` — ${evaluation.justification}` : "";
			return {
				behavior: "ask",
				message: `Allow bash: ${truncate(command, 80)}${reason}`,
				suggestion: suggestionFor(command, evaluation.suggestionPrefix),
			};
		}
		default:
			// Read-only / safelisted (or a seeded allow rule). The resolver still applies
			// deny rules and the plan-mode gate BEFORE this opinion, so allowing here is
			// safe and additionally honors seeded allow rules for non-read-only commands.
			return { behavior: "allow" };
	}
}
