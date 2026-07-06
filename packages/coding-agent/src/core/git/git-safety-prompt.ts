/**
 * Git Safety Protocol text (Wave 2.2, slice G3).
 *
 * Supplements the generic `behavioral_policy` section (S5) with git-mutation-specific
 * guardrails: the generic section tells the model to be careful with destructive git
 * commands in the abstract; this module spells out the concrete rules (amend vs. new
 * commit, force-push, hook bypass, hook-failure recovery, secret-in-staged-changes,
 * push/PR go-ahead) that a git-aware session should follow.
 *
 * `GIT_SAFETY_PROTOCOL` is exported as a stable, standalone string (and
 * `buildGitSafetySection()` as a stable function entry point) so that a future G4
 * (`/commit`, `/branch`) and G5 (`/commit-push-pr`) slice can import and reuse it when
 * composing their primed prompts, independent of whether this text is also wired into
 * the S5 section registry (see `core/prompt-sections.ts`, `GIT_SAFETY_PROTOCOL_SECTION`).
 *
 * Scope note (owner decisions D5/D7, `WAVE2.2_GIT_TOOLS_DESIGN.md`): v1 intentionally
 * ships without any commit-crediting trailer or PR-footer branding of any kind — no such
 * module exists yet in this slice. `GIT_SAFETY_PROTOCOL` below is verified free of that
 * kind of text by `test/git-safety-prompt.test.ts`.
 */

/** Git-mutation-specific guardrails, supplementing the generic behavioral_policy section. */
export const GIT_SAFETY_PROTOCOL = `<git_safety_protocol>
Git mutation guardrails:
- Prefer creating a NEW commit over amending. Only amend an existing commit when the user explicitly asks to amend.
- Never force-push, or run other destructive/history-rewriting git operations (reset --hard, checkout or restore with a bare dot, clean -fd, branch -D) without the user's explicit confirmation for that specific action.
- Never skip commit hooks (the --no-verify flag) or bypass signing (--no-gpg-sign) unless the user explicitly asks for it.
- If a pre-commit hook fails, the commit did NOT happen: fix the underlying issue the hook flagged, re-stage the affected files, and create a NEW commit. Never amend in this case — there is no prior commit from this attempt to amend.
- Before staging or committing, check what is actually staged rather than assuming. If anything staged looks like it could contain a secret, stop and flag it rather than committing.
- Never push to a shared/remote branch, or open a pull request, without the user's explicit go-ahead for that specific action.
</git_safety_protocol>`;

/**
 * Stable entry point returning the Git Safety Protocol text. Exists independent of the
 * S5 section registry so a future G4/G5 slice can pull the protocol text directly when
 * composing a primed prompt for `/commit`, `/branch`, or `/commit-push-pr`.
 */
export function buildGitSafetySection(): string {
	return GIT_SAFETY_PROTOCOL;
}
