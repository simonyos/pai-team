# Safety Foundation — Design & Build Plan (Wave 0 + Wave 1, slice "A")

**Scope:** a real permissions / approval / sandbox layer for pi, shippable in dependency-correct increments. Pure-logic "decision brain" ships before any OS enforcement.

**Grounding:** pi integration maps (workflow `wv0n1amnu`), Codex `execpolicy` deep dive (`~/Development/codex/EXECPOLICY_AND_SANDBOX_DEEPDIVE.md`), Claude Code permission/bash port notes, the verified `@anthropic-ai/sandbox-runtime@0.0.26` API, and pi's own working `packages/coding-agent/examples/extensions/sandbox/index.ts`.

**Key facts that shape the design:**
- pi's dispatch already has the choke point. `agent-loop.ts:prepareToolCall` runs `config.beforeToolCall` before any side effect and turns `{ block:true, reason }` into an error result. That callback is set in `agent-session.ts:_installAgentToolHooks` (lines 416–435). **allow/deny already work; only "ask" needs new logic.**
- The OS sandbox is a solved problem via `@anthropic-ai/sandbox-runtime`: `SandboxManager.initialize(config, askCallback?)` + `await SandboxManager.wrapWithSandbox(command)` + `reset()`. pi's example extension already drives it.
- pi's `BashTool` accepts injectable `operations: BashOperations`, and both the LLM `bash` tool and the `!` user path can be fed sandboxed ops (`agent-session._buildRuntime` ~2420, `executeBash` ~2596).
- Persistence pattern exists: `trust-manager.ts:ProjectTrustStore` (lockfile + JSON in agentDir, nearest-ancestor lookup) — the template for a learned-rules store.

---

## Architecture

```
 LLM emits tool_call
        │
        ▼
 agent-loop.prepareToolCall ──► config.beforeToolCall
        │                              │  (set in agent-session._installAgentToolHooks)
        │                              ▼
        │                     PermissionResolver.resolve(tool, input, ctx)
        │                       1. mode short-circuits (bypass→allow, plan→gate non-readonly)
        │                       2. tool.checkPermissions(input, ctx)   ← per-tool opinion
        │                            └─ bash: ExecPolicy.check(argv)    ← Decision brain (S2)
        │                       3. rule store: deny ▸ allow ▸ ask        ← learned rules (S1)
        │                       4. default by mode
        │                              │
        │             ┌────────────────┼─────────────────┐
        │          allow              ask               deny
        │             │                │                 │
        │             │        ctx.ui.confirm/select     │
        │             │        (+ "always allow" → store)│
        │             ▼                ▼                 ▼
        │        run tool        run / block        {block:true,reason}
        ▼
   bash tool exec ──► BashOperations.exec ──► SandboxManager.wrapWithSandbox(cmd) ──► spawn (S4)
                                                   (FsPolicy → SandboxRuntimeConfig)
 read/edit/write exec ──► assertReadable/assertWritable(path, FsPolicy)  (S3)
 system prompt ──► SystemPromptSection[] registry + behavioral-policy + <system-reminder> channel (S5)
```

Decision precedence (most-restrictive-wins): **deny ▸ ask ▸ allow**, with `mode` transforms applied around it and `dontAsk` (ask→deny) applied **last** so it can't be bypassed.

---

## TypeScript interfaces (erasable-TS: string unions + const maps, no `enum`)

```ts
// permissions/permission-types.ts
export type PermissionMode = "default" | "plan" | "acceptEdits" | "bypassPermissions" | "dontAsk";
export type PermissionBehavior = "allow" | "ask" | "deny";

export interface PermissionRuleValue { toolName: string; ruleContent?: string } // ruleContent e.g. "npm run test:*"
export type PermissionRuleSource = "user" | "project" | "local" | "flag" | "policy" | "session";
export interface PermissionRule { source: PermissionRuleSource; behavior: PermissionBehavior; value: PermissionRuleValue }

export type PermissionResult =
  | { behavior: "allow"; updatedInput?: Record<string, unknown>; reason?: string }
  | { behavior: "ask"; message: string; suggestion?: PermissionRuleValue }
  | { behavior: "deny"; message: string }
  | { behavior: "passthrough" }; // tool has no opinion → fall through to rules/mode

export interface ToolPermissionContext {
  mode: PermissionMode;
  rules: PermissionRule[];           // flattened, fixed source order
  cwd: string;
  isProjectTrusted: boolean;
  hasUI: boolean;
}

// execpolicy/decision.ts  (Decision as union, ranked — no enum)
export type Decision = "allow" | "prompt" | "forbidden";
const RANK: Record<Decision, number> = { allow: 0, prompt: 1, forbidden: 2 };
export function mostRestrictive(a: Decision, b: Decision): Decision { return RANK[a] >= RANK[b] ? a : b; }

// execpolicy/rule.ts
export type PatternToken = { kind: "single"; value: string } | { kind: "alts"; values: string[] };
export interface PrefixPattern { first: string; rest: PatternToken[] }      // keyed by argv[0]
export interface PrefixRule { pattern: PrefixPattern; decision: Decision; justification?: string }
// matchPrefix(argv): argv.length >= rest.length+1 && argv[0]===first && every rest[i] matches argv[1+i]

// execpolicy/policy.ts
export interface Policy {
  check(argv: string[], fallback: (argv: string[]) => Decision): { decision: Decision; justification?: string };
  addPrefixRule(prefix: string[], decision: Decision): void;     // in-memory (all "single" tokens)
}
// createPolicyFromRules(rules): Policy   — rules indexed in Map<argv0, PrefixRule[]>
// appendAllowPrefixRule(path, prefix): Promise<void>  — lock + append JSONL + dedupe

// extensions/types.ts — additive to ToolDefinition (both optional, backward-compatible)
//   isReadOnly?: boolean;
//   classifyReadOnly?: (args: Static<TParams>) => boolean;     // bash overrides this
//   checkPermissions?: (args: Static<TParams>, ctx: ExtensionContext) => PermissionResult | Promise<PermissionResult>;

// tools/path-utils.ts
export interface FsPolicy { writableRoots: string[]; denyRead: string[]; denyWrite: string[] }
// assertReadable(absPath, policy): throws on violation
// assertWritable(absPath, policy): throws on violation
```

The **resolver computes the decision only**; surfacing "ask" to the user is a host callback (`ctx.ui.confirm/select`) so the resolver stays pure and testable. In non-UI modes (`!ctx.hasUI`) "ask" resolves to the configured non-interactive default (deny by default for a public product).

---

## Settings / config additions (`settings-manager.ts`)
Add to `Settings` (mirroring the existing `DefaultProjectTrust` getter/setter at 870–879):
- `permissionMode?: PermissionMode` (default `"default"`).
- `permissionRules?: { allow: string[]; ask: string[]; deny: string[] }` (string form, e.g. `"Bash(npm run test:*)"`).
- `sandbox?: { enabled: boolean; network: {...}; filesystem: {...} }` (reuse the example extension's `.pi/sandbox.json` shape).

Learned "always allow" rules persist via a new `permission-store.ts` (lockfile JSON in `agentDir`, project-scoped overlay in `.pi/`), cloned from `ProjectTrustStore`. Command-safety rules persist as JSONL at `~/.pi/rules/*.rules.jsonl` (Codex execpolicy port; no Starlark).

---

## `@anthropic-ai/sandbox-runtime` mapping (verified API)
- `SandboxManager.initialize({ network, filesystem }, askCallback?)` once at session start.
- `await SandboxManager.wrapWithSandbox(command)` rewrites the command for `sandbox-exec` (macOS) / `bubblewrap` (Linux); we `spawn("bash", ["-c", wrapped])`.
- `FilesystemConfig { denyRead, allowWrite, denyWrite, allowGitConfig }` ← derived from our `FsPolicy` (always `denyWrite` `.git` internals + secrets, default `allowWrite` `["." , tmpDir]`).
- `NetworkConfig { allowedDomains, deniedDomains, httpProxyPort, socksProxyPort }` ← network allowlist (also seeds the future network-proxy moonshot).
- Preflight: `SandboxManager.checkDependencies()` / `hasLinuxSandboxDependenciesSync()`; gate to darwin+linux; Windows degrades to **approval-only, no OS sandbox**.
- `getSandboxViolationStore()` + `annotateStderrWithSandboxFailures(cmd, stderr)` surface "why blocked" to the model.

---

## Incremental build slices (each independently shippable + testable)

> Tests use `packages/coding-agent/test/suite/harness.ts` + the faux provider (no real API keys). Regressions under `test/suite/regressions/`.

- **S1 — Permission resolver + Tool interface + modes (pure logic; the spine).**
  New: `core/permissions/{permission-types,permission-resolver,permission-store,rule-matching}.ts`. Add `checkPermissions?`/`isReadOnly?`/`classifyReadOnly?` to `ToolDefinition`. Add `permissionMode`+`permissionRules` to Settings. Wire the resolver into `agent-session._installAgentToolHooks` (lines 416–435): evaluate decision → allow / `ctx.ui` ask (with "always allow" persistence) / `{block,reason}` deny. Set `isReadOnly:true` on read/grep/find/ls.
  *Test:* faux session issues a tool call; a `deny` rule blocks it (model sees reason); an `allow` rule passes; "ask" in non-UI mode falls to the default.

- **S2 — Bash command-safety brain (pure logic).**
  New: `core/execpolicy/{decision,rule,policy,safelist,rules-file}.ts` (port Codex execpolicy semantics + CC `readOnlyValidation`/`bashPermissions`: `shell-quote` tokenize, env-callback `$VAR`-literal trick, hard-reject post-prefix `$`/brace-expansion). `bash` tool gets `classifyReadOnly` + `checkPermissions` calling `Policy.check`. Runtime "always allow X" appends a JSONL prefix rule.
  *Test:* `git status`/`ls`/`rg` → allow; `git push`/`rm -rf /`/`curl … | sh` → ask or deny; "always allow npm test" persists and is honored next call.

- **S3 — Filesystem scoping (pure logic).**
  `tools/path-utils.ts`: `FsPolicy` + `assertReadable`/`assertWritable`. Call `assertWritable` in `write.ts` (before mkdir/writeFile ~201) and `edit.ts` (~310); `assertReadable` in `read.ts` (~238). Thread `FsPolicy` via `ToolsOptions` in `tools/index.ts`.
  *Test:* write/edit outside `writableRoots` or into `.git`/`.env` → blocked; in-root write → allowed.

- **S4 — OS sandbox integration (thin integration).**
  Promote the example into a first-class `core/sandbox/sandbox-adapter.ts`: `convertToSandboxRuntimeConfig(policy)` + `initialize/wrap/reset` + platform gate + `createSandboxedBashOps()`. Wire sandboxed `operations` into `agent-session._buildRuntime` bash options so **both** the LLM tool and `!` path are covered. Register a `SandboxAskCallback` that routes to the S1 resolver.
  *Test (faux-safe):* `convertToSandboxRuntimeConfig` derivation (writableRoots→allowWrite, `.git`/secrets denyWrite) + platform gate unit tests. Manual OS smoke via the AGENTS.md tmux recipe.

- **S5 — Plan mode + behavioral-policy prompt sections.**
  Refactor `system-prompt.ts` to a `SystemPromptSection[]` registry (static/dynamic boundary) + a `<system-reminder>` attachment channel at `agent-session` `before_agent_start` (~1131). Add behavioral-policy + permission-instructions sections. Plan mode = resolver gates non-read-only tools to ask/deny **and** a plan instruction section; add an ExitPlanMode gate.
  *Test:* in `plan` mode, `edit`/`write`/mutating `bash` → denied, `read`/`grep` → allowed; prompt contains the plan + policy sections.

---

## Test strategy & risks
- **Tests:** per-slice faux-provider suite tests + targeted unit tests for the pure-logic modules (decision/rule matching, classifier, FsPolicy, config derivation). Regressions named under `test/suite/regressions/`. `npm run check` after each slice.
- **Risk — "ask" in non-interactive modes:** print/json/RPC have no UI; the non-interactive default must be explicit (recommend **deny** for a public product, overridable per-mode).
- **Risk — `!` user-bash path:** ensure S2/S4 cover both the LLM `bash` tool and the `!`/`!!` path (`_buildRuntime` + `executeBash` + the `user_bash` event), or document the gap.
- **Risk — Linux deps:** bwrap/socat/ripgrep may be absent; `checkDependencies()` → fail-open-with-warning vs hard-gate is a product decision.
- **Risk — cache stability:** the S5 system-reminder channel must keep volatile content OUT of the cached prefix (don't churn the cache); encode as tests.
- **Open decisions for the owner:** (1) resolver as built-in core vs bundled extension; (2) default `permissionMode` + non-interactive default; (3) Linux fail-open vs fail-closed.

---
*Companion: `PARITY_ROADMAP.md` (the full multi-wave plan). Raw maps: `scratchpad/safety-maps.json`.*
