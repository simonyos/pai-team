/**
 * Permission system types and constants (Wave 1, slice S1).
 *
 * Pure data and constants only. This module must not import from the extensions
 * or settings layers so those modules can depend on it without import cycles.
 */

export type PermissionMode = "default" | "plan" | "acceptEdits" | "bypassPermissions" | "dontAsk";

export const PERMISSION_MODES: readonly PermissionMode[] = [
	"default",
	"plan",
	"acceptEdits",
	"bypassPermissions",
	"dontAsk",
];

export type PermissionBehavior = "allow" | "ask" | "deny";

export type PermissionRuleSource = "user" | "project" | "local" | "flag" | "policy" | "session";

/** A rule subject: a tool name, optionally scoped to argument content (e.g. a bash command prefix). */
export interface PermissionRuleValue {
	toolName: string;
	/** When omitted the rule applies to every call of the tool. */
	ruleContent?: string;
}

export interface PermissionRule {
	source: PermissionRuleSource;
	behavior: PermissionBehavior;
	value: PermissionRuleValue;
}

/** Outcome of a permission decision. "passthrough" defers to rules/mode. */
export type PermissionResult =
	| { behavior: "allow"; updatedInput?: Record<string, unknown> }
	| { behavior: "ask"; message: string; suggestion?: PermissionRuleValue }
	| { behavior: "deny"; message: string }
	| { behavior: "passthrough" };

/** Built-in tools that only read state. Auto-allowed by the resolver and permitted in plan mode. */
export const BUILTIN_READ_ONLY_TOOLS: ReadonlySet<string> = new Set(["read", "grep", "find", "ls"]);

/** Built-in tools that create or modify files. Auto-allowed in acceptEdits mode. */
export const EDIT_TOOLS: ReadonlySet<string> = new Set(["edit", "write"]);
