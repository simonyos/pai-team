/**
 * Print mode (single-shot): Send prompts, output result, exit.
 *
 * Used for:
 * - `pi -p "prompt"` - text output
 * - `pi --mode json "prompt"` - JSON event stream
 */

import type { AssistantMessage, ImageContent } from "@earendil-works/pi-ai";
import type { AgentSession } from "../core/agent-session.ts";
import type { AgentSessionRuntime } from "../core/agent-session-runtime.ts";
import { buildBranchCommand } from "../core/git/branch-command.ts";
import { buildCommitCommand } from "../core/git/commit-command.ts";
import { buildCommitPushPrCommand } from "../core/git/commit-push-pr-command.ts";
import { flushRawStdout, writeRawStdout } from "../core/output-guard.ts";
import { killTrackedDetachedChildren } from "../utils/shell.ts";

/**
 * Options for print mode.
 */
export interface PrintModeOptions {
	/** Output mode: "text" for final response only, "json" for all events */
	mode: "text" | "json";
	/** Array of additional prompts to send after initialMessage */
	messages?: string[];
	/** First message to send (may contain @file content) */
	initialMessage?: string;
	/** Images to attach to the initial message */
	initialImages?: ImageContent[];
}

/**
 * Prints/emits a `/commit` or `/branch` result: on refusal, surface the refusal
 * message (and never call `sendUserMessage`); on success, hand the primed
 * prompt to the model via `session.sendUserMessage` (which always triggers a
 * turn — the resulting assistant response flows through the normal text/json
 * output paths in `runPrintMode`).
 */
async function reportCodedGitCommandResult(
	mode: "text" | "json",
	command: "commit" | "branch" | "commit-push-pr",
	result: { kind: "refuse"; message: string } | { kind: "prompt"; text: string },
	session: AgentSession,
): Promise<void> {
	if (result.kind === "refuse") {
		if (mode === "json") {
			writeRawStdout(
				`${JSON.stringify({ type: "coded_command", command, refused: true, message: result.message })}\n`,
			);
		} else {
			writeRawStdout(`${result.message}\n`);
		}
		return;
	}

	if (mode === "json") {
		writeRawStdout(`${JSON.stringify({ type: "coded_command", command, refused: false })}\n`);
	}
	await session.sendUserMessage(result.text);
}

/**
 * CODED SLASH-COMMAND REGISTRATION POINT (print/headless mode).
 *
 * Print mode has no first-class-command UI; without this hook a built-in
 * ("coded") command would fall through to session.prompt() and be sent to the
 * LLM as literal text. Every message is checked here before prompting; a
 * matching command is handled and produces observable output instead.
 *
 * To wire a future first-class command: add a branch here. `/ping-builtin` is
 * a permanent no-op reference command that exercises this path end-to-end.
 * `/commit`/`/branch` (Wave 2.2 G4) are the first real commands on this path —
 * both need `session` (to read live git state / cwd and call
 * `sendUserMessage`), which is why this function takes it as a parameter.
 *
 * Returns true if the message was handled as a coded command.
 */
async function handleCodedCommand(message: string, mode: "text" | "json", session: AgentSession): Promise<boolean> {
	const trimmed = message.trim();
	if (trimmed === "/ping-builtin") {
		if (mode === "json") {
			writeRawStdout(`${JSON.stringify({ type: "coded_command", command: "ping-builtin", output: "pong" })}\n`);
		} else {
			writeRawStdout("pong\n");
		}
		return true;
	}

	if (trimmed === "/commit-push-pr" || trimmed.startsWith("/commit-push-pr ")) {
		const args = trimmed.startsWith("/commit-push-pr ") ? trimmed.slice("/commit-push-pr ".length).trim() : "";
		const result = await buildCommitPushPrCommand(session.sessionManager.getCwd(), args);
		await reportCodedGitCommandResult(mode, "commit-push-pr", result, session);
		return true;
	}

	if (trimmed === "/commit" || trimmed.startsWith("/commit ")) {
		const args = trimmed.startsWith("/commit ") ? trimmed.slice("/commit ".length).trim() : "";
		const result = await buildCommitCommand(session.sessionManager.getCwd(), args);
		await reportCodedGitCommandResult(mode, "commit", result, session);
		return true;
	}

	if (trimmed === "/branch" || trimmed.startsWith("/branch ")) {
		const args = trimmed.startsWith("/branch ") ? trimmed.slice("/branch ".length).trim() : "";
		const result = await buildBranchCommand(session.sessionManager.getCwd(), args);
		await reportCodedGitCommandResult(mode, "branch", result, session);
		return true;
	}

	return false;
}

/**
 * Run in print (single-shot) mode.
 * Sends prompts to the agent and outputs the result.
 */
export async function runPrintMode(runtimeHost: AgentSessionRuntime, options: PrintModeOptions): Promise<number> {
	const { mode, messages = [], initialMessage, initialImages } = options;
	let exitCode = 0;
	let session = runtimeHost.session;
	let unsubscribe: (() => void) | undefined;
	let disposed = false;
	const signalCleanupHandlers: Array<() => void> = [];

	const disposeRuntime = async (): Promise<void> => {
		if (disposed) return;
		disposed = true;
		unsubscribe?.();
		await runtimeHost.dispose();
	};

	const registerSignalHandlers = (): void => {
		const signals: NodeJS.Signals[] = ["SIGTERM"];
		if (process.platform !== "win32") {
			signals.push("SIGHUP");
		}

		for (const signal of signals) {
			const handler = () => {
				killTrackedDetachedChildren();
				void disposeRuntime().finally(() => {
					process.exit(signal === "SIGHUP" ? 129 : 143);
				});
			};
			process.on(signal, handler);
			signalCleanupHandlers.push(() => process.off(signal, handler));
		}
	};

	registerSignalHandlers();

	runtimeHost.setRebindSession(async () => {
		await rebindSession();
	});

	const rebindSession = async (): Promise<void> => {
		session = runtimeHost.session;
		await session.bindExtensions({
			mode: mode === "json" ? "json" : "print",
			commandContextActions: {
				waitForIdle: () => session.agent.waitForIdle(),
				newSession: async (newSessionOptions) => runtimeHost.newSession(newSessionOptions),
				fork: async (entryId, forkOptions) => {
					const result = await runtimeHost.fork(entryId, forkOptions);
					return { cancelled: result.cancelled };
				},
				navigateTree: async (targetId, navigateOptions) => {
					const result = await session.navigateTree(targetId, {
						summarize: navigateOptions?.summarize,
						customInstructions: navigateOptions?.customInstructions,
						replaceInstructions: navigateOptions?.replaceInstructions,
						label: navigateOptions?.label,
					});
					return { cancelled: result.cancelled };
				},
				switchSession: async (sessionPath, switchOptions) => {
					return runtimeHost.switchSession(sessionPath, switchOptions);
				},
				reload: async () => {
					await session.reload();
				},
			},
			onError: (err) => {
				console.error(`Extension error (${err.extensionPath}): ${err.error}`);
			},
		});

		unsubscribe?.();
		unsubscribe = session.subscribe((event) => {
			if (mode === "json") {
				writeRawStdout(`${JSON.stringify(event)}\n`);
			}
		});
	};

	try {
		if (mode === "json") {
			const header = session.sessionManager.getHeader();
			if (header) {
				writeRawStdout(`${JSON.stringify(header)}\n`);
			}
		}

		await rebindSession();

		if (initialMessage && !(await handleCodedCommand(initialMessage, mode, session))) {
			await session.prompt(initialMessage, { images: initialImages });
		}

		for (const message of messages) {
			if (!(await handleCodedCommand(message, mode, session))) {
				await session.prompt(message);
			}
		}

		if (mode === "text") {
			const state = session.state;
			const lastMessage = state.messages[state.messages.length - 1];

			if (lastMessage?.role === "assistant") {
				const assistantMsg = lastMessage as AssistantMessage;
				if (assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") {
					console.error(assistantMsg.errorMessage || `Request ${assistantMsg.stopReason}`);
					exitCode = 1;
				} else {
					for (const content of assistantMsg.content) {
						if (content.type === "text") {
							writeRawStdout(`${content.text}\n`);
						}
					}
				}
			}
		}

		return exitCode;
	} catch (error: unknown) {
		console.error(error instanceof Error ? error.message : String(error));
		return 1;
	} finally {
		for (const cleanup of signalCleanupHandlers) {
			cleanup();
		}
		await disposeRuntime();
		await flushRawStdout();
	}
}
