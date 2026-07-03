# Agent Tool Permissions

The permission gate is the single runtime-owned policy for agent tool calls. It
decides whether a call runs, is soft-blocked with a user override, or is hard
blocked. The prompt never owns permissions. `agent-tool-design.md` defines the
tools; `agent-skills.md` defines the restricted delegation sandbox and skill
`allowed-tools` inputs that feed this gate.

The current model is default-allow with a tiny non-overridable redline and a
user-editable blocklist. It is implemented by
`src/core/agentPermissionModel.ts`, `src/main/agentPermissions.ts`,
`src/main/agentToolPermissionRules.ts`, and
`src/main/agentToolPermissionStore.ts`.

## Decision Model

Every governed operation projects to one `AgentOperationEffect` and one or more
audit descriptors:

```ts
interface AgentOperationEffect {
  reach: 'local' | 'outside_scope' | 'network_read' | 'network_write' | 'external_system';
  reversible: boolean;
  touchesCredentials: boolean;
  floor?: 'exfiltration' | 'host_destruction' | 'persistence' | 'hidden_exec' | 'permission_self_mod' | 'payment';
  label: string;
  grant?: Grant;
}
```

`decideAgentOperationEffect(effect)` is intentionally small:

- `floor` -> `deny`
- everything else -> `allow`

`AgentToolActionKind` values still exist as audit labels, read-only catalog
metadata, and user blocklist keys. They are not a consequence severity model.

The public permission vocabulary is:

- `allow`: run the tool and record the derived action kinds.
- `ask`: stop for explicit user approval before widening a typed file-tool root,
  currently used when typed file read/search/write/delete tools target a local
  non-sensitive path outside the handed file area. **Always allow** records a
  narrow `Scope(read:/absolute/path)` or `Scope(write:/absolute/path)` grant.
- `soft_blocked`: stop and show a card with **Allow once**, **Always allow**, and
  **Block now**. If the user does nothing, the card auto-blocks after its
  countdown.
- `blocked`: hard redlines, restricted sandbox denials, runtime cancellation, or
  explicit/expired soft-block denials.

The legacy ask resolver and event schema remain shared with non-permission
approval surfaces such as skill trust.

## Allowed File Area

Default-allow does not remove the typed file-tool execution boundary. File tools
still operate inside explicit roots enforced by `resolveWorkspacePath` and
realpath containment:

- **workdir**: the cwd and default write root. Relative file-tool paths resolve
  here.
- **project self-definition root**: `<workdir>/.agents/skills`. This root is part
  of the typed file-tool area so `/skillify` can use the same file tools as normal
  project work. (The one-Neva invariant makes skills the only self-definition
  surface; agent authoring under `.agents/agents` is no longer a write surface.)
  The personal/global self-definition root `~/.agents/skills` is not implicitly in
  every workspace's file area; it requires an explicit handed write scope.
- **scratch**: app-owned materialized attachments, web-fetch binaries, overflow
  logs, and PDF page images. Reads may use scratch; writes do not.
- **active skill resource roots**: when an inline skill has been invoked and has a
  real resource directory, that skill directory is projected into the typed file
  boundary as a read-only root so the agent can load referenced support files
  such as `references/*.md` through `file_read`. In dev this may be either a
  Tenon-owned `src/main/builtInSkills/<skill>` path or an enabled
  `linlab-skills/<skill>` path; in packaged builds it is the copied app-resource
  `built-in-skills/<skill>` directory. Restored history only counts if that path
  still matches the currently registered skill, so transcript text cannot grant
  arbitrary reads. It never grants write access and does not expose
  sibling skills or arbitrary parent folders.
- **handed folders**: users may hand Tenon a real folder from Settings ->
  Security. That records a legacy `Scope(write:/absolute/folder)` grant and the
  runtime projects that scope into the file-tool execution layer.
- **approved outside-scope file roots**: when a typed file tool targets a
  non-sensitive path outside the current boundary, the permission layer asks
  before the file tool runs. Approval for once projects that exact
  `Scope(read:/absolute/path)` or `Scope(write:/absolute/path)` into the current
  run's file-tool roots; approval for always also persists the grant. Isolated
  read-only skill runs, including `/research`, inherit the same approval flow and
  can continue after the parent conversation approves the scope.

The boundary is asymmetric:

- Reads may touch workdir, project self-definition roots, scratch, active skill
  resource roots, and handed `read` / `write` scope roots.
- Writes may touch workdir, project self-definition roots, and handed `write`
  scope roots.
- Relative file-tool paths still resolve against workdir; handed folders are
  reached through explicit absolute paths.

`data_import` uses this same read boundary for its `pack_file` input. The pack is
local data read, but the tool's consequence is a bulk outliner mutation, so its
action-kind profile is `outline.edit`. Approval/blocking decisions therefore
follow outline edit policy after the pack path has passed the local read jail.

The self-definition roots only extend where typed file tools may execute; they
do not bypass the content gateway. Skill writes are validated as skill content,
agent-definition writes are limited to restricted `AGENT.md` creates/edits, and
`file_delete` refuses both skill and agent definition content. Conversion outputs
and shell writes are not accepted self-definition authoring routes; use
`file_write` / `file_edit` so the content gateway can validate and hot-reload.

Shell commands are the broad local execution surface. They may operate outside
the typed file boundary unless they hit a hard redline, a built-in soft block, or
a user blocklist rule.

## Default Allow

These run silently unless a hard redline, built-in soft block, restricted
sandbox, or user blocklist rule matches:

- local file read/write/edit/delete inside the allowed file area;
- `data_import` staging writes from a validated Import Pack, audited as
  `outline.edit`;
- local code execution such as Python, Node, shell scripts, build tools, tests,
  converters, and project scripts;
- dependency installs;
- network reads such as search/fetch;
- external CLI actions such as `git push`, `gh pr create`, deploy commands, and
  message sends;
- local control-plane actions such as sub-run `spawn_run`, `run_status`,
  `run_steer`, `run_amend`, `run_stop`, skill invocation, task stop, Dream, and
  whitelisted runtime config writes.

This deliberately trades approval prompts for model judgment, durable audit, and
fast user correction through the blocklist.

## Hard Redline

Hard redlines are non-configurable and cannot be bypassed by grants or soft-block
exceptions:

- **credential exfiltration**: a sensitive credential path combined with a
  network write or opaque outward sink.
- **permission self-modification**: attempts to alter agent permission/provider
  or secret configuration through tools.
- **payment / purchase**: future payment actions unless a separate product-owned
  payment confirmation flow exists.
- **host destruction**: root, home, or whole-workdir recursive deletion; disk
  erase; raw disk overwrite; shutdown/reboot; recursive ownership or permission
  changes at filesystem root.

Sensitive credential reads default to allow when they are not paired with an
outward sink, including when the path is outside the handed file area. Credential
plus outward sink is exfiltration and is blocked.

## Built-In Soft Blocks

The built-in blocklist is intentionally minimal and user-overridable:

- **remote or decoded code execution**: `curl|wget ... | sh`, decode-and-pipe
  shell forms, and explicit `eval` / interpreter-eval forms that execute opaque
  generated code.
- **OS-level persistence / self-amplification**: writes to shell startup files,
  cron, LaunchAgents, systemd user units, and git internals that can persist or
  rewrite repository behavior: `.git/hooks/*`, `.git/config`, `.git/refs/**`, and
  `.git/objects/**`.

These do not soft-block by default:

- `git push`, GitHub CLI mutations, deploys, package publishes, and message
  sends;
- ordinary shell command substitution using `$(...)` or backticks;
- ordinary project-local file edits that do not hit a redline, soft block, or
  user block.

When a built-in soft block fires, **Always allow** adds a narrow
`softBlockAllows` rule, usually `Command(exact command)` for shell calls or
`Scope(write:/absolute/path)` for path-specific file writes.

## User Blocklist

`agent-tool-permissions.json` under `userData` stores global permission rules:

```ts
interface AgentToolPermissionSettings {
  grants?: string[]; // legacy file-boundary grants
  blocks: string[];
  softBlockAllows: string[];
}
```

Rule syntax:

- `Action(git.publish_remote)`
- `Command(git push origin main)`
- `External(git push origin main)`
- `Scope(read:/some/folder)`
- `Scope(write:/some/folder)`

Command rules are displayed and persisted in their original spelling, but
matching normalizes whitespace outside quotes so debug-panel blocks and
soft-block exceptions keep working across formatting-only command variants.

`blocks` are user blacklists. A match returns `soft_blocked`. **Always allow** on
a user block removes the matching block rule.

The agent debug log is also a correction surface. Tool-exchange rows that can be
mapped to this rule language show an **Add to user blocks** action. Shell calls
with a captured `command` become `Command(exact command)`; tools with a single
known audit action become `Action(action.kind)`. Ambiguous tool rows do not offer
the action rather than writing invalid or overly broad rules.

`softBlockAllows` are exceptions for the built-in soft blocks. A match allows
the call. Invalid strings, unsupported action kinds, legacy broad grants, and
unqualified `Scope(/path)` values become diagnostics and never take effect.
Writes are serialized, atomically renamed into place, and locked down with
private file permissions.

`grants` are retained for handed file folders and compatibility, and are also
the persistence target for outside-scope typed file-tool approvals.

## Evaluation Pipeline

`AgentRuntime.beforeToolCall` is the live entry. Core evaluation is
`evaluateAgentToolPermission`:

1. Normalize the tool and derive one or more descriptors with effects.
2. Hard redline descriptors deny.
3. Restricted sandbox denies non-base tools unless a run-scoped preapproved tool
   rule matches.
4. A matching user `blocks` rule returns `soft_blocked`.
5. A built-in soft-block descriptor returns `soft_blocked` unless a matching
   `softBlockAllows` rule exists.
6. An unmatched `outside_scope` typed file-tool descriptor returns `ask`; a
   matching `Scope(...)` grant allows and is projected into the local file-tool
   execution boundary.
7. Everything else allows.

For compound bash commands, shell-surface segments are classified and ranked.
Decision priority is `deny > soft_block > allow`, then source rank, then
descriptor risk. This keeps the audit event pointed at the reason that actually
blocked or allowed the call.

## Bash Projection

`deriveBashActionDescriptors` runs whole-command redline and soft-block checks
first, then extracts static path tokens for file-boundary audit descriptors.
Static shell segments map to audit labels such as local code execution, project
script, dependency install, network write, git publish, deploy/publish, local
file edit/delete, or `shell.unknown` for a plain unrecognized static command.

Static heredocs are parsed as one outer shell command. The heredoc body is not
split on shell operators and does not trigger shell redlines or soft blocks by
accident; the outer command still classifies as local code execution. This keeps
generated Python/Node artifacts from producing fake `hidden_exec` decisions.
Heredoc detection ignores quoted `<<`, comments, and here-strings (`<<<`) so a
live command following those forms still participates in redline and soft-block
scans.

## Restricted Skill Sandbox

The skill/agent `restricted` mode is orthogonal to the global permission model.
It narrows a run's available tool surface before blocklist decisions run:

- A read-only base set remains available.
- Non-base tools require a matching run-scoped `allowed-tools` preapproval rule.
- Even when preapproved, the call still goes through descriptor projection, hard
  redlines, user blocks, and built-in soft blocks.

`data_import` is not part of the read-only base set because it mutates the
outliner. A restricted data-cleanup skill must declare `data_import` in
`allowed-tools` before it can stage cleaned data, and the call still records
`outline.edit`.

Skill content-hash ratification is separate from permission rules.

## Settings and UI

Settings -> Security has no mode selector. It shows:

- one delegated-operator row explaining default allow and hard redlines;
- user blocklist rules;
- built-in soft-block exceptions;
- file boundaries from handed folders / legacy grants;
- accepted skill hashes;
- diagnostics for ignored permission-rule strings.

Soft-block cards are the permission interruption surface:

- **Allow once**: run this call only.
- **Always allow**: for a built-in soft block, add a matching
  `softBlockAllows` rule; for a user block, remove that block rule.
- **Block now**: immediately deny. If the user does nothing, the countdown
  auto-blocks. The renderer shows the countdown, and the main process owns the
  authoritative timeout so a renderer crash or unmount cannot leave a tool call
  pending forever.

Hard redlines do not create user-facing approval or notice cards. The runtime
records the denial in tool permission events and returns a `permission_denied`
tool result to the model. Skills are default-ratified and do not use a separate
trust approval card.

## Events and Denials

The runtime persists:

- `tool.permission.checked`
- `tool.permission.resolved`
- `approval.requested`
- `approval.resolved`

`tool.permission.checked.outcome` is `allow`, `soft_blocked`, or `blocked` for
new permission decisions. Legacy `ask` may still appear in older logs.
`tool.permission.checked.source` is `default`, `built_in_soft_block`,
`user_blocklist`, `soft_block_allow`, `user`, `configured_deny`, `runtime`,
`trust_ledger`, or `platform_hard_block` depending on the path.

Denied tool calls return structured `permission_denied` results:

```json
{
  "ok": false,
  "error": {
    "code": "permission_denied",
    "recoverable": false,
    "details": { "reason": "platform_hard_block" }
  }
}
```

Recoverable denials include user rejection, runtime cancellation, and unattended
soft blocks. Hard redlines are not recoverable inside the app.
