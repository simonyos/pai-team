/**
 * Secret redaction (Wave 1, slice 1.6).
 *
 * Redacts token-shaped secrets from text before it enters the model's context or
 * the session transcript — so a command that prints credentials (e.g. `env`,
 * `cat .env`, `printenv`) does not leak them into the conversation or to disk.
 *
 * Design: match WELL-KNOWN, high-signal formats — provider key prefixes, JWTs,
 * PEM blocks, auth headers, inline URL credentials — and secret-looking VALUES
 * assigned to secret-NAMED variables (`*_SECRET=`, `*_TOKEN=`, `*_API_KEY=`).
 * Everything is anchored (word boundaries, name suffixes, or a prefix) to keep
 * false positives near zero: git SHAs, UUIDs, hex digests, and prose are left
 * untouched. Entropy/length-only detection is deliberately avoided.
 *
 * Accepted, documented gaps: unrealistically short prefixed keys (e.g. an `sk-`
 * key under the length floor) and a real key concatenated onto a preceding word
 * char are not matched — closing those would raise false positives on benign
 * look-alikes, which is the wrong trade for output the model reads.
 */

const REDACTED = "[REDACTED]";

interface RedactionRule {
	name: string;
	pattern: RegExp;
	replace: string;
}

// Each rule is applied globally, in order. Order matters where one match could be
// a substring of another (PEM block before inline tokens; sk-ant- before sk-).
const RULES: readonly RedactionRule[] = [
	// PEM private key blocks (RSA / EC / OPENSSH / PGP / …).
	{
		name: "private_key_block",
		pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
		replace: "[REDACTED PRIVATE KEY]",
	},
	// Inline URL basic-auth credentials: scheme://user:pass@host.
	{
		name: "url_credentials",
		pattern: /\b([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/g,
		replace: `$1${REDACTED}@`,
	},
	// Anthropic (sk-ant-…) — before the generic sk- rule.
	{ name: "anthropic_key", pattern: /\bsk-ant-[A-Za-z0-9_-]{12,}/g, replace: REDACTED },
	// OpenAI / generic sk- keys (sk-, sk-proj-…).
	{ name: "openai_key", pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}/g, replace: REDACTED },
	// Stripe secret/restricted keys and webhook signing secrets.
	{ name: "stripe_key", pattern: /\b[rs]k_(?:live|test)_[A-Za-z0-9]{12,}/g, replace: REDACTED },
	{ name: "stripe_webhook", pattern: /\bwhsec_[A-Za-z0-9]{16,}/g, replace: REDACTED },
	// SendGrid API keys (SG.<id>.<secret>).
	{ name: "sendgrid_key", pattern: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, replace: REDACTED },
	// GitLab / DigitalOcean / npm tokens (distinctive prefixes).
	{ name: "gitlab_pat", pattern: /\bglpat-[A-Za-z0-9_-]{16,}/g, replace: REDACTED },
	{ name: "digitalocean_pat", pattern: /\bdop_v1_[A-Za-z0-9]{32,}/g, replace: REDACTED },
	{ name: "npm_token", pattern: /\bnpm_[A-Za-z0-9]{30,}/g, replace: REDACTED },
	// GitHub tokens: ghp_/gho_/ghu_/ghs_/ghr_ and fine-grained github_pat_.
	{ name: "github_token", pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}/g, replace: REDACTED },
	{ name: "github_pat", pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, replace: REDACTED },
	// AWS access key IDs.
	{ name: "aws_access_key", pattern: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA)[0-9A-Z]{16}\b/g, replace: REDACTED },
	// Google API keys.
	{ name: "google_api_key", pattern: /\bAIza[0-9A-Za-z_-]{20,}/g, replace: REDACTED },
	// Slack tokens (bot/user/… and app-level xapp-).
	{ name: "slack_token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, replace: REDACTED },
	{ name: "slack_app_token", pattern: /\bxapp-[0-9]-[A-Za-z0-9-]{10,}/g, replace: REDACTED },
	// Azure storage connection-string account key.
	{ name: "azure_account_key", pattern: /(\bAccountKey=)[A-Za-z0-9+/]{40,}={0,2}/gi, replace: `$1${REDACTED}` },
	// JSON Web Tokens (header.payload[.signature]); signature optional (alg:none).
	{
		name: "jwt",
		pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{8,})?/g,
		replace: REDACTED,
	},
	// Authorization headers: Bearer/Basic <token> (case-insensitive), keep the scheme word.
	{ name: "auth_header", pattern: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/gi, replace: `$1 ${REDACTED}` },
	// A secret-looking VALUE assigned to a secret-NAMED variable (env dumps, .env, configs).
	// Matches NAMEs ending in a known secret word, so MAX_TOKENS / PASSWORD_MIN_LENGTH don't fire.
	{
		name: "sensitive_assignment",
		pattern:
			/(\b[A-Z][A-Z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIALS?)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/g,
		replace: `$1${REDACTED}`,
	},
];

/** Redact well-known secret token formats in `text`. Returns the text unchanged when nothing matches. */
export function redactSecrets(text: string): string {
	if (!text) return text;
	let out = text;
	for (const rule of RULES) {
		out = out.replace(rule.pattern, rule.replace);
	}
	return out;
}

/** True if `text` contains at least one recognizable secret token (non-mutating). */
export function containsSecret(text: string): boolean {
	return redactSecrets(text) !== text;
}
