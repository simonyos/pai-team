/**
 * Permission system (Wave 1 safety foundation).
 *
 * S1: allow / ask / deny resolution, modes, and a "Tool(content)" rule format.
 * Later slices add bash command-safety classification (S2), filesystem scoping
 * (S3), and OS-level sandboxing (S4).
 */

export { evaluatePermission, type PermissionEvalInput } from "./permission-resolver.ts";
export {
	flattenRules,
	formatPermissionRule,
	getPermissionSubject,
	matchContent,
	parsePermissionRule,
	ruleMatches,
} from "./permission-rules.ts";
export {
	BUILTIN_READ_ONLY_TOOLS,
	EDIT_TOOLS,
	PERMISSION_MODES,
	type PermissionBehavior,
	type PermissionMode,
	type PermissionResult,
	type PermissionRule,
	type PermissionRuleSource,
	type PermissionRuleValue,
} from "./permission-types.ts";
