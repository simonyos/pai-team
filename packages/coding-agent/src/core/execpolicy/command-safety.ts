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
