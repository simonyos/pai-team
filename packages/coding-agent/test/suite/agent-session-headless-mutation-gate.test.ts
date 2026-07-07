/**
 * Headless mutation gate (Wave 2.2 G0b, Paperclip XZI-7).
 *
 * A mutating git/gh command that resolves to "ask" and reaches a non-interactive
 * session (RPC / print / json — no UI to answer a prompt) is default-denied,
 * closing the gap where `git push` / `gh pr merge` were silently allowed via bash.
 * The same command still prompts ("ask") in the interactive TUI, and an explicit
 * user allow rule still lets it proceed headless (default-deny, not hard-deny).
 */

import { describe, expect, it, vi } from "vitest";
import type { ExtensionUIContext } from "../../src/core/extensions/index.ts";
import type { PermissionResult } from "../../src/core/permissions/index.ts";
import { createHarness, type Harness } from "./harness.ts";

interface PermissionProbe {
	_resolveToolPermission(toolName: string, input: Record<string, unknown>): Promise<PermissionResult>;
}

function resolvePermission(
	harness: Harness,
	toolName: string,
	input: Record<string, unknown>,
): Promise<PermissionResult> {
	return (harness.session as unknown as PermissionProbe)._resolveToolPermission(toolName, input);
}

/** Narrow a result to its deny message, failing loudly if it was not a deny. */
function denyMessage(result: PermissionResult): string {
	if (result.behavior !== "deny") {
		throw new Error(`expected a deny decision, got "${result.behavior}"`);
	}
	return result.message;
}

describe("headless mutation gate", () => {
	it("denies a mutating git command with no rule in a non-interactive session", async () => {
		const harness = await createHarness();
		try {
			const push = await resolvePermission(harness, "bash", { command: "git push origin main" });
			expect(denyMessage(push)).toContain("mutating git/gh command denied");
		} finally {
			harness.cleanup();
		}
	});

	it("denies a mutating gh command with no rule in a non-interactive session", async () => {
		const harness = await createHarness();
		try {
			const merge = await resolvePermission(harness, "bash", { command: "gh pr merge 123" });
			expect(denyMessage(merge)).toContain("mutating git/gh command denied");
		} finally {
			harness.cleanup();
		}
	});

	it("still allows a read-only git command headless (no regression)", async () => {
		const harness = await createHarness();
		try {
			const status = await resolvePermission(harness, "bash", { command: "git status" });
			expect(status.behavior).toBe("allow");
		} finally {
			harness.cleanup();
		}
	});

	it("leaves non-git mutating commands to the global non-interactive toggle", async () => {
		// Default toggle is "allow": a non-git mutation is unaffected by this gate.
		const allowing = await createHarness();
		try {
			const rm = await resolvePermission(allowing, "bash", { command: "rm -rf build" });
			expect(rm.behavior).toBe("allow");
		} finally {
			allowing.cleanup();
		}

		// With the toggle set to "deny", the same non-git command is denied by the
		// global toggle, not by the git/gh gate.
		const denying = await createHarness({ settings: { nonInteractivePermission: "deny" } });
		try {
			const rm = await resolvePermission(denying, "bash", { command: "rm -rf build" });
			expect(denyMessage(rm)).not.toContain("mutating git/gh command denied");
		} finally {
			denying.cleanup();
		}
	});

	it("allows a mutating git command headless WHEN an explicit allow rule is configured", async () => {
		const harness = await createHarness({
			settings: { permissionRules: { allow: ["bash(git push:*)"] } },
		});
		try {
			const push = await resolvePermission(harness, "bash", { command: "git push origin main" });
			expect(push.behavior).toBe("allow");
		} finally {
			harness.cleanup();
		}
	});

	it("still prompts (resolves to ask) for the same command in interactive TUI mode", async () => {
		const harness = await createHarness();
		const select = vi.fn(async (_title: string, _options: string[]) => "Deny");
		const uiContext = {
			select,
			confirm: vi.fn(async () => false),
			input: vi.fn(async () => undefined),
			notify: vi.fn(),
			onTerminalInput: vi.fn(() => () => {}),
			setStatus: vi.fn(),
			setWorkingMessage: vi.fn(),
			setWorkingVisible: vi.fn(),
			setWorkingIndicator: vi.fn(),
			setHiddenThinkingLabel: vi.fn(),
			setWidget: vi.fn(),
			setFooter: vi.fn(),
		} as unknown as ExtensionUIContext;

		try {
			await harness.session.bindExtensions({ uiContext, mode: "tui" });
			const push = await resolvePermission(harness, "bash", { command: "git push origin main" });
			// The interactive prompt was shown — the gate did NOT short-circuit to deny.
			expect(select).toHaveBeenCalledTimes(1);
			expect(select.mock.calls[0][0]).toContain("Allow bash: git push");
			// The user chose "Deny", so the resolved decision is the user's, not the gate's.
			expect(denyMessage(push)).toBe("Denied by user.");
		} finally {
			harness.cleanup();
		}
	});
});
