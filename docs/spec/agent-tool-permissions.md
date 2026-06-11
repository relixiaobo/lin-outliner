# Agent Tool Permissions

The single, runtime-owned policy that decides whether an agent tool call is
allowed, must ask the user, or is denied. The model lives in TypeScript (the
prompt never owns permissions). This document is the **authority** for the policy
model; `agent-tool-design.md` defines the tools it governs, and `agent-skills.md`
defines the skill-level inputs (permission modes, pre-approved tools) that feed
in here.

Original design + rationale: `docs/plans/archive/agent-tool-permissions.md`
(shipped in #60). The non-blocking hardening follow-ups shipped in M1 and are
archived in `docs/plans/archive/agent-tool-permissions-hardening.md`; the
**Known divergences** section at the end records remaining intentional gaps from
the original broad plan.

## Decision model

- Three decisions: **`allow`**, **`ask`** (suspend and request user approval),
  **`deny`**. Types in `src/main/agentToolPermissionRules.ts`
  (`GlobalToolPermissionDecision`).
- Every governed operation maps to an **action kind** (`AgentToolActionKind`, ~34
  kinds — e.g. `file.write.workspace`, `shell.network.write`,
  `external.message.send`, `agent.permission.modify`, `payment.purchase`).
- Each action kind resolves to a **`ToolActionDescriptor`** carrying its
  `defaultDecision`, `reversible`, `externalEffect`, `highConsequence`,
  `classifierAutoAllowEligible`, and optional `platformHardBlock` / `command` /
  `capabilities`. Descriptors are the product-authored source of truth; the
  global config can only narrow/loosen within what the descriptor and the
  fail-closed rules permit.

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
2. **`deny` rules** (configured or descriptor-default).
3. **`ask`** → routed to the ask resolver (below).
4. **`allow`**.

For a compound bash command, every segment is classified and the result is the
**most restrictive** across segments (`deny` > `ask` > `allow`, then by risk,
then by source).

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
`userData`, in the grouped form `{ permissions: { allow, ask, deny } }`.

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
  approval IPC.

The denied tool result is `{ ok: false, error: { code: 'permission_denied',
recoverable, details: { reason } } }`. Reasons use the canonical permission
contract strings (`configured_deny`, `policy_denied`, `classifier_blocked`,
`classifier_unavailable`, `platform_hard_block`, `run_aborted`, `runtime`,
`user_denied`). `configured_deny`, `policy_denied`, and
`platform_hard_block` are not recoverable; the other reasons are recoverable
fallback/interaction outcomes.

## UI surfaces

- **Composer approval card** (`AgentComposer.tsx` `AgentApprovalCard`) — *Approve
  once* (`once`), *Always allow* (`always`, only when an always-allow rule is
  offered), *Deny once*. No "always deny", no countdown. Detail panel shows
  action / target / why / permission-kind + the always-allow rule string.
- **Permission center** — the **Permissions** category in `AgentSettingsView.tsx`
  renders the common action-kind rows with allow/ask toggles
  (`agent.subagent.spawn` is shown non-allowable), reads/writes via
  `agentGetToolPermissionSettings`, and surfaces store diagnostics. There is no
  in-app raw-JSON editor (advanced users edit the file directly).

## Inputs from other subsystems

- **Skill permission modes + pre-approved tools** (`agent-skills.md`):
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
