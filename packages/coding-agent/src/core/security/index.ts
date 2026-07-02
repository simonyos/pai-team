/**
 * Process hardening + secret redaction (Wave 1, slice 1.6) — public surface.
 */

export { isSensitiveEnvVar, SENSITIVE_ENV_VARS, scrubChildEnv } from "./env-hardening.ts";
export { containsSecret, redactSecrets } from "./secret-redaction.ts";
