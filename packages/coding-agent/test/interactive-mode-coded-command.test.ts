import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

// Exercises the coded (built-in) command registration table in interactive mode
// via the `/ping-builtin` stub command (issue XZI-6).

type CodedCommand = { match: (text: string) => boolean; run: (text: string) => void | Promise<void> };

type CodedCommandContext = {
	codedCommands?: CodedCommand[];
	editor: { setText: (text: string) => void };
	showStatus: (message: string) => void;
	buildCodedCommands: () => CodedCommand[];
	tryHandleCodedCommand: (text: string) => Promise<boolean>;
};

const prototype = InteractiveMode.prototype as unknown as CodedCommandContext;

function createContext(): CodedCommandContext {
	return {
		editor: { setText: vi.fn() },
		showStatus: vi.fn(),
		buildCodedCommands: prototype.buildCodedCommands,
		tryHandleCodedCommand: prototype.tryHandleCodedCommand,
	};
}

describe("InteractiveMode coded-command dispatch", () => {
	it("dispatches /ping-builtin and produces observable output", async () => {
		const context = createContext();

		const handled = await context.tryHandleCodedCommand.call(context, "/ping-builtin");

		expect(handled).toBe(true);
		expect(context.showStatus).toHaveBeenCalledWith("pong (coded-command dispatch OK)");
		expect(context.editor.setText).toHaveBeenCalledWith("");
	});

	it("does not consume ordinary prompts", async () => {
		const context = createContext();

		const handled = await context.tryHandleCodedCommand.call(context, "hello world");

		expect(handled).toBe(false);
		expect(context.showStatus).not.toHaveBeenCalled();
	});
});
