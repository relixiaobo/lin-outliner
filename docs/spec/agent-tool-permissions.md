# Agent Tool Permissions

The single, runtime-owned policy that decides whether an agent tool call is
allowed, must ask the user, or is denied. The model lives in TypeScript (the
prompt never owns permissions). This document is the **authority** for the policy
model; `agent-tool-design.md` defines the tools it governs, and `agent-skills.md`
defines the skill-level inputs (the restricted delegation sandbox and
pre-approved tools) that feed in here.

Original design + rationale: `docs/plans/archive/agent-tool-permissions.md`
(shipped in #60). The non-blocking hardening follow-ups shipped in M1 and are
archived in `docs/plans/archive/agent-tool-permissions-hardening.md`; the
**Known divergences** section at the end records remaining intentional gaps from
the original broad plan.

## Decision model

- Three decisions: **`allow`**, **`ask`** (suspend and request user approval),
  **`deny`**. Pure action-kind and safety-mode decision types live in
  `src/core/agentPermissionModel.ts` (`GlobalToolPermissionDecision`) and are
  re-exported by the main permission-rule module for existing main-process
  callers.
- Every governed operation maps to an **action kind** (`AgentToolActionKind`, ~34
  kinds — e.g. `file.write.workspace`, `shell.network.write`,
  `external.message.send`, `agent.permission.modify`, `payment.purchase`).
- Each action kind resolves to a **`ToolActionDescriptor`** carrying its
  `defaultDecision`, `reversible`, `externalEffect`, `highConsequence`,
  `classifierAutoAllowEligible`, and optional `platformHardBlock` / `command` /
  `capabilities`. Descriptors are the product-authored source of truth; the
  global config can only narrow/loosen within what the descriptor and the
  fail-closed rules permit.
- One app-level **`AgentSafetyMode`** controls descriptor defaults when no
  explicit grant applies: `ask_first`, `balanced`, or `full_access`. Legacy
  stored app-level `permissionMode: trusted|restricted` normalizes at read time
  to `balanced|ask_first`; agent definitions use `permission-mode: restricted`
  only as a narrow delegation sandbox.
- The mode-plus-exception layer is computed by one pure shared function:
  `effectiveActionDecision(actionKind, safetyMode, overrides)` in
  `src/core/agentPermissionModel.ts`. Runtime fallback evaluation and the
  Settings → Security page both use this model, so a row cannot display
  `ask` while the runtime would default the same action kind to `allow`.

## Allowed file area

The runtime passes one resolved local file root into the permission engine as
`workspaceRoot`; file tools and bash path classifiers treat that directory as the
allowed file area.

- A non-empty `LIN_AGENT_LOCAL_ROOT` environment variable is an explicit override
  and resolves with normal `path.resolve` semantics.
- Source/dev runs with no override keep using `process.cwd()`. The clone-specific
  `dev:*` scripts run from the repo clone, so local file tools stay repo-bound in
  development.
- Packaged runs with no override never use `process.cwd()`. Finder and OS
  launches may report `/` as the process cwd, which would make the whole disk
  look like the allowed file area. The packaged fallback is the dedicated
  `<userData>/agent-local-root` directory, created at startup.

This boundary does not loosen the sensitive-path redlines below. Paths outside
the allowed file area still deny or ask according to the descriptor defaults and
global permission rules.

## Evaluation pipeline

Entry point: `agentRuntime.ts` `beforeToolCall` is the only call site driving the
pipeline. Core evaluation is `evaluateAgentToolPermission`
(`src/main/agentPermissions.ts`), in strict precedence:

1. **Platform hard blocks** (descriptors with `platformHardBlock: true`) are
   caught **before** any global rule — they can never be allow-ruled away.
2. **Configured `deny` rules**.
3. **Restricted delegation sandbox** — if an agent/skill run is in
   `restricted` mode, non-base tools must match preapproved `allowed-tools`
   rules before any default profile can allow them.
4. **Configured `allow` / `ask` rules** from the advanced global permission
   store.
5. **Safety-mode profile** (`ask_first`, `balanced`, `full_access`) supplies the
   default decision for every descriptor that no earlier rule resolved.
6. **`ask`** decisions route to the ask resolver (below); **`allow`** runs.

For a compound bash command, every segment is classified and the result is the
**most restrictive** across segments (`deny` > `ask` > `allow`, then by risk,
then by source).

## Safety modes

Safety modes are a first-class default-policy layer. They do **not** materialize
as broad allow rules in `agent-tool-permissions.json`, and they cannot bypass any
platform hard block.

- **Ask First** — preserves passive reads/search/status, but asks for ordinary
  local file/outliner edits and skill invocation in addition to descriptor-level
  asks.
- **Balanced** — the default. It preserves the pre-safety-mode practical
  behavior: local/outliner reads and edits are allowed; execution, deletes, web
  fetch, external mutations, subagent spawn, config writes, Dream, sensitive
  reads, and outside-root access ask or deny according to descriptors.
- **Full Access** — allows classified non-redline routine automation: allowed-root
  file/outliner edits and deletes, web fetch, local code/project script
  execution, dependency install, network writes, git/GitHub mutation, subagent
  spawn, Dream, and background processes. It still asks for deploy/publish,
  sandbox override, config writes, sensitive local reads, and outside-root
  reads/writes; unknown shell, sensitive writes, exfiltration, host destruction,
  permission modification, and payment remain denied.

Skill files follow the ordinary `file_write` / `file_edit` permission decision.
After that decision, the file-tool gateway still validates skill content, records
provenance and rollback metadata, emits skill audit events, and hot-reloads the
registry.

## Settings → Security

The Security page presents the same precedence the runtime uses:

1. **Hard safety blocks** — platform hard blocks and redlines are never waivable
   from settings.
2. **Your exceptions** — explicit `permissions.deny`, `permissions.ask`, and
   `permissions.allow` rules.
3. **The selected safety-mode default** — computed by
   `effectiveActionDecision`.

The three-way safety mode remains the primary control and is a living default:
new action kinds inherit the selected mode through the shared model rather than
through a persisted snapshot. "Custom" is derived, never stored: when explicit
rules create visible deltas against the selected mode, the header reads as a
custom state based on that mode and shows the number of changed actions. Reset to
the mode clears the permission rule lists.

The Exceptions list is the visible delta layer. It shows explicit rules whose
decision differs from the current mode default, plus raw non-Action rules from
the JSON store without inventing provenance. Each exception row shows the rule,
its effective decision, and a revert action that removes that rule from all
permission lists. The collapsed Action Catalog exposes the curated common action
kinds for manual overrides; choosing the mode default removes the override
instead of storing a redundant rule.

## Platform hard blocks

Evaluated first; sourced from descriptors and the bash hard-deny rules
(`BASH_HARD_DENY_RULES`):

- **Host destruction** — recursive root/home/workspace `rm -rf`, `mkfs` /
  `diskutil erase`, raw `dd of=/dev/disk`, `shutdown` / `reboot`, `chmod`/`chown
  -R /`.
- **Remote code execution / obfuscation** — `curl … | sh`, `base64 -d | sh`,
  `eval "$…"`.
- **Sensitive-data exfiltration** — a command that both mentions a sensitive path
  and writes to the network (see Redlines).
- **Persistence / credential / git-internal / permission-config writes** —
  writes to `.bashrc`/`.zshrc`/`.profile`/crontab/LaunchAgents/systemd,
  `.git/{hooks,config,refs,objects}`, or the agent's own
  `agent-tool-permissions/agent-permissions/agent-providers/agent-secrets.json`.
- **Unknown / ambiguous shell** — dynamic construction (backticks, `$( )`,
  `eval`, base64 pipes), non-static `bash -c`, or an unrecognized command head →
  `shell.unknown`.
- **Path access outside the allowed area** when the run has not opted in →
  `path_outside_workspace`; sensitive-path writes via file tools →
  `file.write.sensitive_local_path`.
- **`agent.permission.modify` and `payment.purchase`** are in the
  never-allow-ruled set. (Guardrails only — no tool surface currently *produces*
  these kinds; see Known divergences.)

## Bash classifier

`deriveBashActionDescriptors` (`agentPermissions.ts`):

- Whole-command scans first (hard-deny rules, workspace delete, exfiltration,
  persistence write), plus flags: `dangerouslyDisableSandbox` →
  `shell.sandbox_override`; `run_in_background` → `shell.background_process`;
  sensitive-path mention → `file.read.sensitive_local_path` (ask).
- **Segmentation** (`parseShellSegments`): returns nothing (→ unknown-shell hard
  block) on dynamic construction; expands static `bash -c "…"`; splits on `;`,
  `|`, `||`, `&&` with quote-awareness; strips `env` / `VAR=` prefixes.
- **Per-segment** (`classifyShellSegment`): maps each segment to an action kind —
  destructive cleanup, `rm`, `find -exec`/`-delete`, `git push` / `gh` mutation,
  dependency install, deploy/publish, network-write / outward-facing, db-migration
  / project script, arbitrary-code prefix, `sed -i`, read/search; unrecognized
  head → unknown-shell hard block.
- Descriptors are aggregated **most-restrictive** (`resolveGlobalToolPermission­
  Decision`).

## Ask resolution

`resolveAgentPermissionAsk` (`src/main/agentPermissionAskResolver.ts`), in order:

1. Aborted run → `block`.
2. No descriptor, or an **explicitly configured `ask`** → `needs_user` (a
   configured ask is never relaxed by the classifier).
3. **Safe-allowlist fast path** → `allow`, gated by `isSafeAutoAllowDescriptor`
   (tool in `SAFE_AUTO_ALLOW_TOOL_NAMES`, `!externalEffect && !highConsequence`,
   scope ∈ {allowed file area, none}).
4. **`classifierAutoAllowEligible` gate**: `false` → `needs_user`. Structural
   veto even when eligible: any `externalEffect`, `highConsequence`, sensitive
   local path, or an `unknown` action kind → `needs_user`.
5. Otherwise run the LLM classifier (`agentPermissionClassifier.ts`, temperature
   0, forced `classify_permission_result` tool) → `allow` / `block` /
   unavailable.
6. **Interactive vs unattended fail-safe**: a run is *interactive* iff an
   approval handler is attached. On `needs_user` or classifier-unavailable:
   interactive → suspend and request approval (`requestToolApproval`); unattended
   → structured `permission_denied` (no approval channel).

## Sensitive-data redlines

- `SENSITIVE_PATH_PATTERNS` — `id_rsa`/`id_dsa`/`id_ecdsa`/`id_ed25519`,
  `.pem`/`.key`/`.p12`/`.pfx`, `.ssh`/`.gnupg`/`.aws`/`.azure`/`gh` config,
  Keychains, `.npmrc`/`.pypirc`/`.netrc`/`.env`.
- `looksLikeExfiltrationSink` — an explicit network write (`curl`/`wget` with
  data, `scp`/`sftp`/`rsync`/`rclone`, `aws s3 cp`, `gsutil cp`, `nc`/`netcat`)
  **or** an opaque sink that could carry data out unseen: inline interpreter
  execution (`python -c`, `node -e`, `perl -e`, `ruby -e`, `php -r`,
  `osascript -e`) or `ssh host '<cmd>'`.
- A command that mentions a sensitive path **and** matches a sink is a
  `sensitive_data_exfiltration` hard block.

## Global permission store

`src/main/agentToolPermissionStore.ts` — `agent-tool-permissions.json` under
`userData`, in the grouped form `{ permissions: { allow, ask, deny } }`. The
Security page treats these lists as the exception layer above the selected safety
mode, not as a separate "Granted Trust" surface. Skill content-hash trust still
lives in the skill provenance store; accepted skill hashes remain revocable from
Security but are separate from mode/action exceptions.

- **Fail-closed parse**: `parseGlobalToolPermissionSettings` /
  `parseGlobalToolPermissionRule` validate every rule string
  (`Kind(value)` syntax; `Capability(...)` is deny-only and limited to
  `SUPPORTED_AGENT_TOOL_CAPABILITIES` = `agent_spawn` only; `Tool(...)` allow only
  for safe tools; `Bash(...)` allow rejects arbitrary-code / agent-spawn
  prefixes). An invalid rule becomes a **diagnostic, never a rule** — evaluation
  falls back to the descriptor default.
- **Atomic + locked-down writes**: parent `chmod 0700`, temp-write + `rename`,
  file `chmod 0600`. Diagnostics are surfaced to the renderer.

## Events

Two event families are persisted today (the runtime emits both):

- **Policy decision** — `tool.permission.checked` / `tool.permission.resolved`
  (`src/core/agentEventLog.ts`).
- **UI surface** — `approval.requested` / `approval.resolved` plus transient
  approval IPC. `AgentApprovalRequestView.kind` distinguishes
  `tool_permission`, `skill_trust`, and tell-only `permission_notice` cards.

The denied tool result is `{ ok: false, error: { code: 'permission_denied',
recoverable, details: { reason } } }`. Reasons use the canonical permission
contract strings (`configured_deny`, `policy_denied`, `classifier_blocked`,
`classifier_unavailable`, `platform_hard_block`, `run_aborted`, `runtime`,
`user_denied`). `configured_deny`, `policy_denied`, and
`platform_hard_block` are not recoverable; the other reasons are recoverable
fallback/interaction outcomes.

Permission event sources distinguish explicit and default paths:
`global_rule`, `action_default`, `safety_mode_profile`, `trust_ledger`,
`safe_allowlist`, classifier/runtime/user sources, and denial sources. Current
ledger projection uses `global_rule` for action grants; `trust_ledger` is
reserved for the unified ledger store when skill hashes and future folder grants
move behind the same projection.

## UI surfaces

- **Composer card** (`AgentComposer.tsx` `AgentApprovalCard`) — one component
  renders three interrupt forms:
  - `tool_permission`: *Approve once* (`once`), *Always allow* (`always`, only
    when an always-allow rule is offered), *Hand everything to Lin, stop asking*
    (`full_access`, which sets global `safetyMode` to `full_access` and approves
    the current request), and *Deny once*.
  - `skill_trust`: *Accept skill* records the exact current skill content hash;
    *Not now* resolves false and the `skill` tool returns `skill_not_ratified`.
  - `permission_notice`: tell-only cards for hard/configured policy denials. The
    tool result remains `permission_denied`; the card only makes the block
    visible and dismissible. Notices are a single-slot surface per conversation:
    a newer notice resolves and replaces any older pending notice instead of
    queueing behind it.
  Detail panels show action / target / why / permission-kind or skill hash facts.
  All three card kinds listen to the active run's abort signal. Stopping the run
  resolves the pending card as `approved: false` (`run_aborted` for blocking
  approval waiters) and removes it from renderer pending state.
- **Security center** — the **Security** category in `AgentSettingsView.tsx`
  exposes the global trust level, the derived Custom state, an Exceptions list
  over action permission rules, and a collapsed Action Catalog for manual
  per-action overrides (`agent.delegate.spawn` is shown non-allowable for
  `allow`). Accepted skill hashes are listed separately as skill trust, not as
  mode exceptions. It reads/writes via `agentGetToolPermissionSettings` and
  surfaces store diagnostics. There is no in-app raw-JSON editor (advanced users
  edit the file directly).
- **Agent editor** — agent definitions can only *Follow global* or enter the
  `restricted` delegation sandbox. Legacy `permission-mode: trusted` frontmatter
  is ignored on parse so an agent cannot widen above the global safety mode.

## Inputs from other subsystems

- **Skill restricted sandbox + pre-approved tools** (`agent-skills.md`):
  `restricted` mode and `preapprovedToolRules` are *inputs* to
  `evaluateAgentToolPermission`; their authoring/lifecycle is the skills domain —
  cross-reference, do not restate here.
- **Skill-shell path** — `executeAgentSkillShellCommand`
  (`src/main/agentSkillShell.ts`) is a live second entry point. It calls
  `evaluateAgentToolPermission` and routes an `ask` decision through the shared
  `resolveAgentPermissionAsk`, so the safe-allowlist, classifier-eligibility
  veto, and unattended fail-safe apply the same as the main runtime. (It still
  honors skill `allowed-tools` as run-scoped preapproval through the shared
  evaluator.)

## Known divergences from the plan (shipped-state honesty)

Current behavior differs from the original broad plan in these ways:

1. **Classifier auto-allow is effectively dead in production.** Every shipped
   descriptor sets `classifierAutoAllowEligible: false`, so the LLM classifier is
   reachable only in tests; in the app the only live auto-allow is the
   safe-allowlist, and every other `ask` becomes `needs_user`.
2. **No symlink/realpath resolution** — `resolvePermissionPath` is lexical only.
3. **`external.message.send` / `payment.purchase` / `agent.permission.modify`**
   exist as action kinds + forbidden-rule guardrails but have no descriptor
   resolver (no tool surface produces them yet).
