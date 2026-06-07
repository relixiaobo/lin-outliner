---
status: draft
priority: P2
owner: relixiaobo
created: 2026-05-30
updated: 2026-05-30
---

# Agent Tool Permissions — Hardening Follow-ups

Follow-up work after the agent-tool-permissions implementation landed in
[#60](https://github.com/relixiaobo/lin-outliner/pull/60). The core policy (design in
`docs/plans/archive/agent-tool-permissions.md`; current behavior in
`docs/spec/agent-tool-permissions.md`) shipped with its critical/high
bash-classifier and rule-validator fail-opens fixed pre-merge.
This plan tracks the **non-blocking** medium/low items surfaced by the deep
review that were deliberately deferred out of the fix commit. None is a live
fail-open today; each is correctness-of-contract, defense-in-depth, or
observability.

The contract from `agent-tool-permissions.md` still governs. Where this plan
and that plan disagree, the parent plan wins. Every change must preserve the
existing precedence (`platform hard block > configured deny > configured ask >
configured allow > descriptor default > classifier`) and must never widen
access. Keep `bun run typecheck` green and add a test for each item.

All line numbers are against `main` at the time of writing (post-#60,
`633d502`); re-confirm with a quick grep before editing, since the file moves.

## Items

### 1. `sessionApproved` short-circuits to allow before configured-ask — RESOLVED

Resolved by removing conversation-scoped approval from the permission model.
Approval choices are now only `once` or `always`; stale conversation-shaped rule
fixtures are ignored and cannot relax configured/default `ask` decisions. Skill
`allowed-tools` remains as run-scoped preapproval and is separate from user
approval scope.

### 2. `parseGlobalToolPermissionSettings` pre-shaped early-return — RESOLVED

Resolved in the M1 review-fix commit. Pre-shaped permission configs are
re-validated from `ruleValue` instead of being trusted verbatim, and forbidden
global allows such as `Action(agent.config.write)` are stripped with diagnostics.

### 3. Exfil redline misses interpreter / ssh sinks and bare SSH-key variants — RESOLVED

**Resolved (enumerated-sink approach).** `looksLikeExfiltrationSink`
(`src/main/agentPermissions.ts`) now recognizes opaque sinks — inline interpreter
execution (`python -c` / `node -e` / `perl -e` / `ruby -e` / `php -r` /
`osascript -e`) and `ssh host '<cmd>'` — in addition to the network-write verbs,
and `id_dsa` / `id_ecdsa` are in `SENSITIVE_COMMAND_PATTERNS`. A sensitive-path
mention plus any such sink is a `platform_hard_block` (tests in
`tests/core/agentPermissions.test.ts`). Current behavior is specced in
`docs/spec/agent-tool-permissions.md`.

Deferred: the broader **structural** rule (sensitive-read + ANY external segment
→ hard block, instead of enumerating sinks) remains a possible future tightening.

### 4. Dual event vocabulary left live — RESOLVED

Resolved by using one `permission-<uuid>` request id for the policy decision,
approval UI events, and transient approval IPC. `tool.permission.*` is the policy
decision record; `approval.*` is the UI-surface record, joinable by `requestId`.

### 5. Denied-reason literals diverge from the plan contract — RESOLVED

Resolved by making `platform_hard_block` and `user_denied` the canonical
wire-level reason strings. The denied tool result now drives `recoverable` from
an explicit set: `configured_deny` and `platform_hard_block` are not recoverable;
classifier/runtime/user/abort outcomes are recoverable fallback paths.

## Out of scope

- ~~The skill-shell second permission path (`agentSkillShell.ts`)~~ — RESOLVED:
  the path is live (wired in `agentRuntime.ts`), and `ask` decisions now route
  through the shared `resolveAgentPermissionAsk` (safe-allowlist,
  classifier-eligibility veto, and unattended fail-safe applied consistently).
- `Capability(external_messaging)` / `Capability(payments)` enforcement — these
  capabilities are now narrowed out of `SUPPORTED_AGENT_TOOL_CAPABILITIES` (no
  longer falsely advertised); emit `descriptor.capabilities` when the
  corresponding tool surface actually lands.
- Symlink-following on workspace write paths (lexical-only `resolvePermissionPath`)
  — pre-existing on `main`, not introduced by #60; handle with the broader
  realpath hardening if/when it is scoped.

## Acceptance

- `bun run typecheck` clean.
- Each item above lands with the named test(s).
- No regression in the existing permission test matrix
  (`tests/core/agentPermissions.test.ts`,
  `tests/core/agentPermissionAskResolver.test.ts`) — 30/0 today.
- The precedence and redline invariants from `agent-tool-permissions.md` still
  hold; no change widens access.
