import { describe, expect, it } from "vitest";
import type { PermissionMode } from "../src/core/permissions/permission-types.ts";
import { renderSafetySections, type SystemPromptSectionContext } from "../src/core/prompt-sections.ts";
import { buildSystemPrompt } from "../src/core/system-prompt.ts";

function ctx(partial: Partial<SystemPromptSectionContext> = {}): SystemPromptSectionContext {
	return { permissionMode: "default", includeBehavioralPolicy: true, ...partial };
}

describe("renderSafetySections", () => {
	it("includes behavioral policy + permission posture in default mode, not plan", () => {
		const out = renderSafetySections(ctx());
		expect(out).toContain("<behavioral_policy>");
		expect(out).toContain("<permissions>");
		expect(out).not.toContain("<plan_mode>");
	});

	it("omits behavioral policy when disabled", () => {
		const out = renderSafetySections(ctx({ includeBehavioralPolicy: false }));
		expect(out).not.toContain("<behavioral_policy>");
		expect(out).toContain("<permissions>"); // posture still present
	});

	it("renders the plan section (and not the generic permissions section) in plan mode", () => {
		const out = renderSafetySections(ctx({ permissionMode: "plan" }));
		expect(out).toContain("<plan_mode>");
		expect(out).toContain("PLAN MODE");
		expect(out).not.toContain("<permissions>");
	});

	it("adds a mode-specific note for acceptEdits / bypassPermissions / dontAsk", () => {
		expect(renderSafetySections(ctx({ permissionMode: "acceptEdits" }))).toContain("acceptEdits");
		expect(renderSafetySections(ctx({ permissionMode: "bypassPermissions" }))).toContain("bypassPermissions");
		expect(renderSafetySections(ctx({ permissionMode: "dontAsk" }))).toContain("dontAsk");
	});

	it("is deterministic for a given context (cache-stable)", () => {
		for (const mode of ["default", "plan", "acceptEdits", "bypassPermissions", "dontAsk"] as PermissionMode[]) {
			const a = renderSafetySections(ctx({ permissionMode: mode }));
			const b = renderSafetySections(ctx({ permissionMode: mode }));
			expect(a).toBe(b);
			expect(a).not.toContain("Current date"); // no volatile content in the sections
		}
	});
});

describe("buildSystemPrompt integration (S5)", () => {
	const base = { contextFiles: [], skills: [], cwd: process.cwd() };

	it("includes the behavioral policy by default and keeps it before the volatile footer", () => {
		const prompt = buildSystemPrompt({ ...base });
		expect(prompt).toContain("<behavioral_policy>");
		expect(prompt).toContain("<permissions>");
		expect(prompt).not.toContain("<plan_mode>");
		// Cache discipline: the volatile date/cwd footer stays last.
		expect(prompt.indexOf("<behavioral_policy>")).toBeLessThan(prompt.indexOf("Current date:"));
	});

	it("adds the plan section when in plan mode", () => {
		const prompt = buildSystemPrompt({ ...base, permissionMode: "plan" });
		expect(prompt).toContain("<plan_mode>");
		expect(prompt.indexOf("<plan_mode>")).toBeLessThan(prompt.indexOf("Current date:"));
	});

	it("can opt out of the behavioral policy", () => {
		const prompt = buildSystemPrompt({ ...base, includeBehavioralPolicy: false });
		expect(prompt).not.toContain("<behavioral_policy>");
	});

	it("applies safety sections to a custom base prompt too", () => {
		const prompt = buildSystemPrompt({ ...base, customPrompt: "BASE PROMPT", permissionMode: "plan" });
		expect(prompt).toContain("BASE PROMPT");
		expect(prompt).toContain("<plan_mode>");
		expect(prompt).toContain("<behavioral_policy>");
	});

	it("still includes the existing tools/guidelines content (no regression)", () => {
		const prompt = buildSystemPrompt({ ...base, selectedTools: [] });
		expect(prompt).toContain("Available tools:\n(none)");
		expect(prompt).toContain("Show file paths clearly");
	});
});
