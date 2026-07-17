# Agent Full Access And System Boundary

Tenon treats the agent as a delegated local operator. A user request authorizes
the requested work; destructiveness, command complexity, installs, network
effects, publishes, messages, payments, and unfamiliar shell syntax do not add
Tenon confirmation prompts.

Agent file tools and local processes always use the filesystem authority of the
current OS account. Tenon has no agent filesystem mode, folder capability,
private `userData` boundary, or process sandbox. Native TCC, administrator
authorization, Keychain controls, CLI login, and service authentication remain
owned by macOS or the relevant provider.

`ask_user_question` gathers missing product input. It is not an authorization
prompt.

## Decision Pipeline

Every tool call follows one short pipeline:

```text
tool exists in this Run
  -> derive audit descriptors
  -> explicit user block
  -> execute
  -> durable capability audit
```

The Run's tool catalog is the first boundary: a tool outside the catalog cannot
be called. For a present tool, Tenon derives `AgentToolActionKind` descriptors
for activity labels, debugging, read-only catalog construction, and exact block
matching. Descriptors are not risk scores and do not change authority by
themselves. Unknown shell syntax receives an audit label and executes normally.

The authorization outcomes are:

```text
allow        execute immediately
unavailable  an explicit user block prevents dispatch
```

There is no access-acquisition outcome or pause-and-resume authorization flow.

## Filesystem Access

Typed file tools and local processes have the same host filesystem authority:

| Resource | Read | Write |
| --- | ---: | ---: |
| Run workdir and scratch | yes | yes |
| Any host path allowed to the OS account | yes | yes |
| Tenon documents and event stores | yes | yes |
| Tenon settings and provider credentials | yes | yes |
| Import API descriptor and bearer token | yes | yes |

Relative paths resolve against the Run workdir. Absolute paths address the host
filesystem directly. Symlinks can resolve outside the workdir because the
workdir is a path base, not a containment root.

Typed tools retain correctness contracts that are independent of authority:

- `file_edit` and overwriting `file_write` require a fresh complete read;
- `file_delete` moves content to the agent trash and refuses the workdir root
  and the trash root itself;
- Skill definition writes are validated, recorded, and hot-reloaded;
- parsers, output limits, and format validation continue to apply.

These contracts prevent malformed tool operations; they are not a filesystem
sandbox. Direct shell commands can bypass typed-tool semantics.

## Process Execution

All agent-launched processes use `AgentProcessExecutor`, including foreground
and background bash, embedded Skill shell commands, ripgrep, document/PDF
converters, and helper programs. The executor:

- spawns commands directly with the requested workdir;
- constructs the child environment and removes only keys explicitly marked
  Tenon-private by the caller;
- captures bounded output and owns timeouts;
- terminates the process group when stopping a Run or background task.

It has no filesystem snapshot, root list, sandbox adapter, mode transition, or
Seatbelt health probe. It does not invoke `sandbox-exec`.

Child processes inherit user-owned environment variables such as shell, GitHub,
and cloud credentials. Provider credentials are not copied into child variables,
but they are stored as private-mode files under `userData`, so any Full Access
process can read or modify them through the filesystem.

Native OS failures and provider/service failures are returned as their real
errors. Tenon does not infer missing filesystem authorization from stderr and
does not add an internal recovery card.

## Direct Host And Network Effects

Tenon has no action-level hard block for recursive deletion, disk tools, raw
devices, shutdown/reboot, ownership changes, package installs, deployments, Git
publishes, messages, payments, or unknown shell commands. The OS account and
native authorization own those effects.

The unprivileged `web_fetch` client accepts credential-free HTTP(S), including
loopback, private, link-local, and metadata addresses. Direct requests use a
dedicated non-persistent Electron session with `credentials: "omit"`. Browser
fallback uses a separate non-persistent session and clears storage,
authentication state, and cache before and after each use.

A mistaken or prompt-injected file/process-capable agent can read and exfiltrate
provider keys, OAuth tokens, shell credentials, and other host files; directly
modify Tenon stores outside the command layer; change block rules or startup
files; or affect external systems through inherited credentials and network
access. This is the explicit Full Access product boundary.

## Scoped Runs, Sub-agents, And Skills

Verifier, Research, Dream, delegated sub-agent, isolated-Skill, and explicitly
scoped Runs receive a narrowed tool catalog before the model starts. A file or
process tool that remains in that catalog has the same host-account authority as
the main agent. A narrower catalog controls callable operations; it does not
create filesystem or process isolation.

Main and sub-agent processes share the host filesystem, Git worktrees, process
namespace, ports, databases, Tenon state, credentials, and external service
accounts. Concurrent agents can interfere with each other when they mutate the
same resource. Workflows that need isolation must allocate separate worktrees,
`userData` directories, ports, accounts, containers, or VMs. Tenon does not
provide that isolation automatically.

For `execution: isolated`, `allowed-tools` selects whole tool names. Omitted
`allowed-tools` creates a tool-free isolated Run. Inline Skills keep the parent
Run's catalog unchanged. Command-pattern entries do not authorize shell forms.

Typed `file_write` / `file_edit` calls under recognized Skill roots retain the
validated authoring gateway, provenance, undo metadata, and hot reload. Shell
or external-editor writes are validated on discovery; invalid Skills stay
unloaded with diagnostics.

Installing or enabling a managed Skill is a product lifecycle action, not a
tool grant. Recommended and Unverified labels do not change host authority,
tool catalogs, user blocks, native authorization, or service credentials.

## Explicit Blocks

`agent-capabilities.json` under `userData` contains only:

```ts
interface AgentCapabilitySettings {
  blocks: string[];
}
```

The default list is empty. Supported syntax is `Action(action.kind)` or
`Command(exact command form)`. Command matching normalizes whitespace outside
quotes. Broad, empty, malformed, and unknown entries are inert and produce
diagnostics. Local-file actions use `file.*.local_path` and
`file.*.sensitive_local_path`; there is no inside/outside Tenon area split.

Blocks are checked before dispatch for every Run. The debug panel can append a
block from a concrete tool exchange; Settings can remove blocks. They are local
dispatch policy, not tamper-resistant containment: a process with host
filesystem access can change their store, invoke alternate host mechanisms, or
continue work it already started.

Settings -> Security contains:

- **Agent Access**: fixed **Full Access** status and host-authority description;
- **Your Blocks**: list and remove explicit user blocks;
- **System Boundary**: OS-account scope plus native authorization caveats.

There is no mode switch, folder list, folder picker, or authorization card.

## Events And Runtime Transport

The durable audit pair remains:

- `tool.capability.checked`, outcome `allow | unavailable`;
- `tool.capability.resolved`, status
  `available | unavailable`.

`requestId` joins the pair. Sources distinguish default access from user blocks.
The runtime emits the pair together before dispatch; there is no in-flight
capability request to cancel. Action/path descriptors remain payload-backed
audit data.

There are no folder request/resolution renderer events, commands, notification
payloads, replay records, or composer cards.

## Separate Product Invariants

These boundaries remain independent of agent Full Access:

- Electron keeps `contextIsolation: true`, renderer `sandbox: true`,
  `nodeIntegration: false`, CSP, navigation guards, and its small permission
  allow-list;
- Issue execution validates lifecycle, scope, dependencies, and output
  contracts;
- stored local-file references retain their renderer-facing trusted-root and
  safe-open validation;
- `human-review` completion remains an explicit product workflow;
- typed authoring gateways reject malformed Skill definitions;
- providers and the OS may report unavailable credentials or authorization.

They return their own errors or owner-specific interaction and must not be
converted into generic risk confirmation prompts.
