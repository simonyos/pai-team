/**
 * Process hardening: child-environment scrubbing (Wave 1, slice 1.6).
 *
 * Removes the agent's own LLM-provider credentials from the environment handed to
 * spawned child processes (the bash tool, `!` commands). A coding command never
 * legitimately needs pi's model-provider API key, but a prompt-injected or curious
 * command could otherwise read it straight out of `process.env` and exfiltrate it.
 *
 * Deliberately CONSERVATIVE: only well-known model-provider credential variables
 * are scrubbed, so tool-specific secrets that children DO need (GH_TOKEN, NPM_TOKEN,
 * AWS_* for the aws CLI, etc.) are left intact. Pure function; does not mutate
 * `process.env` or its input.
 */

/** LLM-provider credential env vars pi may use to authenticate — never needed by child commands. */
export const SENSITIVE_ENV_VARS: ReadonlySet<string> = new Set([
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_AUTH_TOKEN",
	"ANTHROPIC_ADMIN_KEY",
	"OPENAI_API_KEY",
	"OPENAI_ADMIN_KEY",
	"AZURE_OPENAI_API_KEY",
	"AZURE_OPENAI_KEY",
	"AZURE_API_KEY",
	"GEMINI_API_KEY",
	"GOOGLE_API_KEY",
	"GOOGLE_GENERATIVE_AI_API_KEY",
	"GROQ_API_KEY",
	"MISTRAL_API_KEY",
	"OPENROUTER_API_KEY",
	"XAI_API_KEY",
	"DEEPSEEK_API_KEY",
	"TOGETHER_API_KEY",
	"FIREWORKS_API_KEY",
	"PERPLEXITY_API_KEY",
	"COHERE_API_KEY",
	"CEREBRAS_API_KEY",
	"AWS_BEARER_TOKEN_BEDROCK",
	"PI_API_KEY",
]);

/** True if `name` is a model-provider credential that should be withheld from child processes. */
export function isSensitiveEnvVar(name: string): boolean {
	return SENSITIVE_ENV_VARS.has(name);
}

/**
 * Return a copy of `env` with the agent's model-provider credentials removed.
 * Non-mutating: the input and `process.env` are left untouched.
 */
export function scrubChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const scrubbed: NodeJS.ProcessEnv = {};
	for (const key of Object.keys(env)) {
		if (isSensitiveEnvVar(key)) continue;
		scrubbed[key] = env[key];
	}
	return scrubbed;
}
