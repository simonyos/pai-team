# pi → Claude Code / Codex Parity Roadmap

**Goal:** elevate the forked `pi` coding agent (this repo, `~/Development/pai-team`) to the level of Claude Code and Codex CLI, as a **public / OSS product**, across all four axes: agentic capability, safety & sandboxing, extensibility & ecosystem, and UX & polish.

**How this was built (three independent, cross-checked sources):**
1. First-hand reads of pi's core (`agent-loop.ts`, `agent-harness.ts`, `system-prompt.ts`, `tools/`, `extensions/`, `compaction/`).
2. **Codex brief** — `~/Development/codex/CAPABILITY_BRIEF_FOR_PI.md` (agent-3, path-verified across ~120 Rust crates).
3. **Claude Code brief** — `~/Development/claude-code/CAPABILITY_BRIEF_FOR_PI.md` (agent-2, from the recovered TS source, ~1,900 files).
4. A 12-dimension verified gap matrix (workflow `wqof9ovj3`; raw data in `scratchpad/assessments.json`). 11/12 dimensions auto-verified; `extensibility` backfilled from the briefs.

---

## Executive summary

pi is **far more mature than its ~108K LOC suggests.** Its agent loop (steering, parallel/sequential tool execution, `terminate`, hooks), its harness (session tree + branch summaries, compaction, hot-swap model/tools), its **extension API** (the crown jewel — `registerTool/Command/Provider`, full lifecycle event bus, rich TUI primitives), its multi-provider `pi-ai` package, and its TUI are all **solid-to-strong**. We should **extend pi, not rebuild it.**

The gaps cluster into four areas, and **all three sources converge on the same priorities:**

1. **Safety is the #1 gap and the gating dependency for a public, autonomous product.** pi has `trust-manager`/`project-trust` but **no permission resolver, no approval modes, no bash command-safety analysis, no filesystem scoping, no OS sandbox.** Claude Code (`canUseTool` + modes + `@anthropic-ai/sandbox-runtime`) and Codex (execpolicy + OS sandboxes + network proxy) are the blueprints. **pi already ships `@anthropic-ai/sandbox-runtime` 0.0.26 in devDeps** and the loop already exposes a `beforeToolCall` hook — the seam exists.
2. **No MCP client.** The single most-cited gap (surfaces under tools, integrations, *and* extensibility). Both references have it; in TS it's a small wrapper over the official `@modelcontextprotocol/sdk` feeding pi's existing tool registry.
3. **No agent-facing sub-agents / background tasks.** pi has an *experimental* `orchestrator` package to build on; both refs treat delegation as core (Claude Code `forkSubagent` + auto-background; Codex `spawn_agent` + agent graph).
4. **Thin "harness intelligence":** minimal system prompt (string concat, no behavioral policy), no microcompaction, no persistent memory, exact-match edits (vs Codex's fuzzy `apply_patch`), no git/PR workflow, no web tools.

**Strategic thesis:** build the **seams first** (an upgraded Tool interface + a composable system-prompt registry), then land the **safety layer** (P0 for public launch), then **ecosystem** (MCP, git), then **agentic power** (sub-agents, memory, microcompaction), then **efficiency/polish + moonshots** where pi can *beat* the references.

---

## Capability matrix

| Dimension | pi today | Claude Code edge | Codex edge | Priority |
|---|---|---|---|---|
| Agent/turn loop | **solid** (steering, ∥/serial exec, hooks, terminate) | streaming-tool-exec; read-∥/write-serial batching (cap 10) | task-abstraction; true mid-flight cancel | P2 |
| Tool suite | **solid** (7 tools, render split) | two-rendering + ToolSearch defer | `apply_patch` fuzzy matcher; lazy tool discovery | P1 |
| Context & memory | **solid** loop; **2 high gaps** | microcompact; memory extraction; 9-section summary | typed context-fragments; `ext/memories`; zstd+sqlite | **P1** |
| Planning/todo | **basic** | todo + plan-mode-via-permissions | `update_plan` (skip-easy-25%) | P1 |
| Permissions & sandbox | **basic** (trust only) | `canUseTool` + modes + sandbox-runtime | execpolicy DSL + OS sandboxes + net proxy | **P0** |
| Model/provider | **strong** | opusplan routing; haiku subtasks; cache latching | Responses API; models-manager cache | P2 |
| Extensibility | **strong** (ext API) — MCP is the gap | MCP+ToolSearch; hooks; plugins; skills | MCP both-ways; hooks; plugins; skills | **P1** |
| TUI / UX | **strong** | cell-buffer renderer; chords; vim | ratatui; ANSI-normalize; diff viewer | P2 |
| Session/state | **solid** (tree + branch summaries) | file-backup rewind | zstd JSONL + SQLite index | P2 |
| Prompt design | **basic** (string concat) | cache-aware sections; `<system-reminder>` channel | per-model prompts; behavioral policy | **P0/P1** (cheap) |
| Integrations | **none** | gh wrapper; IDE-over-MCP; chrome | git-utils; app-server JSON-RPC | P1 |
| Multi-agent/cloud | **basic** (experimental orch.) | unified Task; coordinator; forkSubagent | agent-graph; cloud-tasks; code-mode | P1 |

---

## Roadmap (waves)

### Wave 0 — Seams (do first; everything below plugs into these)
- **0.1 Upgrade the Tool interface.** Add first-class `checkPermissions?(args, ctx)` and a *dynamic* read-only/concurrency classification derived from parsed input (pi today only has a static per-tool `executionMode`). Keep the existing model-payload vs `renderCall/renderResult` split. *Borrow:* Claude Code `Tool.ts` (`isReadOnly`/`isConcurrencySafe`/`checkPermissions`, default-false). *Target:* `packages/coding-agent/src/core/extensions/types.ts` (`ToolDefinition`), `tools/*`. **Effort M, Impact high.** Prereq for safety, MCP, sub-agents.
- **0.2 System-prompt section registry.** Replace the string concatenation in `system-prompt.ts` with `SystemPromptSection { name, compute(ctx) → string|null }`, a static/dynamic cache boundary, and a `<system-reminder>` turn-boundary attachment channel for all volatile content. *Borrow:* Claude Code `constants/systemPromptSections.ts` + `prompts.ts`; Codex typed context-fragments. *Target:* `packages/coding-agent/src/core/system-prompt.ts`, `agent-session.ts` (`_rebuildSystemPrompt`). **Effort M, Impact high.** Unblocks behavioral policy, per-model prompts, permission instructions, cache discipline.

### Wave 1 — Safety (P0; gating for a public, autonomous product)
- **1.1 Permission resolver at the dispatch site.** `core/permissions/permission-resolver.ts` returning allow/ask/deny, with modes (`default`/`plan`/`acceptEdits`/`bypass`/`dontAsk`) and a rule format (`Bash(npm run test:*)`-style), wired into the existing `agent.beforeToolCall` hook (`agent-session.ts:_installAgentToolHooks`). *Borrow:* Claude Code `permissions.ts` (precedence `[user,project,local,flag,policy]`, `dontAsk` applied last). **Effort L, Impact high.**
- **1.2 Bash command-safety analysis.** Compound-command parsing → read-only vs mutating; learn runtime "always allow X" rules. *Borrow:* Claude Code `BashTool/bashPermissions.ts` + `readOnlyValidation.ts`; Codex `execpolicy` argv-pattern model (reimplement as TS/JSON rules, not Starlark). **Effort M, Impact high.**
- **1.3 Filesystem scoping** on read/edit/write (`writableRoots`/`denyRead`/`denyWrite`). *Borrow:* both. **Effort M, Impact high.**
- **1.4 OS sandbox adapter** around bash via the already-bundled `@anthropic-ai/sandbox-runtime` (Seatbelt on macOS, bwrap on Linux); thin `core/sandbox/sandbox-adapter.ts`. *Borrow:* Claude Code `sandbox-adapter.ts`; Codex `sandboxing/`. **Effort L–XL, Impact high.** (Do NOT reimplement OS sandboxes — shell out.)
- **1.5 Plan mode + behavioral policy prompt sections** (risk/blast-radius, git safety "never revert the user's changes", anti-gold-plating, faithful reporting). Plan mode enforced by the resolver gating non-read-only tools, not a blocklist. *Borrow:* both. **Effort M, Impact high.**
- **1.6 Secret redaction + process hardening** at startup (scrub env for children; redact token shapes in output). *Borrow:* Codex `process-hardening/`, `secrets/`. **Effort S, Impact medium.**

### Wave 2 — Ecosystem (P1)
- **2.1 MCP client.** Official `@modelcontextprotocol/sdk` over stdio/http; discovered tools become `AgentTool`s namespaced `mcp__<server>__<tool>`; `mcpServers` config; per-tool approval via the Wave-1 resolver. Optional ToolSearch-style schema deferral to keep the tool list small. *Borrow:* Claude Code `services/mcp/*` + `ToolSearchTool/`. **Effort L, Impact high.**
- **2.2 Git helpers + Git tool + workflow slash-commands** (`/commit`, `/commit-push-pr`, `/branch`) with scoped tool policy and attribution. *Borrow:* Claude Code `utils/git.ts`, `commands/commit-push-pr.ts` (pi's `footer-data-provider.ts` already walks `.git`). **Effort M each, Impact high.**
- **2.3 `web_fetch` (+ optional `web_search`) tool** with content extraction + shared truncation. *Borrow:* Claude Code. **Effort M, Impact high.**
- **2.4 Declarative agent definitions** `.pi/agents/*.md` (frontmatter: name/description/tools/model), reusing the existing `skills.ts` frontmatter parser. *Borrow:* both. **Effort M, Impact medium.**

### Wave 3 — Agentic power (P1)
- **3.1 `task` sub-agent tool** over the orchestrator (`{prompt,label?,model?,cwd?}`) + `run_in_background` + `get_task_status`/`get_task_output` RPC + parent/child graph (`parentInstanceId`) + optional git-worktree isolation. *Borrow:* Claude Code `forkSubagent`/Task + auto-background-120s + SendMessage-resume; Codex `agent-graph-store`. **Effort M–L, Impact high.**
- **3.2 Microcompaction (LLM-free)** that clears stale tool-result bodies keyed by `tool_use_id` before paying for a full summary, + a 3-failure compaction circuit breaker. *Borrow:* Claude Code `services/compact/microCompact.ts`. **Effort M, Impact high.**
- **3.3 Persistent memory** tool (`memory_list/read/search/write`) + memory dir (markdown + frontmatter taxonomy) + optional auto-extraction pass. *Borrow:* Codex `ext/memories`; Claude Code `extractMemories`. **Effort L, Impact high.**
- **3.4 `apply_patch`-style robust edits** — context-anchored hunks + whitespace-tolerant fuzzy matcher + multi-file envelope; surface a structured patch in `edit`'s model-facing output. *Borrow:* Codex `apply-patch/` (`seek_sequence.rs`). **Effort M–L, Impact high.**
- **3.5 Plan/`update_plan` todo tool** + periodic todo reminder (skip plans for the easiest ~25%, no single-step plans). *Borrow:* both. **Effort M, Impact medium-high.**

### Wave 4 — Efficiency, polish & differentiators (P2 + moonshots)
- **4.1 Prompt-cache discipline** (single message-level `cache_control`, sticky beta headers, volatile-as-attachments, cache-break diagnostics encoded as **types/tests**, not folklore). *Borrow:* Claude Code §6/§10. **Effort M, Impact high** (cost/latency at long context).
- **4.2 Model routing:** small/fast aux-model slot (compaction/summaries/labels) + `refreshModels` disk cache + cross-model fallback chain. *Borrow:* Claude Code `getSmallFastModel`; Codex `models-manager`. **Effort M–L.**
- **4.3 Session hardening:** atomic writes + crash-safe pre-assistant flush, tail-readable lite-metadata line, optional SQLite index, zstd cold-compression, text/md/json export. *Borrow:* Codex `rollout/`; Claude Code export. **Effort M–L.**
- **4.4 TUI polish:** syntax-highlighted diffs (path→lang via highlight.js — `renderDiff` already receives `filePath`), elapsed-time + token-rate status, multi-file diff review overlay, golden snapshot tests. *Borrow:* both. **Effort M.**
- **4.5 Per-model system prompts** + final-answer formatting/tone contract + output styles. *Borrow:* Codex per-model prompts; Claude Code output styles. **Effort M.**
- **Moonshots (where pi can beat the references):**
  - **code-mode** — let the model write TS executed in a `worker_threads`/`isolated-vm` sandbox to collapse N tool calls into one. *More natural in TS than Codex's V8-in-Rust.* *Borrow:* Codex `code-mode/`.
  - **Network credential-broker proxy** — MITM egress allow/deny + secrets injected at the proxy (never in subprocess env). *Borrow:* Codex `network-proxy/`.
  - **JSON-RPC app-server boundary + IDE bridge** — extend pi's existing `rpc-mode` into a typed editor protocol. *Borrow:* Codex `app-server/`.

---

## Sequencing & dependency notes
- **Wave 0 must precede Waves 1–3** — the Tool-interface upgrade (0.1) is the seam permissions, MCP, and sub-agents all plug into; the prompt registry (0.2) is the seam for behavioral policy + cache discipline.
- Wave 1 (safety) is **P0 for a public launch** and reuses the already-bundled `@anthropic-ai/sandbox-runtime` + the existing `beforeToolCall` hook.
- MCP (2.1) and sub-agents (3.1) both consume the Wave-0/Wave-1 seams; don't start them before those land.
- Microcompaction (3.2) and cache discipline (4.1) are independent and can parallelize once Wave 0 exists.

## Recommended first slice
**The safety foundation (Wave 0.1 + 0.2 → Wave 1.1–1.2, then 1.3–1.5).** It is the most-converged gap, the gating dependency for a public autonomous product, it lays the two seams every later wave reuses, and pi already has the sandbox dependency and the loop hook in place. First concrete steps:
1. Extend `ToolDefinition` with `checkPermissions?` + dynamic read-only classification (0.1).
2. Stand up `core/permissions/permission-resolver.ts` with modes + rule format; wire it into `beforeToolCall` (1.1).
3. Port bash compound-command safety analysis → read-only/mutating + "always allow" learning (1.2).
4. Build the system-prompt section registry and add the behavioral-policy + permission-instructions sections (0.2 + 1.5).
5. Add filesystem scoping to read/edit/write (1.3) and the `@anthropic-ai/sandbox-runtime` adapter around bash (1.4).
6. Add plan mode via the resolver (1.5).

---
*Companion artifacts: `~/Development/codex/CAPABILITY_BRIEF_FOR_PI.md`, `~/Development/claude-code/CAPABILITY_BRIEF_FOR_PI.md`, `scratchpad/assessments.json` (full per-dimension gaps + opportunities with borrow-from file paths).*
