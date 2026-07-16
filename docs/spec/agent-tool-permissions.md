# Agent Capabilities And System Boundary

Tenon treats the agent as a delegated operator. A user request authorizes the
requested work; destructiveness, reversibility, command complexity, installs,
network effects, publishes, messages, payments, and unfamiliar shell syntax do
not create Tenon confirmation prompts.

Authority follows resource ownership:

- user data is available inside the workdir and persistent folder
  capabilities, including an explicitly granted filesystem root;
- Tenon control state under `userData` is private to product commands and
  services;
- the host boundary is the user's OS account, native authorization, and service
  credentials.

The observable authorization model has exactly three outcomes:

```text
allow                execute immediately
capability_required  acquire a missing resource, remember it, then execute
unavailable          the operation cannot be provided in this context
```

Folder access is the only Tenon-owned capability acquisition. OAuth, Keychain,
TCC, administrator authorization, and CLI login remain owned by their provider
or OS. `ask_user_question` is for missing product input, not authorization.

## Decision Pipeline

A tool call follows one short pipeline:

```text
tool exists in this Run
  -> explicit user block
  -> product ownership invariant
  -> folder capability resolution
  -> execution
  -> audit and recovery
```

The runtime derives `AgentToolActionKind` descriptors for activity labels,
debugging, read-only catalog construction, and exact user-block matching. Those
descriptors are not risk scores and never change authority by themselves.
Unknown shell syntax is an audit label and executes normally.

An absent tool is `unavailable` because the Run's catalog does not contain it.
A control-plane access is `unavailable / control_plane`. An explicit user block
is `unavailable / user_blocked`. Neither opens a folder card or offers a
continue-anyway path.

## Ownership Boundary

The runtime enforces one private control container and a set of agent-visible
data roots:

| Resource | Read | Write | Owner |
| --- | ---: | ---: | --- |
| Current workdir | yes | yes | Run context |
| Attachment scratch | yes | no | Tenon ingestion |
| Cleanup, tool-output, generated-image scratch | yes | yes | Agent output |
| Active skill resources | yes | no | Skill invocation |
| Persistent user folder | yes | yes | User capability |
| Tenon `userData` control state | no | no | Product commands/services |

The workdir and scratch roots can live inside `userData`; they are explicit
exceptions to the private control container. Every other current or future
descendant remains inaccessible even when Home or `/` is granted.

Typed file tools canonicalize the target at their own operation boundary. They
check the control container and then apply read/write roots, so direct tool use
cannot rely only on a higher runtime wrapper. Symlinks are resolved before both
checks.

## Folder Capabilities

`FolderCapabilityService` is the authority for persistent local roots. It:

- accepts existing directories, including `/`;
- canonicalizes with `realpath`;
- compacts duplicate and nested grants;
- persists private JSON atomically;
- serializes concurrent folder and block updates;
- never turns a grant into an implicit revocation of another persisted root;
- applies Settings removals as deltas so concurrent grants are preserved;
- publishes grant and revocation events after persistence.

Relative paths always resolve against the workdir. A capability is used through
an explicit absolute path and does not change that base.

Revocation increments an in-memory generation inside the serialized write,
commits before publication, and terminates foreground or background processes
whose immutable snapshot contains that user root. Process start validates the
generation before and after sandbox preparation, so a preflighted but not-yet-
registered process cannot start with a revoked snapshot.

## Process Boundary

All agent-launched processes use `AgentProcessExecutor`: foreground/background
`bash`, embedded skill shell, ripgrep, converters, and helper commands. The
executor owns spawn, environment construction, process-tree termination, output
capture, timeout, and an immutable capability snapshot. Every spawn and helper
probe must supply that snapshot; there is no executor-generated permissive
fallback. The executor also overlays the application-bound `userData`
control-plane root and its app-owned exception set. Caller snapshots may narrow
that policy but cannot replace it, so incomplete or over-broad snapshots fail
closed instead of weakening control-plane isolation.

On macOS, one probed Seatbelt adapter:

1. allows ordinary process, network, IPC, and OS behavior;
2. recursively denies user-data containers (`/Users` and `/Volumes`) and then
   re-allows only snapshot read roots;
3. permits writes only to snapshot write roots;
4. denies the entire protected `userData` container;
5. re-allows only the declared workdir and scratch exceptions.

If the adapter is unavailable, process execution is unavailable because Tenon
cannot enforce folder capabilities and control-plane isolation. There is no
model-facing sandbox bypass.

`bash.required_folders` declares external roots before process start. Missing
roots follow the folder capability flow. Undeclared filesystem access receives
the real sandbox failure; the model must issue a fresh call with the required
folder. Generic OS/TCC/process `operation not permitted` errors remain command
failures; Tenon does not infer a missing folder from stderr text. A declared
protected control-plane root is `unavailable / control_plane` before UI. Tenon
never replays a partially started process.

The process boundary is capability enforcement, not hostile-code containment.
Docker, Apple Events, OS services, network services, and deliberately malicious
executables remain governed by their own boundaries.

## Credentials

Child processes inherit the user's ambient environment. Variables such as
`GITHUB_TOKEN`, cloud credentials, and custom tokens are user-owned host
capabilities and are not removed by name.

Callers may explicitly mark injected environment keys as Tenon-private. Only
those marked keys are removed. Provider credentials loaded from Tenon's private
store are used for provider requests in main and are never copied into a child
environment.

## Direct Host And Network Execution

Tenon has no action-level hard block for recursive root/home deletion, disk
tools, raw devices, shutdown/reboot, root ownership changes, package installs,
deployments, Git publishes, messages, payments, or unknown shell commands. The
user's OS account and native authorization own those effects.

The unprivileged `web_fetch` client accepts credential-free HTTP(S), including
loopback, private, link-local, and metadata addresses. Direct requests use a
dedicated non-persistent Electron session with `credentials: "omit"`. Browser
fallback uses a separate non-persistent session, serializes fallback navigation,
and clears storage, authentication state, and cache before and after each use. A
future privileged fetch route carrying cookies or product credentials must be a
distinct service contract; it must not hide authority inside this tool.

## Scoped Runs And Skills

Verifier, Research, isolated-skill, and explicitly scoped Runs receive a
narrowed tool catalog before the model starts. A tool outside that catalog
cannot be called. There is no restricted permission evaluator and no run-scoped
preapproval state.

For `execution: isolated`, `allowed-tools` selects whole tool names. Omitted
`allowed-tools` creates a tool-free isolated Run. Inline skills keep the parent
Run's catalog unchanged. Command-pattern entries do not authorize shell forms.

Shell writes under `.agents/skills` are ordinary user-data writes. Typed
`file_write` / `file_edit` retain the validated authoring gateway, provenance,
undo metadata, and hot reload. Shell or external-editor writes are validated on
discovery/load; invalid skills remain unloaded with diagnostics.

## Interaction Flows

### Foreground folder acquisition

1. A typed file tool targets a path, or `bash` declares `required_folders`.
2. The ownership boundary rejects private control state without UI.
3. The folder service computes uncovered canonical roots.
4. A runtime-wide acquisition registry emits one `folder` request per canonical
   folder set, even across concurrent Runs or conversations; each waiting tool
   call retains its own audit pair.
5. **Grant and remember** persists the roots, re-evaluates, and executes once.
   **Cancel** aborts the call.
6. Later Runs, conversations, and launches reuse the capability.

There is no allow-once option, countdown, command exception, or generic risk
approval.

### Unattended acquisition

An unattended Agent Session records one durable `needs_input` folder request and
stops before process execution. Granting the folder starts a new continuation
Session after the original is terminal. The continuation issues a fresh tool
call and never assumes the previous process ran.

Conversation restore projects unresolved requests back into the composer.
Granting the same root from Settings also triggers recovery, so the original
card need not remain mounted. The same grant resolves every covered foreground
waiter and every covered durable request.

### OS and provider acquisition

OAuth, Keychain, TCC, administrator authorization, CLI login, and service
payment flows use their owning system. Tenon may surface concrete remediation
but does not add a second confirmation. The owner remembers successful access.

## Persistent Settings

`agent-capabilities.json` under `userData` contains only:

```ts
interface AgentCapabilitySettings {
  folders: string[];
  blocks: string[];
}
```

Supported user-block syntax is `Action(action.kind)` or
`Command(exact command form)`. Command matching normalizes whitespace outside
quotes. Broad, empty, or unknown entries are inert and produce diagnostics. The
debug panel can add a block from a concrete tool exchange; Settings can remove
it. The default block list is empty.

Settings -> Security contains:

- **Folder Access**: add, list, and revoke persistent roots;
- **Your Blocks**: list and remove explicit user blocks;
- **System Boundary**: explain private Tenon control state and host-owned
  authorization.

Folder picking performs one atomic grant. The Settings draft records only
explicit folder/block removals; Save applies that removal delta to current
persistent state, preserving grants made concurrently by another Run or window.

## Events And Runtime Transport

The durable audit pair is:

- `tool.capability.checked`, outcome
  `allow | capability_required | unavailable`;
- `tool.capability.resolved`, status
  `available | unavailable | cancelled`.

`requestId` joins the pair. Sources and resolution reasons distinguish default
access, remembered folders, folder grants, user blocks, the control plane, user
cancel, runtime failure, and Run abort.

Foreground folder cards use transient `capability_request` /
`capability_resolved` events and the `agent_resolve_capability` command. The
request has `kind: "folder"`; the resolution is `granted | cancelled`. There is
no approval-named transport or persisted approval event track.

## Separate Product Invariants

Some failures are not capability decisions:

- Electron keeps `contextIsolation`, renderer sandboxing, navigation guards,
  and its small renderer permission allow-list;
- Issue execution validates lifecycle, scope, dependencies, and output
  contracts;
- `human-review` completion remains an explicit product workflow;
- typed authoring gateways reject malformed skill definitions;
- providers and the OS may report unavailable credentials or authorization.

These operations return their own direct errors or owner-specific interaction.
They must not be converted into generic risk confirmation prompts.
