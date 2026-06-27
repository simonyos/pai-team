/**
 * Permission rule parsing and matching (Wave 1, slice S1).
 *
 * Rules are written as "Tool" (tool-wide) or "Tool(content)" (scoped to an
 * argument subject, e.g. a bash command prefix or a file path glob).
 */

import type { PermissionBehavior, PermissionRule, PermissionRuleValue } from "./permission-types.ts";

const RULE_PATTERN = /^([A-Za-z_][\w-]*)(?:\(([\s\S]*)\))?$/;

/** Parse "Tool" or "Tool(content)" into a rule value. Returns null when malformed. */
export function parsePermissionRule(raw: string): PermissionRuleValue | null {
	const match = RULE_PATTERN.exec(raw.trim());
	if (!match) return null;
	const toolName = match[1];
	const ruleContent = match[2];
	if (ruleContent === undefined || ruleContent === "" || ruleContent === "*") {
		return { toolName };
	}
	return { toolName, ruleContent };
}

/** Format a rule value back into its canonical string form. */
export function formatPermissionRule(value: PermissionRuleValue): string {
	return value.ruleContent ? `${value.toolName}(${value.ruleContent})` : value.toolName;
}

/** Extract the salient string a content rule matches against, per tool. */
export function getPermissionSubject(toolName: string, input: Record<string, unknown>): string {
	const primaryField = toolName === "bash" ? "command" : toolName === "grep" ? "pattern" : "file_path";
	const candidates = [input[primaryField], input.command, input.file_path, input.path, input.pattern];
	for (const candidate of candidates) {
		if (typeof candidate === "string" && candidate.length > 0) return candidate;
	}
	return "";
}

/** Match a content pattern against a subject: prefix ("x:*"), glob ("x*"), or exact. */
export function matchContent(pattern: string, subject: string): boolean {
	if (pattern.endsWith(":*")) {
		const prefix = pattern.slice(0, -2);
		return subject === prefix || subject.startsWith(prefix);
	}
	if (pattern.includes("*")) {
		const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
		return new RegExp(`^${escaped}$`).test(subject);
	}
	return subject === pattern;
}

/** Does a rule apply to this (toolName, input)? */
export function ruleMatches(value: PermissionRuleValue, toolName: string, input: Record<string, unknown>): boolean {
	if (value.toolName !== toolName) return false;
	if (!value.ruleContent) return true;
	return matchContent(value.ruleContent, getPermissionSubject(toolName, input));
}

/** Flatten settings-style rule string lists into typed rules (malformed entries skipped). */
export function flattenRules(
	raw: { allow?: string[]; ask?: string[]; deny?: string[] },
	source: PermissionRule["source"] = "user",
): PermissionRule[] {
	const rules: PermissionRule[] = [];
	const add = (behavior: PermissionBehavior, list: string[] | undefined): void => {
		for (const entry of list ?? []) {
			const value = parsePermissionRule(entry);
			if (value) rules.push({ source, behavior, value });
		}
	};
	add("deny", raw.deny);
	add("ask", raw.ask);
	add("allow", raw.allow);
	return rules;
}
