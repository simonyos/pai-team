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

### G3 — Git Safety Protocol text (blocks G2/G4) — **scope shrunk per D5/D7: no attribution module in v1**
- **New:** `core/git/git-safety-prompt.ts`, `test/git-safety-prompt.test.ts`
- **Touch:** `system-prompt.ts` (S5-style behavioral-policy section), `src/index.ts`
- **Surface:** `GIT_SAFETY_PROTOCOL` const, `buildGitSafetySection()`
- ~~`core/git/attribution.ts`, `getAttributionTexts`, `sanitizeModelName`, `getAttributionSetting()`~~ — **cut**, see D5/D7 decision above. No `Co-Authored-By` trailer, no PR footer, in v1.

### G2 — structured `git` tool (opt-in, off critical path)
- **New:** `core/tools/git.ts`, `test/git-tool.test.ts`; **Touch:** `tools/index.ts` (5 sites: `ToolName`, `allToolNames`, `ToolsOptions.git`, the 3 switches), `src/index.ts`
- **Critic-mandated fixes:**
  - **Commit message: temp-file `git commit -F <tmpfile>` (unlink in finally). NOT `git commit -F -`** — `exec.ts` spawns `stdio:["ignore","pipe","pipe"]`, stdin is ignored, `-F -` hangs.
  - **Exec seam: run through `execCommand` (argv, `shell:false`). DROP `operations?: BashOperations`** (shell-string API, reintroduces the `&&`/`$()` surface the structured schema exists to kill). Accept: skips the OS sandbox backend bash gets — documented trade-off, or add an argv-capable sandbox path later.
  - **Permission subject/rule contract (pin one convention):** `getPermissionSubject('git') => "<subcommand> <args…>"` (NO `git` prefix); `checkPermissions` suggestion `ruleContent = "<subcommand>:*"` (NO `git`); `reconstruct()` prepends `git` ONLY for the execpolicy call. Round-trip test: an "always allow" rule from a `git push` ask must re-match `git push --force`.
- Keep OUT of `defaultActiveToolNames` (both `agent-session.ts` ~2576 and `sdk.ts:280`).

### G4 — `/commit` + `/branch` (needs G0, G1, G3 — all merged; readiness re-verified 2026-07-07)
- **G0/G1/G3 all now merged and confirmed usable as-is** (re-verified against live `main`, not just assumed): G0a's three insertion points are real and documented — `interactive-mode.ts:~2658` `buildCodedCommands()` ordered `{match, run}` table (template: the shipped `/ping-builtin` entry), `rpc-types.ts:~71` `RpcCommand` union + `rpc-mode.ts:~382` `handleCommand` switch (explicit "REGISTRATION POINT" comment), `print-mode.ts:~42` `handleCodedCommand(message, mode)`. G1's full surface (`getStatus`, `getDiff`, `isTransientState`, `hasUnpushedCommits`, `getStagedFiles`, `diffContainsLikelySecret`, `getCurrentBranch`, `getDefaultBranch`) and G3's `GIT_SAFETY_PROTOCOL`/`buildGitSafetySection()` are all present and importable.
- **CORRECTION — `ctx.sendUserMessage` does not exist; drop this wording.** G4/G5 are G0a **coded commands**, whose `run`/switch-case closures receive **no `ctx` object at all** (confirmed: `CodedCommand.run` and the RPC switch closures are ctx-free). The real, working call is **`session.sendUserMessage(content, options?)`** (`AgentSession.sendUserMessage`, `agent-session.ts:~1481`), reached as `this.session.sendUserMessage(...)` in interactive-mode.ts and `session.sendUserMessage(...)` in rpc-mode.ts's `handleCommand` closure (both already have `session` in scope). **Print-mode's `handleCodedCommand(message, mode)` currently has no `session` reference at all** — wiring `/commit`/`/branch` there requires first widening that function's signature (or moving the coded-command check inside `runPrintMode` where `session` is already in scope) so it can call `session.sendUserMessage(...)` too. This is the one piece of G4 that is genuinely new plumbing in print mode, not just "add an entry to an existing table."
- ~~Critic: encode the pre-commit-hook-failure recovery loop~~ — **already done, no new work needed.** That exact wording is already shipped verbatim in G3's `GIT_SAFETY_PROTOCOL` (`git-safety-prompt.ts:28`). G4 only needs to actually include `GIT_SAFETY_PROTOCOL` in the primed prompt (already the plan) — it does not need to re-author this text.
- ~~confirm the commit path never sets `core.hooksPath=/dev/null`~~ — **structurally guaranteed, not just a convention to verify.** `runGitRead` is the *only* function that ever prepends the hook-neutralizing hardening flags, and it calls `assertReadOnly()` first, which throws for any non-read-only invocation (`git commit` included) — there is no code path today, and none G4 would plausibly add, where a commit could pick up that flag. No new detection/enforcement code needed here either. The mechanical "did the commit actually happen" signal is already free: the bash tool surfaces a nonzero exit code (plus the hook's own failure text) as a thrown error the model sees on its next turn — no HEAD-before/after diffing or exit-code-comparison helper needs to be built.

### G5 — `/commit-push-pr` — ✅ SHIPPED 2026-07-07 (PR #17, built by Kai/Paperclip + one native fix after review)
- **Architecture note (same model as G4's `/commit`/`/branch`, corrected 2026-07-07):** "branch → commit → push → `gh pr create`" describes what the **model** does via its own tool calls after being primed — G5's own code (a `buildCommitPushPrCommand(cwd, args)` core module, wired into all 3 modes exactly like `commit-command.ts`/`branch-command.ts`) never itself runs `push` or `gh pr create`. It only does reads (G1 + direct `gh` calls in its own app code, same pattern as `handleShareCommand`'s `spawnSync`) and composes a `GIT_SAFETY_PROTOCOL`-primed prompt. No new permission gate needed — the model's actual mutations flow through the already-shipped S1/S2 + G0b headless-deny gate.
- **Idempotent PR/branch detection — CORRECTED, do not reach for `fetch`/`pull`:** "detect existing PR/branch" reads as needing local-vs-remote comparison, which is the natural trap — it doesn't need that. Existing-PR detection is a live `gh pr list --head <branch> --state open` read (already auto-allowed, `GH_RESOURCE_READ_ACTIONS.pr`) — a GitHub API call, not a local-ref inspection, so it can't go stale. Existing-branch/unpushed-commit detection is already answered by G1's `getCurrentBranch`/`hasUnpushedCommits` using only local refs, kept accurate for free because the flow's own `git push` (fast-forward-only, round-trips to the real remote, fails cleanly rather than silently clobbering) is what would surface any staleness — exactly like G4 already treats a hook failure as "the model sees the error and retries," not something needing pre-emptive detection.
- PR body is plain — no "🤖 Generated with…" footer (cut per D7). The model must always pass explicit `--title`/`--body` to `gh pr create` (it prompts interactively otherwise) and must **never** pass `--base` — `gh` already resolves the base branch itself (a configured `gh-merge-base`, else the repo's real default branch); hardcoding G1's `getDefaultBranch()` as `--base` risks overriding a user's configured merge-base. `getDefaultBranch` is still useful for a *different* purpose: an on-default-branch guard (refuse `/commit-push-pr` while sitting on `main`), mirroring `/branch`'s existing current/default-branch comparison.
- **Hard ordering requirement, not just convention:** push must happen before `gh pr create` — `gh pr create` on a not-fully-pushed branch falls back to its own interactive "where do you want to push" prompt.
- **Critic:** explicit `gh` **not-installed** and **unauthenticated** (`gh auth status`) preflight, degrading to a clear distinct error (≠ "no PR"); force non-interactive (`GH_PROMPT_DISABLED`, `GIT_TERMINAL_PROMPT=0`); optional `--reviewer` passthrough (only when the user supplies it in args).
- **A ready-made style template exists for the gh preflight** — `interactive-mode.ts:~5390` (`handleShareCommand`, backing `/share`; drifted from an earlier ~5362 estimate) already does the exact `gh`-not-installed / `gh`-not-authenticated check via `spawnSync("gh", ["auth", "status"], ...)`, with the exact error-message wording G5 should match (`:5393` the call, `:5395`/`:5399` the two distinct messages). `GIT_TERMINAL_PROMPT=0` also has a precedent (`package-manager.ts:~1605`, background git-remote calls during install, on a plain `git` read call not a `gh` call) — match its style. `GH_PROMPT_DISABLED` has zero existing occurrences in the codebase — genuinely new for G5, first user.
- **CORRECTION — "resolve a linked worktree back to its main repo" is NOT an existing G1 helper to reuse; it must be newly built (re-confirmed absent 2026-07-07).** `core/git/paths.ts` has no function that returns a linked worktree's main-repo directory — `getGitRoot`/`findGitPaths` deliberately return the *current* worktree's own root. Concrete build sketch: a new `getMainRepoRoot(cwd)` returning `dirname(commonGitDir)` when it differs from `repoDir` (both already resolved by `findGitPaths`), with `git worktree list --porcelain` (already read-only) as a stronger fallback for non-standard layouts (e.g. `--separate-git-dir`). This repo's own `.paperclip/worktrees/...` trees are a live example of the shape this needs to handle.

---

## Open decisions for the owner (blocking where noted)

- **D0 — Command delivery mechanism (blocks G0/G4):** (a) add to `BUILTIN_SLASH_COMMANDS` + wire coded handlers into `interactive-mode.ts` **and** `rpc-mode.ts` (matches every existing first-class command), or (b) build an internal-extension autoload hook (net-new). *Recommend (a)* — lower risk, matches convention.
- **D1 — Headless safety (P0, NOT optional):** an un-ruled "ask" resolves via `getNonInteractivePermission()` = **allow** by default → `/commit-push-pr` in CI could silently push. Ship a default **deny/ask** rule for mutating git **and** gh in non-interactive mode, or have handlers seed session-scoped allow rules only for the exact verbs, torn down after. *Recommend:* default-deny mutating git/gh headless + a test that a headless `/commit-push-pr` does not auto-push without an explicit allow rule.
- **D2 — Git tool schema:** structured (`subcommand`+`args[]`) vs single `command` string. *Recommend structured* (shell-free is the point).
- **D3 — Activate git tool by default?** *Recommend opt-in only* (register, don't activate; bash already covers git).
- **D4 — Hook policy asymmetry:** reads neutralize hooks (supply-chain rail); commit path runs hooks normally, never `--amend`. *Recommend confirm asymmetry.*
- **D5 — Attribution identity — DECIDED 2026-07-07:** **no `Co-Authored-By` trailer at all in v1.** Owner rejected both a personal email and a "Claude Code"-branded identity — no default exists yet for a `pi`-branded noreply address, so v1 ships with **zero commit-trailer attribution**. `core/git/attribution.ts` is **not built** in G3; nothing calls it. Revisit if/when the project has its own domain/noreply identity.
- **D6 — RESOLVED 2026-07-07: drop it, not load-bearing.** `git fetch`/`git pull` genuinely still classify as mutating (prompt) today, but G5 does not need either for its designed happy path — existing-PR detection is a live `gh pr list`/`view` read (GitHub API, can't go stale); existing-branch detection uses G1's local-ref helpers, kept accurate for free by the flow's own `push` (fast-forward-only, fails cleanly rather than silently clobbering on staleness). No project-level allow rule to seed, no fetch/pull to build into G5. The gh-read-scope half was already moot (see below) — both halves of D6 are now closed.
- **D7 — v1 scope — DECIDED 2026-07-07:** **no PR footer at all** (stronger than "defer contribution-%" — full opt-out, not just the per-edit variant). `/commit-push-pr` (G5) creates a plain PR body with no "🤖 Generated with…" line and no Claude Code branding.

---

## Recommended next action

Build **G1 now** — it is the foundation everything imports, is **permission-neutral and decision-free**
(none of D0–D7 block it), and lands real value early (worktree-correct root discovery, the porcelain readers
pi lacks, the P0 validation + secret + fsmonitor rails). Settle **D0, D1, D5** before G3/G4.
