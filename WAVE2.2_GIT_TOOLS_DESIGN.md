# Wave 2.2 — Git helpers + Git tool + workflow slash-commands

Context pack + slice plan for the **Git** slice of the pi parity roadmap (`PARITY_ROADMAP.md` §2.2).
Produced by an Understand → Design → Critique workflow (6 subsystem readers over pi + Claude Code + Codex,
architect synthesis, adversarial critic). Critic verdict on the first draft: **needs-revision** — the
adjustments below are folded in.

> **Scope (roadmap):** "Git helpers + Git tool + workflow slash-commands (`/commit`, `/commit-push-pr`,
> `/branch`) with scoped tool policy and attribution. Borrow: Claude Code `utils/git.ts`,
> `commands/commit-push-pr.ts`. pi's `footer-data-provider.ts` already walks `.git`."

---

## Architecture — three additive layers, extend don't rebuild

Every git mutation flows through the **existing** S1 permission resolver + S2 execpolicy. **No new
permission store.** All plumbing reuses `core/exec.ts` (`execCommand`, already scrubs LLM creds via
`getShellEnv`, `shell:false`). Opt-in / non-breaking throughout.

| Layer | Module | What | Permission surface |
|---|---|---|---|
| **L0** | `core/git/` (paths, helpers, validate, secret-guard) | Read-only git state plumbing. Extract worktree-correct root/branch logic out of `footer-data-provider.ts` into a shared exported place; add porcelain `status`/`diff`/`log` readers pi lacks; add ref/SHA validation + secret-in-diff guard. | none (read-only via `execCommand` legitimately bypasses execpolicy; runner asserts read-only membership) |
| **L1.5** | `core/git/attribution.ts` + `git-safety-prompt.ts` | Single overridable source for the `Co-Authored-By` trailer + `🤖 Generated with` PR footer; the verbatim **Git Safety Protocol** text. (`provider-attribution.ts` is a naming trap = LLM HTTP headers — do NOT touch.) | none (text + settings) |
| **L1** | `core/tools/git.ts` | First-class **structured** `git` tool (`subcommand` + `args[]`, no shell string — the whole reason to add it over bash). Carries its OWN `classifyReadOnly`/`checkPermissions` (git is in neither `BUILTIN_READ_ONLY_TOOLS` nor `EDIT_TOOLS`) delegating to execpolicy. Registered built-in but **kept out of `defaultActiveToolNames`** (opt-in). | reuses resolver + execpolicy unchanged |
| **L2** | `/commit`, `/branch`, `/commit-push-pr` | Coded handlers (pi's real dispatch model — **not** Claude Code's prompt-injector; pi's `substituteArgs` has no shell interpolation so templates can't prime a real diff). Each handler reads pre-flight state via L0, refuses on transient/empty/secret conditions, composes a safety-primed prompt + attribution, and injects via `ctx.sendUserMessage` so the **model** drives the mutation through the governed tool path. The command itself never mutates → S1+S2 scoping applies for free, and "invoking the command IS the explicit ask." | reuses resolver + execpolicy + a **headless gate** (see decisions) |

**Dispatch model — settled by source inspection:** pi slash commands are **coded handlers**
(`registerCommand(name,{handler})` → `handler(args, ctx)`, dispatched at `agent-session.ts:1281`), **but**
first-class commands (`/compact`, `/export`, …) are `BUILTIN_SLASH_COMMANDS` matched by hardcoded strings
**per-mode** in `modes/interactive/interactive-mode.ts` (~2634) **and** `modes/rpc/rpc-mode.ts`. There is
**no auto-load hook for a "bundled internal extension."** ⇒ delivering `/commit` etc. means either wiring
coded handlers into `BUILTIN_SLASH_COMMANDS` across **each mode**, or building an internal-extension autoload
mechanism (net-new). This is real, unbudgeted infra — see slice **G0**.

---

## Slice plan (critical path: G1 → G3 → G4 → G5; G2 is an opt-in enhancement, off the critical path)

Reordered per critic: G3 (safety text) must precede G2/G4 because both reference the protocol. G2 (the tool)
is **not** required by G4/G5 — the commands let the model drive git through bash or the git tool, and bash
already covers git. Command-registration infra is pulled out as its own slice **G0** so G4 isn't secretly an
"L" pretending to be "M".

| # | Slice | Effort | On critical path? |
|---|---|---|---|
| **G0** | Command-registration mechanism (BUILTIN wiring across interactive+rpc+print, or internal-extension autoload) + **headless mutation gate** | M | yes (blocks G4/G5) |
| **G1** | git-helpers read module + footer extraction | M | yes (foundation) |
| **G3** | Attribution module + Git Safety Protocol text | S | yes |
| **G2** | First-class structured `git` tool (opt-in) | L | no (parallel/deferrable) |
| **G4** | `/commit` + `/branch` coded handlers | M | yes |
| **G5** | `/commit-push-pr` (branch→commit→push→gh PR, idempotent) | L | yes |

### G1 — git-helpers module — ✅ IMPLEMENTED (branch `feat/git-helpers`)
Shipped as written below, then hardened by an adversarial review (12 confirmed findings fixed). Review-driven changes folded in:
- **NUL-framed reads** (`status … -z`, `diff --name-only -z`) so paths with spaces/non-ASCII survive verbatim (C-quoting bug).
- **getDiff `--no-ext-diff --no-textconv`** to stop `diff.external` / per-path `textconv` code-exec from a hostile repo during a read. Residual `filter.*.clean` smudge vector documented as out-of-scope for G1 (deferred to S4 sandbox / trust gate).
- **`conflicted` bucket** on `GitStatus` — unmerged entries (UU/AA/DD/…) no longer double-counted into staged+unstaged.
- **`isTransientState` uses the per-worktree gitdir** (`dirname(HEAD)`), not `commonGitDir`, so in-progress merge/rebase inside a linked worktree is detected.
- **`runGitRead` throws on `killed`** (abort/timeout no longer reported as clean success) and **rejects empty-string args**.
- **execpolicy (S2) tightened**: `symbolic-ref` and `reflog` removed from the unconditional git read-set and given nuanced classification (`symbolic-ref <name>`=read, `symbolic-ref HEAD <ref>`/`-d`=write; `reflog show/exists`=read, `expire/delete`=write) — keeps `runGitRead`'s "can never mutate" invariant honest. Stricter only (more prompts, never fewer).
- Tests: 31 git-helpers cases (incl. special-char paths, conflict routing, worktree transient state, nuanced read-only assertion, deterministic hardening-rail check) + execpolicy suite green.

Original G1 spec:


- **New:** `core/git/{paths,git-helpers,validate,secret-guard}.ts`, `test/git-helpers.test.ts`
- **Touch:** `footer-data-provider.ts` (import extracted paths; keep byte-identical + regression test), `src/index.ts` (re-exports)
- **Key surface:** `findGitPaths`, `resolveBranch*` (extracted verbatim); `runGitRead(args,cwd,opts)` — the ONLY spawn path, asserts subcommand ∈ `SUBCOMMAND_READONLY.git`, `redactSecrets(stdout)`; `getStatus` (porcelain v1 `-b`, never `-uall`), `getDiff`, `getRecentCommits`, `getDefaultBranch` (origin/HEAD→main→master), `getHeadSha`, `getRemoteUrl`, `isTransientState`, `hasUnpushedCommits`; `isSafeRefName`, `isValidGitSha`; `diffContainsLikelySecret` (wraps `containsSecret`)
- **Safety rails on every read:** `--no-optional-locks`, `-c core.hooksPath=/dev/null`, **`-c core.fsmonitor=false`** (⇐ critic: Codex fsmonitor supply-chain rail — a hostile `.git/config` `core.fsmonitor=<binary>` runs during `git status`), read-only assertion, `redactSecrets`, `getShellEnv` cred withholding
- **Tests:** worktree `.git`-file gitdir pointer; porcelain parsing (staged/unstaged/untracked/ahead-behind/rename/unmerged); default-branch order; `runGitRead` throws on mutating verb; validate allow/reject table; secret-flag on `.env` line; footer branch regression; **fsmonitor-hostile repo does not execute during getStatus/getDiff**

### G3 — attribution + safety text (blocks G2/G4)
- **New:** `core/git/{attribution,git-safety-prompt}.ts`, `test/git-attribution.test.ts`
- **Touch:** `settings-manager.ts` (add `getAttributionSetting()` mirroring `getPermissionRules`), `system-prompt.ts` (S5 behavioral-policy section), `src/index.ts`
- **Surface:** `getAttributionTexts(settings,input)` (single overridable/suppressible source), `sanitizeModelName`, `GIT_SAFETY_PROTOCOL` const, `buildGitSafetySection()`
- Depends on **Decision D5** (attribution identity) — must be settled before this lands in real commits

### G2 — structured `git` tool (opt-in, off critical path)
- **New:** `core/tools/git.ts`, `test/git-tool.test.ts`; **Touch:** `tools/index.ts` (5 sites: `ToolName`, `allToolNames`, `ToolsOptions.git`, the 3 switches), `src/index.ts`
- **Critic-mandated fixes:**
  - **Commit message: temp-file `git commit -F <tmpfile>` (unlink in finally). NOT `git commit -F -`** — `exec.ts` spawns `stdio:["ignore","pipe","pipe"]`, stdin is ignored, `-F -` hangs.
  - **Exec seam: run through `execCommand` (argv, `shell:false`). DROP `operations?: BashOperations`** (shell-string API, reintroduces the `&&`/`$()` surface the structured schema exists to kill). Accept: skips the OS sandbox backend bash gets — documented trade-off, or add an argv-capable sandbox path later.
  - **Permission subject/rule contract (pin one convention):** `getPermissionSubject('git') => "<subcommand> <args…>"` (NO `git` prefix); `checkPermissions` suggestion `ruleContent = "<subcommand>:*"` (NO `git`); `reconstruct()` prepends `git` ONLY for the execpolicy call. Round-trip test: an "always allow" rule from a `git push` ask must re-match `git push --force`.
- Keep OUT of `defaultActiveToolNames` (both `agent-session.ts` ~2576 and `sdk.ts:280`).

### G4 — `/commit` + `/branch` (needs G0, G1, G3)
- Handlers read pre-flight state (L0), **refuse** on transient/empty/secret (secret = refuse, not warn, unless explicit override — the prompt can't force stage-by-name), compose primed prompt = `GIT_SAFETY_PROTOCOL` + real diff + attribution trailer, inject via `ctx.sendUserMessage`.
- **Critic: encode the pre-commit-hook-failure recovery loop** (hook fails → fix root cause → re-stage → **new** commit, never `--amend`, because a hook-failed commit never happened) into the commit prompt, and confirm the commit path **never** sets `core.hooksPath=/dev/null` (commit hooks must run; only reads neutralize hooks).

### G5 — `/commit-push-pr` (needs G4)
- branch → commit → push → `gh pr create`, idempotent (detect existing PR/branch).
- **Critic:** explicit `gh` **not-installed** and **unauthenticated** (`gh auth status`) preflight, degrading to a clear distinct error (≠ "no PR"); force non-interactive (`GH_PROMPT_DISABLED`, `GIT_TERMINAL_PROMPT=0`); optional `--reviewer` passthrough for parity. Resolve a linked worktree back to its main repo before branch/default-branch resolution.

---

## Open decisions for the owner (blocking where noted)

- **D0 — Command delivery mechanism (blocks G0/G4):** (a) add to `BUILTIN_SLASH_COMMANDS` + wire coded handlers into `interactive-mode.ts` **and** `rpc-mode.ts` (matches every existing first-class command), or (b) build an internal-extension autoload hook (net-new). *Recommend (a)* — lower risk, matches convention.
- **D1 — Headless safety (P0, NOT optional):** an un-ruled "ask" resolves via `getNonInteractivePermission()` = **allow** by default → `/commit-push-pr` in CI could silently push. Ship a default **deny/ask** rule for mutating git **and** gh in non-interactive mode, or have handlers seed session-scoped allow rules only for the exact verbs, torn down after. *Recommend:* default-deny mutating git/gh headless + a test that a headless `/commit-push-pr` does not auto-push without an explicit allow rule.
- **D2 — Git tool schema:** structured (`subcommand`+`args[]`) vs single `command` string. *Recommend structured* (shell-free is the point).
- **D3 — Activate git tool by default?** *Recommend opt-in only* (register, don't activate; bash already covers git).
- **D4 — Hook policy asymmetry:** reads neutralize hooks (supply-chain rail); commit path runs hooks normally, never `--amend`. *Recommend confirm asymmetry.*
- **D5 — Attribution identity (blocks G3, bakes into user commit history):** exact `Co-Authored-By` name + email, PR-footer product name/URL (`APP_NAME`→`pi`), model-display source + `sanitizeModelName` map.
- **D6 — fetch/pull + gh read scope:** execpolicy marks `fetch`/`pull` mutating (prompt). Accept prompt, or seed a project allow? Seed a read-only allow for `gh pr view:*` while `gh create/edit` still prompt?
- **D7 — v1 scope:** exclude the per-edit contribution-% PR footer and fork-parent PR discovery? *Recommend defer* (v1 = self-contained `Co-Authored-By` + `🤖 Generated with` ≈ 90% of value).

---

## Recommended next action

Build **G1 now** — it is the foundation everything imports, is **permission-neutral and decision-free**
(none of D0–D7 block it), and lands real value early (worktree-correct root discovery, the porcelain readers
pi lacks, the P0 validation + secret + fsmonitor rails). Settle **D0, D1, D5** before G3/G4.
