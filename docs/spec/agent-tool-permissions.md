# Agent Access Modes And System Boundary

Tenon treats the agent as a delegated local operator. A user request authorizes
the requested work; destructiveness, reversibility, command complexity,
installs, network effects, publishes, messages, payments, and unfamiliar shell
syntax do not create Tenon confirmation prompts.

Filesystem authority is selected in Settings -> Security:

- **Full Access** is the default. File tools and local processes have the same
  filesystem authority as Tenon under the current OS account. Tenon does not
  apply folder capabilities, a process sandbox, or a private `userData`
  boundary.
- **Restricted** is opt-in. File tools and processes are limited to the workdir,
  app-owned scratch, exact active skill resources, and remembered folder
  capabilities. Tenon `userData` control state remains private.

Native TCC, administrator authorization, Keychain controls, CLI login, and
service credentials remain owned by macOS or the relevant provider in both
modes. `ask_user_question` is for missing product input, not authorization.

## Decision Pipeline

A tool call follows one short pipeline:

```text
tool exists in this Run
  -> explicit user block
  -> filesystem mode
  -> Restricted ownership/folder resolution, when selected
  -> execution
  -> audit and recovery
```

The runtime derives `AgentToolActionKind` descriptors for activity labels,
debugging, read-only catalog construction, and exact user-block matching. Those
descriptors are not risk scores and never change authority by themselves.
Unknown shell syntax is an audit label and executes normally.

An absent tool is unavailable because the Run's catalog does not contain it.
An explicit user block is `unavailable / user_blocked`. In Restricted mode,
private control-state access is `unavailable / control_plane` and an uncovered
filesystem root is `capability_required / folder_access_required`.

The observable authorization outcomes remain:

```text
allow                execute immediately
capability_required  Restricted mode needs a remembered folder root
unavailable          the operation cannot be provided in this context
```

## Full Access

Full Access uses the current OS account as the filesystem boundary:

| Resource | Read | Write |
| --- | ---: | ---: |
| Current workdir and scratch | yes | yes |
| Any user-readable/writable host path | yes | yes |
| Tenon documents and event stores | yes | yes |
| Tenon capability and provider settings | yes | yes |
| `agent-secrets.json` and OAuth tokens | yes | yes |
| Import API descriptor and bearer token | yes | yes |

Typed file tools and bash intentionally have the same path authority. Relative
paths still resolve against the workdir, but any absolute path available to the
OS account is valid. File tools canonicalize symlinks and retain their normal
operation contracts, such as read-before-edit, trash-backed deletion, and skill
definition validation; those are tool semantics, not containment.

Full Access combines host reads/writes with the existing process network
authority. A mistaken or prompt-injected agent can read and exfiltrate provider
keys, OAuth tokens, shell credentials, and other host files; directly modify
Tenon stores outside the command layer; alter explicit blocks or startup files;
or exercise the same authority from an unattended Agent Session whose catalog
contains file/process tools. These are accepted mode semantics, not failures of
the Full Access implementation.

Explicit `Action(...)` and `Command(...)` blocks are still checked before tool
dispatch. They are not a tamper-resistant security boundary in Full Access,
because an already-running process can modify their on-disk store.

## Restricted

Restricted mode enforces one private control container and scoped data roots:

| Resource | Read | Write | Owner |
| --- | ---: | ---: | --- |
| Current workdir | yes | yes | Run context |
| Attachment scratch | yes | no | Tenon ingestion |
| Cleanup, tool-output, generated-image scratch | yes | yes | Agent output |
| Exact active/invoked skill resources | yes | no | Skill invocation |
| Persistent user folder | yes | yes | User capability |
| Tenon `userData` control state | no | no | Product commands/services |

The workdir and scratch roots can live inside `userData`; they are explicit
exceptions to the private control container. Managed payloads also live there,
but only the exact enabled version being invoked is a temporary read exception.
The managed index, catalog cache, staging, disabled versions, retained versions,
and every managed write remain private.

Typed file tools canonicalize the target at their own operation boundary, then
check protected control state and read/write roots. Symlinks are resolved before
both checks.

### Folder capabilities

`FolderCapabilityService` is the authority for Restricted persistent roots. It:

- accepts existing directories, including `/`;
- canonicalizes with `realpath`;
- compacts duplicate and nested grants;
- persists private JSON atomically;
- serializes mode, folder, and block updates;
- preserves roots and blocks when the mode changes;
- applies Settings removals as deltas so concurrent grants are preserved;
- publishes grant, revocation, and mode-change events after persistence.

Relative paths always resolve against the workdir. A capability is used through
an explicit absolute path and does not change that base.

Revocation increments an in-memory snapshot generation and terminates active
Restricted processes using that root. Folder requests are never emitted while
Full Access is active; remembered roots stay stored for a later switch back to
Restricted.

## Process Execution

All agent-launched processes use `AgentProcessExecutor`: foreground/background
`bash`, embedded skill shell, ripgrep, converters, and helper commands. The
executor owns spawn, environment construction, process-tree termination, output
capture, timeout, and an immutable snapshot containing filesystem mode, roots,
and revocation generation.

In Full Access, the executor spawns the requested command directly. It does not
probe or invoke `/usr/bin/sandbox-exec`, overlay `userData` protections, or
translate folder roots into a Seatbelt profile.

In Restricted mode on macOS, the probed Seatbelt adapter:

1. allows ordinary process, network, IPC, and OS behavior;
2. recursively denies user-data containers (`/Users` and `/Volumes`) and then
   re-allows only snapshot read roots;
3. permits writes only to snapshot write roots;
4. denies the protected `userData` container;
5. re-allows only the declared workdir, scratch, and exact invoked
   managed-skill exceptions.

The application-bound managed-content protection is a read-only upper bound.
`AgentProcessExecutor` intersects that bound with the invocation snapshot, so
Restricted mode can admit one exact active hash without exposing the managed
store.

If Seatbelt is unavailable, Restricted process execution is unavailable because
Tenon cannot enforce its selected boundary. Full Access does not depend on
Seatbelt availability.

`bash.required_folders` is meaningful only in Restricted mode. Missing declared
roots follow the folder capability flow. Undeclared access receives the real
sandbox failure, and the model must issue a fresh call with the required folder.
Generic OS/TCC/process errors remain command failures; Tenon does not infer a
missing folder from stderr text.

Changing either direction between Full Access and Restricted increments the
snapshot generation and terminates all active agent-launched processes. Process
start checks generation before and after Restricted sandbox preparation, so a
snapshot captured under the previous mode cannot start after the change.

The process boundary is mode enforcement, not general hostile-code containment.
Docker, Apple Events, OS services, network services, and deliberately malicious
executables remain governed by their own boundaries.

## Credentials

Child processes inherit the user's ambient environment. Variables such as
`GITHUB_TOKEN`, cloud credentials, and custom tokens are user-owned host
capabilities and are not removed by name. Callers may explicitly mark injected
environment keys as Tenon-private; only those marked keys are removed.

Provider credentials are not copied into child environment variables. They are
stored as plaintext JSON under `userData` with POSIX mode `0600`, however, so
Full Access processes can read or change them through ordinary filesystem APIs.
Restricted processes cannot reach that store.

## Direct Host And Network Execution

Tenon has no action-level hard block for recursive root/home deletion, disk
tools, raw devices, shutdown/reboot, root ownership changes, package installs,
deployments, Git publishes, messages, payments, or unknown shell commands. The
user's OS account and native authorization own those effects.

The unprivileged `web_fetch` client accepts credential-free HTTP(S), including
loopback, private, link-local, and metadata addresses. Direct requests use a
dedicated non-persistent Electron session with `credentials: "omit"`. Browser
fallback uses a separate non-persistent session and clears storage,
authentication state, and cache before and after each use.

## Scoped Runs And Skills

Verifier, Research, Dream, isolated-skill, and explicitly scoped Runs receive a
narrowed tool catalog before the model starts. A tool outside that catalog
cannot be called. Filesystem mode applies uniformly to every file/process tool
that remains in the catalog; an unattended or delegated Run does not receive an
implicit safer mode.

For `execution: isolated`, `allowed-tools` selects whole tool names. Omitted
`allowed-tools` creates a tool-free isolated Run. Inline skills keep the parent
Run's catalog unchanged. Command-pattern entries do not authorize shell forms.

Shell writes under `.agents/skills` are ordinary user-data writes. Typed
`file_write` / `file_edit` retain the validated authoring gateway, provenance,
undo metadata, and hot reload. Shell or external-editor writes are validated on
discovery/load; invalid skills remain unloaded with diagnostics.

Installing or enabling a managed skill is a product lifecycle action, not a
tool grant. Recommended and Unverified labels do not change the selected
filesystem mode, tool catalog, user blocks, native authorization, or service
credentials.

## Interaction Flows

### Full Access execution

1. The runtime derives audit descriptors and checks explicit user blocks.
2. File tools widen their effective path root to the filesystem root.
3. Processes spawn directly with the Full Access snapshot.
4. Native OS/provider failures are returned as their real errors.

There is no folder request, continue-anyway action, or control-plane exception.

### Restricted foreground folder acquisition

1. A typed file tool targets a path, or `bash` declares `required_folders`.
2. The ownership boundary rejects private control state without UI.
3. The folder service computes uncovered canonical roots.
4. A runtime-wide acquisition registry emits one `folder` request per canonical
   folder set while retaining per-call audit.
5. **Grant and remember** persists the roots, re-evaluates, and executes once.
   **Cancel** aborts the call.
6. Later Restricted Runs, conversations, and launches reuse the capability.

### Restricted unattended acquisition

An unattended Agent Session records one durable `needs_input` folder request and
stops before process execution. Granting the folder starts a new continuation
Session after the original is terminal. Switching to Full Access also resolves
covered pending requests and starts fresh continuation tool calls; it never
replays a partially started process.

Conversation restore projects unresolved requests back into the composer. A
Settings grant or mode change triggers recovery even when the original card is
not mounted.

### OS and provider acquisition

OAuth, Keychain, TCC, administrator authorization, CLI login, and service
payment flows use their owning system. Tenon may surface concrete remediation
but does not add a second confirmation. The owner remembers successful access.

## Persistent Settings

`agent-capabilities.json` under `userData` contains:

```ts
interface AgentCapabilitySettings {
  filesystemMode: 'full-access' | 'restricted';
  folders: string[];
  blocks: string[];
}
```

Missing or invalid `filesystemMode` resolves to `full-access`. The default block
list and folder list are empty. Existing folder grants remain stored while Full
Access is selected.

Supported user-block syntax is `Action(action.kind)` or
`Command(exact command form)`. Command matching normalizes whitespace outside
quotes. Broad, empty, or unknown entries are inert and produce diagnostics. The
debug panel can add a block from a concrete tool exchange; Settings can remove
it.

Settings -> Security contains:

- **Agent Access**: Full Access / Restricted segmented control;
- **Folder Access**: add, list, and revoke persistent roots, visible only while
  Restricted is selected;
- **Your Blocks**: list and remove explicit user blocks in both modes;
- **System Boundary**: mode-specific, truthful host/control-state copy.

Folder picking performs one atomic grant. The Settings draft records a mode
replacement plus explicit folder/block removals. Save applies that patch to the
current persistent state, preserving concurrent grants and blocks.

## Events And Runtime Transport

The durable audit pair remains:

- `tool.capability.checked`, outcome
  `allow | capability_required | unavailable`;
- `tool.capability.resolved`, status
  `available | unavailable | cancelled`.

`requestId` joins the pair. Sources and resolution reasons distinguish default
access, remembered folders, folder grants, user blocks, Restricted control
state, user cancel, runtime failure, and Run abort. Full Access allows use the
existing `default` source; descriptors carry the concrete action/path metadata.

Restricted folder cards use transient `capability_request` /
`capability_resolved` events and the `agent_resolve_capability` command. There
is no approval-named transport or persisted approval event track.

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
