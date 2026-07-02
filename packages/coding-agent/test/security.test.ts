import { describe, expect, it } from "vitest";
import { isSensitiveEnvVar, SENSITIVE_ENV_VARS, scrubChildEnv } from "../src/core/security/env-hardening.ts";
import { containsSecret, redactSecrets } from "../src/core/security/secret-redaction.ts";
import { createBashTool } from "../src/core/tools/bash.ts";

describe("redactSecrets", () => {
	const key = (prefix: string, n = 32) => prefix + "A1b2C3d4".repeat(Math.ceil(n / 8)).slice(0, n);

	it("redacts well-known token formats", () => {
		const cases = [
			`sk-ant-${"a".repeat(40)}`,
			`sk-${"b".repeat(32)}`,
			`sk-proj-${"c".repeat(32)}`,
			`ghp_${"d".repeat(36)}`,
			`gho_${"e".repeat(36)}`,
			`github_pat_${"f".repeat(30)}`,
			"AKIAIOSFODNN7EXAMPLE",
			key("AIza", 35),
			`xoxb-${"1".repeat(20)}`,
			`sk_live_${"z".repeat(24)}`,
			"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N",
		];
		for (const secret of cases) {
			const out = redactSecrets(`value is ${secret} end`);
			expect(out, secret).toContain("[REDACTED]");
			expect(out, secret).not.toContain(secret);
		}
	});

	it("redacts the token in a Bearer header but keeps the header word", () => {
		const out = redactSecrets(`Authorization: Bearer ${"a".repeat(40)}`);
		expect(out).toContain("Bearer [REDACTED]");
		expect(out).not.toMatch(/a{40}/);
	});

	it("redacts PEM private key blocks", () => {
		const pem = "-----BEGIN OPENSSH PRIVATE KEY-----\nabc123def456\nghi789\n-----END OPENSSH PRIVATE KEY-----";
		const out = redactSecrets(`key:\n${pem}\ndone`);
		expect(out).toContain("[REDACTED PRIVATE KEY]");
		expect(out).not.toContain("abc123def456");
	});

	it("redacts a secret in env-dump style output, keeping the variable name", () => {
		const out = redactSecrets(`ANTHROPIC_API_KEY=sk-ant-${"x".repeat(40)}`);
		expect(out).toContain("ANTHROPIC_API_KEY=");
		expect(out).toContain("[REDACTED]");
		expect(out).not.toContain("x".repeat(40));
	});

	it("does NOT redact benign strings (near-zero false positives)", () => {
		const benign = [
			"the commit is a1b2c3d4e5f67890a1b2c3d4e5f67890abcdef12", // 40-hex git SHA
			"id: 550e8400-e29b-41d4-a716-446655440000", // uuid
			"risk-management-plan-for-the-next-quarter-review", // 'sk-' inside a word
			"run npm test and check the results",
			"Bearer token missing", // 'Bearer' without a token
			"base64: aGVsbG8gd29ybGQ", // short base64
		];
		for (const text of benign) {
			expect(redactSecrets(text), text).toBe(text);
		}
	});

	it("containsSecret detects presence without mutating", () => {
		expect(containsSecret(`x sk-ant-${"a".repeat(40)} y`)).toBe(true);
		expect(containsSecret("just some normal text")).toBe(false);
		// stable across repeated calls (no lastIndex leakage on global regexes)
		expect(containsSecret("just some normal text")).toBe(false);
	});

	it("is a no-op for empty input", () => {
		expect(redactSecrets("")).toBe("");
	});
});

describe("redactSecrets — expanded coverage (1.6 review)", () => {
	it("redacts additional high-signal provider token formats", () => {
		const cases = [
			`glpat-${"a".repeat(20)}`,
			`xapp-1-A012345678-012345678901-${"b".repeat(20)}`,
			`whsec_${"c".repeat(24)}`,
			`npm_${"d".repeat(36)}`,
			`SG.${"e".repeat(20)}.${"f".repeat(30)}`,
			`dop_v1_${"0".repeat(40)}`,
		];
		for (const secret of cases) {
			const out = redactSecrets(`x ${secret} y`);
			expect(out, secret).toContain("[REDACTED]");
			expect(out, secret).not.toContain(secret);
		}
	});

	it("redacts a 2-segment (unsigned) JWT and an Azure AccountKey", () => {
		expect(redactSecrets("eyJhbGciOiJub25lIn0.eyJzdWIiOiJhZG1pbiJ9")).toContain("[REDACTED]");
		const azure = `AccountKey=${"A".repeat(48)}==`;
		expect(redactSecrets(azure)).toContain("AccountKey=[REDACTED]");
		expect(redactSecrets(azure)).not.toContain("A".repeat(48));
	});

	it("redacts inline URL credentials and Basic/lowercase-bearer auth headers", () => {
		expect(redactSecrets("https://admin:hunter2pass@host/api")).toBe("https://[REDACTED]@host/api");
		expect(redactSecrets("Authorization: Basic dXNlcjpwYXNzd29yZDEyMzQ=")).toContain("Basic [REDACTED]");
		expect(redactSecrets(`authorization: bearer ${"a".repeat(30)}`)).toContain("bearer [REDACTED]");
	});

	it("redacts a secret VALUE assigned to a secret-NAMED variable, even without a token prefix", () => {
		expect(redactSecrets('ANTHROPIC_API_KEY: "myPlainValue12345"')).toContain("ANTHROPIC_API_KEY:");
		expect(redactSecrets('ANTHROPIC_API_KEY: "myPlainValue12345"')).not.toContain("myPlainValue12345");
		expect(redactSecrets("DB_PASSWORD=pXq9mZ2vLt83Qw")).toBe("DB_PASSWORD=[REDACTED]");
		expect(redactSecrets("API_TOKEN=abc123def456")).toBe("API_TOKEN=[REDACTED]");
		expect(redactSecrets("SESSION_SECRET='s3cr3t'")).toContain("[REDACTED]");
	});

	it("does NOT redact benign variable assignments (secret-word not the name suffix)", () => {
		for (const text of [
			"MAX_TOKENS=4096",
			"PASSWORD_MIN_LENGTH=8",
			"TIMEOUT=30",
			"TOKEN_COUNT: 5",
			"RETRY_LIMIT=3",
		]) {
			expect(redactSecrets(text), text).toBe(text);
		}
	});
});

describe("scrubChildEnv", () => {
	it("removes model-provider credentials but keeps everything else", () => {
		const env = {
			PATH: "/usr/bin",
			HOME: "/home/dev",
			ANTHROPIC_API_KEY: "sk-ant-secret",
			OPENAI_API_KEY: "sk-secret",
			GH_TOKEN: "ghp_keepme", // tool credential children legitimately use
			NPM_TOKEN: "npm_keepme",
			AWS_SECRET_ACCESS_KEY: "aws-keepme", // aws CLI needs it; not scrubbed
			MY_APP_SETTING: "value",
		};
		const scrubbed = scrubChildEnv(env);
		expect(scrubbed.ANTHROPIC_API_KEY).toBeUndefined();
		expect(scrubbed.OPENAI_API_KEY).toBeUndefined();
		expect(scrubbed.PATH).toBe("/usr/bin");
		expect(scrubbed.HOME).toBe("/home/dev");
		expect(scrubbed.GH_TOKEN).toBe("ghp_keepme");
		expect(scrubbed.NPM_TOKEN).toBe("npm_keepme");
		expect(scrubbed.AWS_SECRET_ACCESS_KEY).toBe("aws-keepme");
		expect(scrubbed.MY_APP_SETTING).toBe("value");
	});

	it("does not mutate its input", () => {
		const env = { ANTHROPIC_API_KEY: "sk-ant-x", PATH: "/bin" };
		scrubChildEnv(env);
		expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-x");
	});

	it("isSensitiveEnvVar / SENSITIVE_ENV_VARS agree", () => {
		expect(isSensitiveEnvVar("ANTHROPIC_API_KEY")).toBe(true);
		expect(isSensitiveEnvVar("GH_TOKEN")).toBe(false);
		expect(SENSITIVE_ENV_VARS.has("OPENAI_API_KEY")).toBe(true);
	});
});

describe("bash tool redacts secrets in output", () => {
	it("redacts a leaked token from command output before returning it", async () => {
		const secret = `sk-ant-${"a".repeat(40)}`;
		const tool = createBashTool("/tmp", {
			commandSafety: false,
			operations: {
				exec: async (_command, _cwd, { onData }) => {
					onData(Buffer.from(`ANTHROPIC_API_KEY=${secret}\n`));
					return { exitCode: 0 };
				},
			},
		});
		const result = await tool.execute("t1", { command: "env" });
		const text = JSON.stringify(result.content);
		expect(text).toContain("[REDACTED]");
		expect(text).not.toContain(secret);
	});
});
