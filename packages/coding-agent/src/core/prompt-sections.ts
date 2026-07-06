/**
 * Composable system-prompt sections (Wave 0.2 + Wave 1.5, slice S5; Wave 2.2, slice G3).
 *
 * Introduces a small section registry — `SystemPromptSection { name, compute(ctx) }`
 * — and the safety/behavioral sections that make the model AWARE of the guardrails
 * the permission system (S1), command-safety brain (S2), filesystem scoping (S3),
 * and OS sandbox (S4) ENFORCE. The enforcement already exists; these sections tell
 * the model the rules so it cooperates instead of repeatedly hitting them.
 *
 * G3 adds `GIT_SAFETY_PROTOCOL_SECTION`, a git-mutation-specific specialization of
 * `BEHAVIORAL_POLICY_SECTION` (see `core/git/git-safety-prompt.ts` for the text and
 * scope notes).
 *
 * Cache discipline: every section here computes from per-SESSION-stable inputs
 * (the permission mode), never per-turn volatile content, so appending them keeps
 * the cached prompt prefix stable. Volatile content (date/cwd) stays in the footer.
 */

import { buildGitSafetySection } from "./git/git-safety-prompt.ts";
import type { PermissionMode } from "./permissions/permission-types.ts";

export interface SystemPromptSectionContext {
	/** The active permission mode for the session. */
	permissionMode: PermissionMode;
	/** Whether to include the always-on behavioral policy. Default: true. */
	includeBehavioralPolicy: boolean;
}

export interface SystemPromptSection {
	name: string;
	/** Render the section body, or return null to omit it. */
	compute(ctx: SystemPromptSectionContext): string | null;
}

const BEHAVIORAL_POLICY = `<behavioral_policy>
Operating principles:
- Blast radius: prefer the smallest change that satisfies the request. Before destructive or irreversible actions (deleting files, force-pushing, resetting state), pause and confirm intent.
- Respect the user's work: never revert, discard, or overwrite the user's uncommitted changes unless they explicitly ask. Do not run destructive git commands (e.g. reset --hard, checkout ., clean -fd, stash) on their behalf without confirmation.
- Do what was asked: implement what the user requested without unrequested refactors, scope creep, or gold-plating. If you notice adjacent improvements, mention them rather than doing them unprompted.
- Report faithfully: state what you actually did and verified. If a step failed, was skipped, or is unverified, say so plainly. Never claim success you have not confirmed.
</behavioral_policy>`;

/** Always-on behavioral guidance (git safety, anti-gold-plating, faithful reporting). */
export const BEHAVIORAL_POLICY_SECTION: SystemPromptSection = {
	name: "behavioral_policy",
	compute: (ctx) => (ctx.includeBehavioralPolicy ? BEHAVIORAL_POLICY : null),
};

/** Git-mutation-specific guardrails; unconditional, since git is reachable via bash regardless of permission mode. */
export const GIT_SAFETY_PROTOCOL_SECTION: SystemPromptSection = {
	name: "git_safety_protocol",
	compute: () => buildGitSafetySection(),
};

const PERMISSION_INTRO =
	"Your tool calls are checked by a permission system before they run. Read-only operations (reading, searching, listing) are generally allowed; commands that modify files, change system state, or access the network may be auto-approved, prompted for approval, or blocked depending on the mode and rules. If an action is blocked, do not try to circumvent it (no obfuscation, encoding, or alternate tools to evade the check) — explain what you need and why.";

const MODE_NOTES: Partial<Record<PermissionMode, string>> = {
	acceptEdits:
		"Current mode: acceptEdits — file edits are auto-approved; other potentially unsafe actions still follow the normal rules.",
	bypassPermissions:
		"Current mode: bypassPermissions — permission checks are skipped. Be especially careful with destructive actions.",
	dontAsk:
		"Current mode: dontAsk — actions that would otherwise prompt are auto-denied. Prefer read-only and pre-approved operations.",
};

/** Explains the permission posture; adds a mode-specific note for non-default, non-plan modes. */
export const PERMISSION_POLICY_SECTION: SystemPromptSection = {
	name: "permission_policy",
	compute: (ctx) => {
		// Plan mode has its own, stronger section.
		if (ctx.permissionMode === "plan") return null;
		const note = MODE_NOTES[ctx.permissionMode];
		const body = note ? `${PERMISSION_INTRO}\n${note}` : PERMISSION_INTRO;
		return `<permissions>\n${body}\n</permissions>`;
	},
};

const PLAN_MODE = `<plan_mode>
You are in PLAN MODE. Do not modify the workspace: file writes, file edits, and state-changing or networked commands will be blocked by the permission system. Use read-only tools (reading, searching, listing) to investigate thoroughly, then present a concise, concrete plan of the changes you propose — the files you would touch and the approach. Do not begin implementing until the user reviews the plan and switches out of plan mode.
</plan_mode>`;

/** Plan-mode instructions; only present when the session is in plan mode. */
export const PLAN_MODE_SECTION: SystemPromptSection = {
	name: "plan_mode",
	compute: (ctx) => (ctx.permissionMode === "plan" ? PLAN_MODE : null),
};

/** The safety/behavioral sections, in render order. */
export const SAFETY_SECTIONS: readonly SystemPromptSection[] = [
	BEHAVIORAL_POLICY_SECTION,
	GIT_SAFETY_PROTOCOL_SECTION,
	PERMISSION_POLICY_SECTION,
	PLAN_MODE_SECTION,
];

/**
 * Render the safety sections for a context into a single block (sections joined by
 * blank lines), or "" when none apply. Intended to be appended to the system prompt
 * BEFORE the volatile date/cwd footer so the cached prefix stays stable.
 */
export function renderSafetySections(
	ctx: SystemPromptSectionContext,
	sections: readonly SystemPromptSection[] = SAFETY_SECTIONS,
): string {
	const parts: string[] = [];
	for (const section of sections) {
		const body = section.compute(ctx);
		if (body !== null && body.length > 0) parts.push(body);
	}
	return parts.join("\n\n");
}
