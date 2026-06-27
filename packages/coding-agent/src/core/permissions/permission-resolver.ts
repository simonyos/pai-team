/**
 * Pure permission decision logic (Wave 1, slice S1).
 *
 * Decides allow / ask / deny from the mode, the flattened rule set, the call's
 * read-only classification, and the tool's own opinion. Surfacing "ask" to the
 * user and persisting "always allow" live in the host (agent-session), so this
 * stays pure and unit-testable.
 */

import { getPermissionSubject, ruleMatches } from "./permission-rules.ts";
import {
	EDIT_TOOLS,
	type PermissionBehavior,
	type PermissionMode,
	type PermissionResult,
	type PermissionRule,
} from "./permission-types.ts";

export interface PermissionEvalInput {
	toolName: string;
	input: Record<string, unknown>;
	mode: PermissionMode;
	rules: PermissionRule[];
	/** Whether this specific call only reads state. */
	isReadOnly: boolean;
	/** Result of the tool's own checkPermissions(), already awaited, if any. */
	toolCheck?: PermissionResult;
}

function findRule(
	rules: PermissionRule[],
	behavior: PermissionBehavior,
	toolName: string,
	input: Record<string, unknown>,
): PermissionRule | undefined {
	return rules.find((rule) => rule.behavior === behavior && ruleMatches(rule.value, toolName, input));
}

function ruleLabel(rule: PermissionRule): string {
	return rule.value.ruleContent ? `${rule.value.toolName}(${rule.value.ruleContent})` : rule.value.toolName;
}

function askResult(i: PermissionEvalInput): PermissionResult {
	const subject = getPermissionSubject(i.toolName, i.input);
	const message = subject ? `Allow ${i.toolName}: ${subject}` : `Allow ${i.toolName}?`;
	return { behavior: "ask", message, suggestion: { toolName: i.toolName, ruleContent: subject || undefined } };
}

/**
 * Pure permission decision. Order (most-restrictive-first): bypass, deny rule,
 * plan-mode gate, allow rule, tool opinion, read-only, acceptEdits, default ask.
 * `dontAsk` converts a final "ask" into "deny" last so it cannot be bypassed.
 */
export function evaluatePermission(evalInput: PermissionEvalInput): PermissionResult {
	const decision = decide(evalInput);
	if (evalInput.mode === "dontAsk" && decision.behavior === "ask") {
		return { behavior: "deny", message: `${decision.message} (auto-denied: dontAsk mode)` };
	}
	return decision;
}

function decide(i: PermissionEvalInput): PermissionResult {
	if (i.mode === "bypassPermissions") {
		return { behavior: "allow" };
	}
	const denyRule = findRule(i.rules, "deny", i.toolName, i.input);
	if (denyRule) {
		return { behavior: "deny", message: `Blocked by deny rule: ${ruleLabel(denyRule)}` };
	}
	if (i.mode === "plan" && !i.isReadOnly) {
		return {
			behavior: "deny",
			message: `Plan mode is read-only; ${i.toolName} cannot run. Present a plan and exit plan mode to proceed.`,
		};
	}
	if (findRule(i.rules, "allow", i.toolName, i.input)) {
		return { behavior: "allow" };
	}
	if (i.toolCheck && i.toolCheck.behavior !== "passthrough") {
		return i.toolCheck;
	}
	if (i.isReadOnly) {
		return { behavior: "allow" };
	}
	if (i.mode === "acceptEdits" && EDIT_TOOLS.has(i.toolName)) {
		return { behavior: "allow" };
	}
	// Mutating tool with no matching allow/deny: ask (an explicit ask rule lands here too).
	return askResult(i);
}
