import { describe, expect, it } from "vitest";
import { evaluatePermission, type PermissionEvalInput } from "../src/core/permissions/permission-resolver.ts";
import {
	flattenRules,
	formatPermissionRule,
	getPermissionSubject,
	matchContent,
	parsePermissionRule,
	ruleMatches,
} from "../src/core/permissions/permission-rules.ts";

function evalInput(partial: Partial<PermissionEvalInput> & Pick<PermissionEvalInput, "toolName">): PermissionEvalInput {
	return { input: {}, mode: "default", rules: [], isReadOnly: false, ...partial };
}

describe("parsePermissionRule / formatPermissionRule", () => {
	it("parses tool-wide and scoped rules", () => {
		expect(parsePermissionRule("bash")).toEqual({ toolName: "bash" });
		expect(parsePermissionRule("bash(npm run test:*)")).toEqual({ toolName: "bash", ruleContent: "npm run test:*" });
	});

	it("treats empty and wildcard content as tool-wide", () => {
		expect(parsePermissionRule("bash()")).toEqual({ toolName: "bash" });
		expect(parsePermissionRule("bash(*)")).toEqual({ toolName: "bash" });
	});

	it("returns null for malformed rules", () => {
		expect(parsePermissionRule("")).toBeNull();
		expect(parsePermissionRule("(no name)")).toBeNull();
	});

	it("round-trips through format", () => {
		expect(formatPermissionRule({ toolName: "bash", ruleContent: "git status" })).toBe("bash(git status)");
		expect(formatPermissionRule({ toolName: "read" })).toBe("read");
	});
});

describe("matchContent / ruleMatches / getPermissionSubject", () => {
	it("matches exact, prefix (:*), and glob (*)", () => {
		expect(matchContent("git status", "git status")).toBe(true);
		expect(matchContent("git status", "git push")).toBe(false);
		expect(matchContent("npm run test:*", "npm run test:unit")).toBe(true);
		expect(matchContent("npm run test:*", "npm run build")).toBe(false);
		expect(matchContent("npm run test:*", "npm run testfoo")).toBe(false);
		expect(matchContent("git status:*", "git status --short")).toBe(true);
		expect(matchContent("*.env", "config.env")).toBe(true);
		expect(matchContent("*.env", "config.txt")).toBe(false);
	});

	it("derives the subject per tool", () => {
		expect(getPermissionSubject("bash", { command: "rm -rf /" })).toBe("rm -rf /");
		expect(getPermissionSubject("write", { file_path: "/tmp/x" })).toBe("/tmp/x");
		expect(getPermissionSubject("read", {})).toBe("");
	});

	it("tool-wide rules match any input; scoped rules match the subject", () => {
		expect(ruleMatches({ toolName: "bash" }, "bash", { command: "anything" })).toBe(true);
		expect(ruleMatches({ toolName: "bash", ruleContent: "git status" }, "bash", { command: "git status" })).toBe(
			true,
		);
		expect(ruleMatches({ toolName: "bash", ruleContent: "git status" }, "bash", { command: "git push" })).toBe(false);
		expect(ruleMatches({ toolName: "bash" }, "read", { command: "x" })).toBe(false);
	});
});

describe("flattenRules", () => {
	it("flattens behavior lists and skips malformed entries", () => {
		const rules = flattenRules({ allow: ["read"], deny: ["bash(rm -rf /)", "()bad"], ask: [] });
		expect(rules).toEqual([
			{ source: "user", behavior: "deny", value: { toolName: "bash", ruleContent: "rm -rf /" } },
			{ source: "user", behavior: "allow", value: { toolName: "read" } },
		]);
	});
});

describe("evaluatePermission", () => {
	it("auto-allows read-only tools in default mode", () => {
		expect(evaluatePermission(evalInput({ toolName: "read", isReadOnly: true })).behavior).toBe("allow");
	});

	it("asks for an un-ruled mutating tool in default mode", () => {
		const result = evaluatePermission(evalInput({ toolName: "write", input: { file_path: "/a" } }));
		expect(result.behavior).toBe("ask");
		if (result.behavior === "ask") {
			expect(result.suggestion).toEqual({ toolName: "write", ruleContent: "/a" });
		}
	});

	it("honors deny rules even for read-only tools", () => {
		const result = evaluatePermission(
			evalInput({
				toolName: "read",
				isReadOnly: true,
				rules: flattenRules({ deny: ["read"] }),
			}),
		);
		expect(result.behavior).toBe("deny");
	});

	it("honors allow rules for mutating tools", () => {
		const result = evaluatePermission(
			evalInput({
				toolName: "bash",
				input: { command: "npm run test:unit" },
				rules: flattenRules({ allow: ["bash(npm run test:*)"] }),
			}),
		);
		expect(result.behavior).toBe("allow");
	});

	it("plan mode allows read-only and denies mutating tools", () => {
		expect(evaluatePermission(evalInput({ toolName: "grep", mode: "plan", isReadOnly: true })).behavior).toBe(
			"allow",
		);
		expect(evaluatePermission(evalInput({ toolName: "edit", mode: "plan" })).behavior).toBe("deny");
	});

	it("plan mode denies a mutating tool even with an allow rule", () => {
		expect(
			evaluatePermission(evalInput({ toolName: "edit", mode: "plan", rules: flattenRules({ allow: ["edit"] }) }))
				.behavior,
		).toBe("deny");
	});

	it("dontAsk still allows read-only and allow-ruled calls", () => {
		expect(evaluatePermission(evalInput({ toolName: "read", mode: "dontAsk", isReadOnly: true })).behavior).toBe(
			"allow",
		);
		expect(
			evaluatePermission(
				evalInput({
					toolName: "bash",
					mode: "dontAsk",
					input: { command: "ls" },
					rules: flattenRules({ allow: ["bash(ls)"] }),
				}),
			).behavior,
		).toBe("allow");
	});

	it("asks for an unknown custom tool with no read-only metadata", () => {
		expect(evaluatePermission(evalInput({ toolName: "some_custom_tool", input: {} })).behavior).toBe("ask");
	});

	it("acceptEdits auto-allows edit/write but still asks for bash", () => {
		expect(evaluatePermission(evalInput({ toolName: "edit", mode: "acceptEdits" })).behavior).toBe("allow");
		expect(evaluatePermission(evalInput({ toolName: "write", mode: "acceptEdits" })).behavior).toBe("allow");
		expect(evaluatePermission(evalInput({ toolName: "bash", mode: "acceptEdits" })).behavior).toBe("ask");
	});

	it("bypassPermissions allows everything", () => {
		const result = evaluatePermission(
			evalInput({ toolName: "bash", mode: "bypassPermissions", rules: flattenRules({ deny: ["bash"] }) }),
		);
		expect(result.behavior).toBe("allow");
	});

	it("dontAsk converts a default ask into deny", () => {
		expect(evaluatePermission(evalInput({ toolName: "write", mode: "dontAsk" })).behavior).toBe("deny");
	});

	it("consults the tool's own checkPermissions opinion", () => {
		expect(
			evaluatePermission(evalInput({ toolName: "bash", toolCheck: { behavior: "deny", message: "no" } })).behavior,
		).toBe("deny");
		expect(evaluatePermission(evalInput({ toolName: "bash", toolCheck: { behavior: "allow" } })).behavior).toBe(
			"allow",
		);
		// passthrough defers to default handling (ask for mutating)
		expect(evaluatePermission(evalInput({ toolName: "bash", toolCheck: { behavior: "passthrough" } })).behavior).toBe(
			"ask",
		);
	});
});
