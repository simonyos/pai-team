import { describe, expect, it } from "vitest";
import { buildGitSafetySection, GIT_SAFETY_PROTOCOL } from "../src/core/git/git-safety-prompt.ts";
import { PERMISSION_MODES } from "../src/core/permissions/permission-types.ts";
import { renderSafetySections, type SystemPromptSectionContext } from "../src/core/prompt-sections.ts";
import { buildSystemPrompt } from "../src/core/system-prompt.ts";

function ctx(partial: Partial<SystemPromptSectionContext> = {}): SystemPromptSectionContext {
	return { permissionMode: "default", includeBehavioralPolicy: true, ...partial };
}

describe("GIT_SAFETY_PROTOCOL", () => {
	it("is non-empty and wrapped in the git_safety_protocol tag", () => {
		expect(GIT_SAFETY_PROTOCOL.length).toBeGreaterThan(0);
		expect(GIT_SAFETY_PROTOCOL).toContain("<git_safety_protocol>");
		expect(GIT_SAFETY_PROTOCOL).toContain("</git_safety_protocol>");
	});

	it("covers the key guardrail rules", () => {
		expect(GIT_SAFETY_PROTOCOL).toContain("force-push");
		expect(GIT_SAFETY_PROTOCOL).toContain("amend");
		expect(GIT_SAFETY_PROTOCOL).toContain("--no-verify");
		expect(GIT_SAFETY_PROTOCOL).toContain("hook");
	});

	it("does not reference Co-Authored-By, PR footers, or Claude Code branding", () => {
		expect(GIT_SAFETY_PROTOCOL).not.toContain("Co-Authored-By");
		expect(GIT_SAFETY_PROTOCOL).not.toContain("Generated with");
		expect(GIT_SAFETY_PROTOCOL).not.toContain("Claude Code");
	});
});

describe("buildGitSafetySection", () => {
	it("returns the GIT_SAFETY_PROTOCOL constant", () => {
		expect(buildGitSafetySection()).toBe(GIT_SAFETY_PROTOCOL);
	});

	it("is stable across calls (no arguments, deterministic)", () => {
		expect(buildGitSafetySection()).toBe(buildGitSafetySection());
	});
});

describe("renderSafetySections integration (git_safety_protocol)", () => {
	it("includes git_safety_protocol alongside behavioral_policy in default mode", () => {
		const out = renderSafetySections(ctx());
		expect(out).toContain("<behavioral_policy>");
		expect(out).toContain("<git_safety_protocol>");
	});

	it("is present in EVERY permission mode, since it is unconditional", () => {
		for (const mode of PERMISSION_MODES) {
			const out = renderSafetySections(ctx({ permissionMode: mode }));
			expect(out).toContain("<git_safety_protocol>");
		}
	});

	it("does not vary with includeBehavioralPolicy (it is not gated by ctx)", () => {
		const out = renderSafetySections(ctx({ includeBehavioralPolicy: false }));
		expect(out).toContain("<git_safety_protocol>");
	});

	it("does NOT contain Co-Authored-By, Generated with, or Claude Code anywhere in the rendered output", () => {
		for (const mode of PERMISSION_MODES) {
			const out = renderSafetySections(ctx({ permissionMode: mode }));
			expect(out).not.toContain("Co-Authored-By");
			expect(out).not.toContain("Generated with");
			expect(out).not.toContain("Claude Code");
		}
	});
});

describe("buildSystemPrompt integration (git_safety_protocol)", () => {
	const base = { contextFiles: [], skills: [], cwd: process.cwd() };

	it("keeps git_safety_protocol before the volatile footer", () => {
		const prompt = buildSystemPrompt({ ...base });
		expect(prompt).toContain("<git_safety_protocol>");
		expect(prompt.indexOf("<git_safety_protocol>")).toBeLessThan(prompt.indexOf("Current date:"));
	});

	it("still includes git_safety_protocol in plan mode", () => {
		const prompt = buildSystemPrompt({ ...base, permissionMode: "plan" });
		expect(prompt).toContain("<git_safety_protocol>");
		expect(prompt.indexOf("<git_safety_protocol>")).toBeLessThan(prompt.indexOf("Current date:"));
	});

	it("includes git_safety_protocol before the volatile footer in EVERY permission mode", () => {
		for (const mode of PERMISSION_MODES) {
			const prompt = buildSystemPrompt({ ...base, permissionMode: mode });
			expect(prompt).toContain("<git_safety_protocol>");
			expect(prompt.indexOf("<git_safety_protocol>")).toBeLessThan(prompt.indexOf("Current date:"));
		}
	});

	it("does not leak Co-Authored-By, Generated with, or Claude Code branding into the prompt", () => {
		const prompt = buildSystemPrompt({ ...base });
		expect(prompt).not.toContain("Co-Authored-By");
		expect(prompt).not.toContain("Generated with");
		expect(prompt).not.toContain("Claude Code");
	});
});
