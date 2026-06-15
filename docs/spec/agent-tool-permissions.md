# Agent Tool Permissions

The permission gate is the single runtime-owned policy that decides whether an
agent tool call is allowed, asks the user, or is denied. The prompt never owns
permissions. `agent-tool-design.md` defines the tools; `agent-skills.md` defines
the restricted delegation sandbox and skill `allowed-tools` inputs that feed this
gate.

This document describes the current consequence-based model implemented by
`src/core/agentPermissionModel.ts`, `src/main/agentPermissions.ts`,
`src/main/agentToolPermissionRules.ts`, and
`src/main/agentToolPermissionStore.ts`.

## Decision Model

Every governed operation projects to one `AgentOperationEffect`:

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

`decideAgentOperationEffect(effect)` is the core pure function:

- `floor` -> `deny`
- `network_read` -> `allow`
- local + reversible + non-credential -> `allow`
- everything else -> `ask`

`AgentToolActionKind` values still exist, but only as audit labels and tool
catalog metadata. They are not the decision key.

## Allowed File Area

The agent has two app-owned roots:

- **workdir**: the cwd and write root. Relative file-tool paths resolve here.
- **scratch**: app-owned materialized attachments, web-fetch binaries, overflow
  logs, and PDF page images.

The boundary is asymmetric:

- Reads may touch workdir and scratch.
- Writes may touch only workdir.

File tools enforce the boundary through `resolveWorkspacePath`, using realpath
containment. The permission gate mirrors the same policy lexically so scope
escapes are caught before execution. `file_glob` and `file_grep` default to the
workdir, so scratch is reached only through explicit absolute paths the app
hands to the agent.

## Reversible Local Work

Reversible local work is allowed silently. Current examples:

- `file_read`, `file_glob`, `file_grep`
- `file_write` and `file_edit` inside workdir
- `file_delete` inside workdir, because it moves files or directories to
  `.agent-trash` instead of unlinking them
- outliner node create/edit/delete operations
- static local shell commands that do not hit a safety floor or commit boundary
- local build/test/project validation commands
- web search and web fetch, treated as network reads
- local control-plane actions such as child-run spawn/status/send/stop, skill
  invocation, task stop, Dream, and whitelisted runtime config writes; any
  downstream tool calls still pass through their own permission gate

Shell `rm` remains an ask path because the runtime executes the user's shell
form as written; it is not rewritten into `file_delete`.

## Commits and Grants

An ask is a COMMIT: the user should pull the trigger once, or remember a narrow
boundary. The approval card offers allow once, always for this boundary when a
grant exists, or deny.

Grants are narrow by construction:

```ts
type Grant =
  | { kind: 'scope'; access: 'read' | 'write'; root: string }
  | { kind: 'external'; target: string }
  | { kind: 'command'; form: string };
```

The persisted store is `agent-tool-permissions.json` under `userData`:

```json
{ "grants": ["Scope(read:/some/folder)", "Scope(write:/some/folder)", "External(git:origin)", "Command(npm publish)"] }
```

Scope grants match the granted root and its descendants, but read grants do not
authorize writes. Invalid strings, legacy broad action exceptions, and legacy
unqualified `Scope(/path)` grants become diagnostics and never take effect.
Writes are serialized, atomically renamed into place, and locked down with
private file permissions.

## Evaluation Pipeline

`AgentRuntime.beforeToolCall` is the live entry. Core evaluation is
`evaluateAgentToolPermission`:

1. Normalize the tool and derive one or more descriptors with effects.
2. Platform safety floor descriptors deny before grants.
3. Restricted sandbox denies non-base tools unless a run-scoped preapproved tool
   rule matches.
4. A matching persisted grant flips only its matching commit to allow.
5. `decideAgentOperationEffect` supplies the default allow/ask/deny decision.
6. Ask decisions suspend interactive runs for approval; unattended paths return
   structured `permission_denied`.

For compound bash commands, every segment is classified. Decision priority is
deny > ask > allow, then explicit grant source, then descriptor risk. This keeps
the audit event pointed at the boundary that actually authorized a remembered
grant.

## Safety Floor

The floor is non-configurable and cannot be bypassed by grants:

- **exfiltration**: a sensitive path combined with a network or opaque outward
  sink.
- **host destruction**: root, home, or whole-workdir recursive deletion, disk
  erase, raw disk overwrite, shutdown/reboot, recursive ownership/permission
  changes on `/`.
- **persistence**: writes to shell startup files, cron/LaunchAgents/systemd user
  units, git internals, or the agent's own permission/provider/secret stores.
- **hidden exec**: dynamic or obfuscated shell construction such as backticks,
  `$()`, `eval`, decode-and-pipe forms, or remote-code pipes.
- **permission self-modification** and **payment** guardrail action kinds.

Sensitive credential reads are commits even inside the handed scope. Credential
plus outward sink is exfiltration and is denied.

## Bash Projection

`deriveBashActionDescriptors` runs whole-command floor checks first, then
extracts static path tokens for the same scope check used by file tools. Dynamic
or ambiguous shell construction is a hidden-exec floor.

Static shell segments map to audit labels such as local code execution, project
script, dependency install, network write, git publish, deploy/publish, local
file edit/delete, or `shell.unknown` for a plain unrecognized static command.
`shell.unknown` is allowed when it is local, reversible, and non-credential; it
is not a hard block by itself.

## Restricted Skill Sandbox

The skill/agent `restricted` mode is orthogonal to the global permission model.
It narrows a run's available tool surface before effect decisions run:

- A read-only base set remains available.
- Non-base tools require a matching run-scoped `allowed-tools` preapproval rule.
- Even when preapproved, the call still goes through effect projection, safety
  floors, grants, and ask handling.

Skill content-hash ratification is separate from permission grants.

## Settings and UI

Settings -> Security has no mode selector. It shows:

- one delegated-operator row explaining the default policy,
- remembered grants,
- accepted skill hashes,
- diagnostics for ignored permission-rule strings.

Approval cards are the runtime interruption surface:

- `tool_permission`: allow once, always for this boundary when available, deny.
- `skill_trust`: accept or reject the current skill content hash.
- `permission_notice`: tell-only cards for floor/configured denials.

The old "hand everything to Lin" escape hatch is gone.

## Events and Denials

The runtime persists:

- `tool.permission.checked`
- `tool.permission.resolved`
- `approval.requested`
- `approval.resolved`

`tool.permission.checked.source` is `default` for consequence decisions and
`trust_ledger` for remembered grants. Hard denials surface as permission notices
and tool results:

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
approval needs; safety-floor denials are not recoverable.
