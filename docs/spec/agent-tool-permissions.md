# Agent Tool Permissions

Agent permissions are capability-first. A user request authorizes the requested
work; risk labels, reversibility, command complexity, network effects, installs,
publishes, and other ordinary side effects do not create confirmation prompts.
The permission layer asks only when execution needs a local folder that Tenon
does not already have, and it remembers that folder after the user grants it.

The runtime owns this policy. Prompts and skills may suggest tools, but they
cannot widen the capability set or bypass a block. `agent-tool-design.md`
defines the tools, and `agent-skills.md` defines the restricted delegation mode
and skill `allowed-tools` metadata that feed this policy.

## Decision Model

Every tool call has exactly one permission outcome:

- `allow`: execute immediately.
- `folder_required`: stop before side effects and request one or more persistent
  folder capabilities.
- `blocked`: reject directly. A block never opens an approval card and cannot be
  bypassed by granting a folder.

Evaluation order is deliberately short:

1. Normalize the tool call and derive audit descriptors.
2. Apply the non-overridable hard floor.
3. Apply a restricted-Run tool ceiling.
4. Apply explicit user block rules.
5. Preflight local folder capabilities.
6. Allow.

`AgentToolActionKind` values describe calls for audit, restricted-Run tool
selection, and explicit user blocks. They are not a risk score. Unknown static
shell syntax is an audit label and still runs.

## Folder Capabilities

The folder capability service is the sole authority for local file roots. It
canonicalizes existing directories with `realpath`, rejects filesystem-root
grants, removes duplicate/nested roots, persists private JSON atomically, and
publishes grant and revocation events.

The effective roots are:

| Root | Access | Lifetime |
| --- | --- | --- |
| Current workdir | read/write | Run context |
| App attachment scratch | read | app-owned |
| Cleanup, tool-output, and generated-image scratch | read/write | app-owned |
| Active skill resources | read | active invocation |
| User-granted folder | read/write | persistent |

Relative file paths resolve against the workdir. A granted folder is reached by
an explicit absolute path; adding it does not change the relative base.

Typed file tools canonicalize the target at the operation boundary and preflight
the nearest existing directory before execution. Reads may use every read root.
Writes may use the workdir, app output roots, and persistent user folders. An
active skill resource never becomes writable merely because the skill is active.

Settings -> Security can add and revoke persistent folders. Revocation is
committed before it is published, immediately affects new calls, and terminates
active foreground or background agent processes whose immutable capability
snapshot contains the revoked folder.

## Process Boundary

All agent-driven child processes use `AgentProcessExecutor`, including foreground
and background `bash`, embedded skill shell, ripgrep, and model-driven converters.
The executor owns spawn, environment filtering, process-tree termination,
timeouts, output capture integration, and immutable capability snapshots.

On macOS, the executor runs commands through one `sandbox-exec` adapter. The
profile allows ordinary process and network behavior, allows reads from the
effective read roots, denies writes by default, and then allows only effective
write roots. Exact write denials remain above those roots for Tenon permission,
provider, and secret stores and for governed `.agents/skills` directories. The
adapter probes the platform mechanism and fails closed when it is unavailable.

Child processes do not inherit environment variables whose names identify API
keys, tokens, secrets, passwords, credentials, or private keys. Provider secrets
remain in the main process.

`bash.required_folders` declares folders outside the implicit roots. The runtime
canonicalizes and preflights those folders before process start. If a command
attempts undeclared filesystem access, the process sandbox denies it and the tool
returns a recoverable `folder_access_required` error. The runtime never replays
that process automatically; the model must issue a new call with the folder
declared, which then follows the ordinary capability flow.

There is no model-facing or persisted sandbox bypass.

## Interaction Flows

### Foreground

1. A file tool inherently targets a path, or `bash` declares
   `required_folders`.
2. Hard blocks run first.
3. The capability service computes uncovered canonical folders.
4. The runtime creates one deduplicated folder request before any side effect.
5. **Grant and remember** persists the folders, re-evaluates the original call,
   and executes it once. **Cancel** aborts only that call.
6. Later Runs, conversations, and app launches reuse the persistent capability.

There is no allow-once option, countdown, command exception, or generic risk
approval.

### Unattended Agent Session

An unattended Agent Session never waits on renderer-only state. It records a
durable `needs_input` folder request in the origin conversation and stops before
process execution. The stopped Session remains an error record for audit but does
not enqueue a second generic failure notification; the folder request is the one
user-facing interruption. Granting the folder starts a new continuation Agent
Session after the original one is terminal. The continuation receives explicit
guidance to issue a new tool call and never assumes that the earlier process ran.

Restoring a conversation projects unresolved durable requests back into the same
folder request card. Granting a folder from Settings also runs the durable
recovery scan, so a pending Session does not require the original card to remain
mounted.

## Direct Blocks

The hard floor is structural and intentionally small:

- recognizable host-wide destruction: recursive root/home erase, disk erase,
  direct raw-disk writes, shutdown/reboot, and recursive ownership or permission
  changes at filesystem root;
- writes to Tenon's actual permission, provider, or secret store files through
  typed file tools or shell mutation targets;
- shell writes under governed skill directories, which must use the validated
  `file_write` / `file_edit` gateway;
- unsupported payment or purchase tools without a product-owned payment flow;
- explicit user `Action(...)` or exact `Command(...)` block rules;
- restricted-Run tools that are neither in the read-only base nor explicitly
  preapproved for that Run.

These calls return a structured, non-overridable `permission_denied` result.
They do not ask the user to approve the same action under another label.

Remote-code pipes, persistence writes outside governed skill paths, package
installs, network writes, Git/GitHub publishes, deployments, message sends, and
unknown shell commands are not prompt categories. They execute when their
folder capabilities are available.

The process boundary is delegated-operator containment, not hostile-code
isolation. User files inside a granted folder are intentionally available to the
agent, including files that may contain credentials. Tenon protects its own
provider secrets structurally; it does not claim that shell-string heuristics can
prevent every misuse of user-owned data after the user grants the containing
folder.

## Restricted Runs

`restricted` mode is a capability ceiling for delegated or verification Runs,
not a user confirmation mode:

- a read-only base set remains available;
- non-base tools require a matching run-scoped preapproval rule;
- `node_edit` and every other mutation therefore require explicit preapproval;
- preapproval never bypasses the hard floor, user blocks, or folder preflight.

Skill `allowed-tools` entries and runtime preapproval rules satisfy this ceiling
for the current Run only. They do not persist a global grant and do not grant a
folder.

## Persistent Settings

`agent-tool-permissions.json` under `userData` contains only:

```ts
interface AgentToolPermissionSettings {
  folders: string[];
  blocks: string[];
}
```

Supported block syntax is `Action(action.kind)` or
`Command(exact command form)`. Command matching normalizes whitespace outside
quotes. Broad, empty, or unknown block rules are inert and produce internal
diagnostics. The debug panel can add a block from a concrete tool exchange;
Settings can remove it.

## Events and UI

The durable permission event pair is:

- `tool.permission.checked`, with outcome `allow | folder_required | blocked`;
- `tool.permission.resolved`, with status `approved | denied | aborted`.

The request id joins the pair. Folder requests use transient runtime
`approval_request` / `approval_resolved` notifications only to drive the current
composer card; they do not create a second persisted approval event track.
Unattended requests additionally persist the durable `needs_input` notification
and folder-request projection described above.

Settings -> Security has three sections:

- **Folder Access**: add, list, and revoke persistent folder capabilities;
- **Your Blocks**: list and remove explicit user blocks;
- **System Protections**: explain the non-overridable hard floor.

The composer has one permission card: the canonical folder path plus **Grant and
remember** and **Cancel**. Skill acceptance, `ask_user_question`, OAuth input,
Issue human review, and ordinary validation errors are separate product flows;
they are not permission prompts and cannot authorize a blocked tool call.

## Adjacent System Blocks

Some operations can fail without entering this permission policy:

- `web_fetch` rejects non-public, loopback, link-local, and private-network
  targets to prevent SSRF;
- Electron renderer permissions remain allow-listed and external navigation is
  kept outside the app renderer;
- Issue execution rejects invalid lifecycle, scope, unresolved dependency, and
  unsupported output contracts; `human-review` completion remains a real human
  workflow;
- a missing macOS process sandbox disables agent child processes rather than
  silently running them uncontained.

These are execution invariants or platform failures. They return direct errors
or their own product interaction; none should be converted into a generic
"approve this risky action" prompt.
