# Project Context Runtime

**Shape:** One complete feature. It introduces Project identity, default
workspace references, context refresh, and the provider-context contract used by later
workflow plans.

## Goal

Give every development Turn one explicit, replayable execution context. The
Agent must know which root and worktree it is operating on, which instructions
and profile were used, which checks are declared, and whether those facts are
current or degraded. A durable Project is optional.

## Non-goals

- A universal project detector that chooses commands without evidence.
- Project facts in the stable system prompt.
- A second project-state database beside Thread items and context payloads.
- A model-facing refresh tool before the Host/renderer command is proven
  insufficient.

## Reference implementation

| Reference | Source | Logic to study | Adaptation |
|---|---|---|---|
| Codex CLI | `codex-rs/core/src/agents_md.rs`, `agents_md_manager.rs` | Walk scoped instruction files, cache entries, retain provenance, and emit replacement/removal state | Use typed source entries and explicit clear tombstones, but persist through Tenon context evidence |
| Codex CLI | `codex-rs/core/src/context/world_state/` | Render only changed environment/instruction sections per step | Use generationed project payloads and `ContextProjector`; keep stable prompt cacheable |
| Claude Code | `src/utils/claudemd.ts` (`getMemoryFiles`, `getMemoryFilesForNestedDirectory`) | Ancestor traversal, canonical Git-root handling, reload reasons, non-Git fallback | Keep lexical scope and non-Git support; reject an opaque conversation blob as replay authority |
| Pi | `packages/coding-agent/src/core/resource-loader.ts` (`loadProjectContextFiles`, `reload`) | Simple resource discovery, `/reload`, diagnostics and source precedence | Borrow explicit reload and diagnostics; record immutable hashes and generations |
| Pi | `packages/coding-agent/src/core/system-prompt.ts` (`buildSystemPrompt`) | Project context and Skill descriptions are separate from tool list | Keep project facts out of stable L0/L1 and inject them as evidence |
| Tenon | `src/main/agent/context/AgentStartupContext.ts` | Existing snapshot persistence, bounded collection, degraded inspection | Extend rather than create a second startup-context store |
| Tenon | `src/main/agent/context/evidenceAdmission.ts`, `ContextProjector.ts` | Canonical evidence admission and provider projection | Add `executionContext` as a typed payload kind with the same replay rules |
| Tenon | `src/main/agent/thread/TurnLifecycle.ts`, `ThreadService.ts` | Turn admission and context evidence ordering | Admit the current project generation before the user message |

## Design

### Identity

Resolve and persist:

```text
primaryRootRealpath
primaryWorktreeRealpath (or primaryRootRealpath for non-Git)
vcsKind
gitCommonDir and gitDir when Git is present
branch, HEAD, and dirty-state observations (context snapshot only)
```

The primary root/worktree identity is the Project's identity. Its change is
mutation-blocking. Branch, HEAD, dirty state, and instruction content changes
create a new context generation but do not silently rebind the Thread. An
external root is an explicitly admitted execution context for a Tool Task; it does
not become the project's identity or inject its instructions into every Turn.
The identity comparison must use canonical paths and persisted Git worktree
metadata; it must not infer identity from display text or the current process
CWD alone. Before the first Turn is admitted, the pending primary binding may
be replaced. After a Turn exists, changing the primary project is a new Thread
operation; capturing an external execution context is a Tool Task fact, not a
Thread-owned collection.

### Project catalog ownership

Project is a durable product relationship, so it needs a catalog entry even
though it must not become a second execution ledger. The first implementation
adds a `ProjectCatalogStore` beside `ThreadMetadataStore` in the existing Agent
state SQLite database and transaction boundary. It owns only:

```text
projectId + displayName + stable repository/folder identity
createdAt + updatedAt + archived/pinned presentation state
projectId <-> threadId membership
Workspace records: workspaceId, projectId or rootThreadId, rootRealpath,
  gitDir/commonDir, kind (project/managed/isolated), state, and timestamps
Project.defaultWorkspaceId (initial choice for new Chats)
```

The catalog does not own Turns, Tool Tasks, Goal attempts, Git facts, check
results, or context payloads. Those remain authoritative in the existing
Thread/Turn/Tool Task and context stores. A missing root makes a catalog row
unavailable; it never fabricates current branch, dirty state, or execution
results. For Git Projects, the stable identity is the canonical `gitCommonDir`
and each checkout is a separate Workspace. A non-Git Project has one or more
user-confirmed folder Workspaces. Deleting a Project is rejected while an
Automation in `active` or `paused` state references any of its Workspaces,
because either state can schedule or resume future work. Completed Automation
runs retain their resolved workspace snapshot as historical evidence and do not
block deletion; the UI marks the historical Project as unavailable after
catalog removal. When deletion is allowed, it atomically detaches member
Threads to managed Workspaces, preserves their evidence, and removes catalog
metadata. It never silently redirects an Automation to another directory.

`Thread` does not store a second directory fact. It stores one
`defaultWorkspaceRef`, resolved by the Host as either a managed workspace or a
Project workspace. The effective process CWD is derived from that workspace at
execution time. A Tool Task stores its own immutable execution context when it
uses an explicitly named external directory; it never mutates the Thread's
default workspace.

### Profile

A profile is declarative data:

```text
profileId + source + contentHash
instruction candidates and scope rules
runtime/package-manager hints
checks: command, required/optional, scope
build/lint/typecheck commands
VCS/hosting capabilities
worktree/isolation and review rules
```

Filename detection (`package.json`, `pyproject.toml`, `go.mod`, `Makefile`, CI
files) produces candidates only. A required check becomes active only after
explicit user selection or a trusted project instruction source. A profile
change is a new profile hash and affects later Turns only.

### Folder model

Every Chat receives an execution workspace, but that workspace is not
necessarily a Project. A no-project Chat uses a Tenon-managed workspace for
scratch work; only a user-selected external root (or a created/cloned root)
becomes a durable Project. The user-facing concept for development is a
**current workspace**. The process CWD is derived from that workspace, while
Project context and per-task execution context remain separate:

```text
Project           -> durable identity, instructions, profile, checks
Thread workspace  -> `defaultWorkspaceRef` to managed or Project workspace
Tool Task         -> actual cwd, optional external root, and captured context
```

`defaultWorkspaceRef` is the only workspace selection stored on a Thread:

```text
{ workspaceId, kind: "managed", rootThreadId }
| { workspaceId, kind: "project", projectId }
| { workspaceId, kind: "isolated", parentWorkspaceId }
```

The Host resolves the ref to an effective CWD for each Tool Task. An external
directory named during a request is recorded only in that Tool Task's
`executionContext`; it is never added to the Thread as another default
workspace.
The `rootThreadId` is the creating root Thread's ID, not the current child or
fork ID; descendants copy it and share the managed workspace until the root
lineage is deleted and cleanup is complete.

### Project identity and workspace rebind

Project identity is stable; a concrete Workspace owns the checkout path. A
confirmed rebind updates one Workspace record only when Git metadata proves
continuity (or the user explicitly confirms a non-Git move). Threads referencing
other Workspaces are unaffected. The Host publishes a new context generation
for Threads using the rebound Workspace, preserves prior evidence under the old
identity, and blocks mutation until those Threads observe the new generation.
A path that cannot be proven continuous creates a new Project and Workspace;
no Thread is silently migrated to an unrelated root.

Selecting a different checkout is a per-Thread workspace choice recorded in its
`defaultWorkspaceRef`. A Project's `defaultWorkspaceId` is only the initial
selection for newly opened Chats. It never rewrites existing Chat references.

There are two Host execution modes behind that simple concept:

| User action | User-facing workspace | Host binding |
|---|---|---|
| Create an ordinary Thread without opening a project | A Tenon-managed workspace | A disposable or retained `<userData>/agent/workspaces/<thread-id>` directory |
| Open a project | The selected project directory (or its selected Git worktree) | `defaultWorkspaceRef = { workspaceId, kind: "project", projectId }` |
| Run an isolated child Agent | The parent project's working folder from the user's perspective | A Host-managed worktree overlay with its own identity and cleanup record |
| Work on another explicitly named folder | The primary project remains visible | Capture an external execution context on each affected Tool Task |

If no project folder is selected, the Thread references a managed workspace
derived from its identity. When a project is opened, the Thread references the
Project workspace; the Project remains the only owner of the external root. A
Tool Task may use an explicitly named external directory without changing that
workspace. The UI should not ask the user to configure both a Project directory
and a separate workspace directory unless an isolation action explicitly creates
a child worktree.

### No-project external work

A projectless Chat can still complete source work in an explicitly named
directory. The Host resolves that directory as an execution context for the
affected Tool Task, validates its canonical identity, and records it on the
Tool Task. This
reuses project inspection, profile detection, instruction discovery, checks,
verification, Git, sandbox, and recovery logic without creating a Project or
changing the Chat's default managed workspace.

The external context is scoped to the active Tool Task or Goal attempt. The Host
may collect the target repository's bounded instructions and profile for that context
payload, but it does not make those instructions global to the Chat or silently
turn the external directory into a primary Project. A later unrelated task must name or
select its directory again. Repeated work can be promoted to a Project only after
the user expresses durable intent and accepts the binding card.

The managed workspace is retained for the lifetime of the Thread, subject to
ordinary scratch quotas and cleanup after Thread deletion. It is not silently
reused as a Project root and is not deleted merely because an external directory
was used.

The minimum execution record is intentionally split into two stable values:

```text
ExecutionWorkspaceIdentity = {
  kind: "project" | "managed-workspace" | "external-root",
  projectId?,
  targetId?,
  rootRealpath,
  worktreeRealpath,
  worktreeIdentity
}

ContextSnapshotRef = {
  contextGeneration,
  instructionSources,
  profileRef,
  checks,
  degradation
}

executionContextRef = {
  workspace: ExecutionWorkspaceIdentity,
  snapshot: ContextSnapshotRef
}
```

`ExecutionWorkspaceIdentity` is an internal Tool Task value and changes only when
the actual root/worktree changes;
`ContextSnapshotRef` changes when mutable instructions, profile, VCS facts, or
checks change. This prevents execution identity and context refresh from being
coupled. Both values are Host-owned and immutable once the Tool Task is
admitted. A managed workspace uses `kind: "managed-workspace"`; an explicitly
named external directory uses `kind: "external-root"`. A Turn has one
default context; multiple external directories are allowed only through separate
Tool Tasks, each carrying its own ref. An external execution context expires with its
owning Tool Task or Goal attempt and is retained in the task receipt for replay.
It never changes Thread membership or the default workspace of later Turns.

For an external execution context, instructions and profile are marked
`task-scoped` and apply only to the affected Tool Task. Primary Project
instructions are not silently merged into an external task, and external
instructions are never
promoted to Chat-wide guidance. If both are relevant, the provider payload names
the active source and records the other as inactive evidence.

### Execution context admission

An admitted external execution context is an audit and context record, not a
permission boundary. The Host records its canonical root and fixed command CWD;
Full Access still permits explicit absolute host paths. A future isolation policy
may add canonical containment, but it must be a separate capability decision and
cannot be inferred from this context record.

The Host still supplies the recorded CWD to the process; a model cannot change
the Thread's default workspace by passing a `cwd` field. File and Bash tools
retain the existing Full Access semantics for absolute paths. Every Tool Task
receipt records the explicit execution context so review, verification, and
recovery cannot mistake one directory for another.

The user-visible task record makes the scope explicit even though the default
Composer remains projectless:

```text
Working directory: ~/Coding/project-b
Operation: edit files and run tests
Project binding: none
```

### User-facing setup

Project setup is progressive disclosure, not a configuration wizard. The user
chooses a directory from the "Open project" action; Tenon immediately creates
an explicit Project workspace Thread and focuses the composer. Root/worktree
resolution, instruction discovery, and profile detection happen in the
background while the user can start an inspection request.

When a primary Project is bound, the Composer shows a compact context control
rather than interrupting the first request:

```text
Project: Tenon  ·  ~/Coding/tenon  ·  main  ·  Ready
```

Opening that control reveals root/worktree, branch, dirty state, instruction
sources, detected profile, checks, and execution/isolation status. A dirty tree
is a visible fact, not a setup error. Detection is advisory: an uncertain
manifest never silently enables a required check or changes a command.

The Composer control is the primary per-Turn scope selector, following the
desktop coding clients' two-row pattern. The row above the text input carries
project and execution scope; the row below carries only controls that are
selectable or currently relevant.
The scope menu contains
the current primary project and explicit actions such as `Use another folder
once`, `New project`, and `New chat in project`. A different primary
project never silently replaces the current Chat. When a task uses an
external execution context, the task card shows its working directory;
the primary project label remains unchanged.

When no Project is bound, the default Composer has no project status row. The
managed workspace remains an internal execution detail. A `+` button opens the
add menu for files, an existing project folder, a folder to use once, project
creation, and Git clone. If a project becomes unavailable or needs rebinding,
the status row reappears because the user has an action to take.

### Binding confirmation

Binding is a Host-owned mutation, but the interaction depends on who initiated
it:

| State | Initiator | Interaction |
|---|---|---|
| Unstarted Chat (zero Turns) | User selects a folder from `+` | The folder picker is the confirmation; bind after it returns a validated root |
| Unstarted Chat (zero Turns) | Agent proposes a project with explicit durable-project intent | Show a confirmation card before binding |
| Projectless Chat with conversation but no file/process work | Agent or user requests a project with explicit durable-project intent | Show the same card; bind at the next Turn and keep prior Turns projectless |
| Chat with an admitted project or execution evidence | User or Agent requests another primary project | Do not mutate in place; offer `Open in new chat` |

An ordinary request to fix, inspect, or update a named project is a task request,
not a binding request. The Agent should use the named directory as an explicit
execution context and keep the Chat projectless. Binding is considered only when
the user clearly asks for a durable project relationship (for example, "add
this project", "start a project here", or "use this project for future chats")
and the Agent has a canonical root. When intent is uncertain, the Agent handles
the task without binding and does not ask a project question.

User text is intent, not a committed binding. If the Agent does reach the
high-confidence durable-project threshold and turns that intent into a binding
request, the Host still shows the confirmation card. Only a user-controlled
folder/project picker commits a binding without a second confirmation.

The Agent proposal card contains the concrete root, detected Git/worktree
identity, branch, access scope, and the effect on the Chat:

```text
Use this project for the current Chat?
~/Coding/tenon
Git repository · main
The next Turn can read and edit this folder.

[Use project]  [Open in new chat]  [Cancel]
```

`Use project` commits the pending primary binding through Host and records the
accepted identity before the next Turn. `Open in new chat` preserves the current
Chat and creates a new project Chat. A network clone, directory creation, or
permission expansion has its own approval card; accepting project binding alone
does not implicitly approve those effects.

This card is a Host-owned context action, not a model-generated approval
question. The existing `request_user_input` tool remains available only when
the target is missing or ambiguous (for example, several candidate folders); it
must not be used to approve a known binding, grant access, or stand in for a
Host receipt. If Agent-initiated binding needs a model-facing request channel,
the implementation must use the smallest typed intent path available in the
runtime, adding a dedicated request only if the existing protocol cannot carry
that intent without relying on transcript text.

The compact scope row may show `Project · Host · Branch`:

```text
Tenon  ·  Local  ·  main
```

Tenon currently has only one capability mode, `Full access`, so it is not shown
in the default Composer row. The lower row remains compact:

```text
[+]  ·  Claude Sonnet  ·  Send
```

If a future capability mode becomes selectable, it may occupy the lower row.
Until then, capability mode, sandbox enforcement, and other execution facts are
shown only in an approval card, a failure state, or the expanded context
popover; they must not be inferred from the project name or branch label.

### Narrow Composer layout

Tenon's Agent pane is narrower than the reference clients, so the context row
must be container-responsive and single-line. It uses this priority order:

```text
blocking state -> primary project -> current workspace -> branch -> host
```

At the widest pane, the row may show:

```text
Project: Tenon  ·  Local  ·  main  ·  Modified
```

As the pane narrows, it collapses without wrapping:

```text
[Folder] Tenon  [Modified]
```

At the minimum supported width, the project control keeps only the folder icon,
an ellipsized project name, and a blocking-state indicator. Path, branch, host,
dirty details, sandbox enforcement, and external-directory identity move into the
anchored context popover. The control uses a container query based on the Agent
pane width rather than the window viewport, and its height remains fixed so the
composer never jumps when labels collapse.

An external execution context is shown only in the active Tool Task card; it is
not a persistent Composer control. The model is an independently collapsible
control in the lower row.
When text labels no longer fit, it uses familiar icons with
accessible labels and tooltips; no control may wrap into the send button or
change neighboring layout.

The default profile is resolved from the project definition at
`<cwd>/.tenon/agent.json` when valid, then from explicit user settings, and
finally from a generic profile. The generic profile supports file/Bash
workflows. Check candidates are suggested when the user asks to run checks;
they do not have to be selected during project opening. The user can later mark
a check as required from the Composer context control.

The confirmed binding belongs to the Thread. There is no hidden global
"current project" that can redirect an existing conversation. To work on a
different project, the user opens it into a new Thread. An explicit rebind
action is reserved for recovery when a project directory moved or a worktree
was recreated. Rebind is accepted only when the Host can prove continuity from
Git worktree metadata (or an explicit non-Git user confirmation); it records the
old and new identity, preserves old evidence, and blocks mutation until the
new context is confirmed. It never turns an existing conversation into a
conversation about an unrelated project.

Refresh is available from the same Composer context control and updates the next Turn's
generation without rewriting prior Turns. If the root/worktree identity no
longer matches, Tenon continues to allow inspection of the old evidence but
blocks new mutation until the user repairs the binding or opens a new Thread.
Capability or isolation confirmation appears only when the requested action
crosses that boundary, rather than as a generic project setup step.

Settings are split by ownership:

| Surface | Owns | Does not own |
|---|---|---|
| Global Settings | provider, model, capability ceiling, default isolation preference | a project's root, commands, or branch |
| Project context | root/worktree, profile, instruction sources, checks, hosting candidates | global permission ceilings or conversation history |
| Development Thread | selected context generation, Goals, Tool Tasks, and evidence | another Thread's project binding |
| Skill | repeatable project procedure and expected evidence | permission, identity, or authoritative state |

The model may inspect admitted project evidence and request a refresh through
the normal workflow, but project selection and rebinding remain developer
actions. An accidental path mention in a prompt cannot become a project switch.

### Chat and project relationship

Chat remains the primary interaction entry point. A Project is a durable
optional container for chats, instructions, and a primary root; an execution
workspace is an internal runtime context for a particular task.

```text
New chat
  -> no project: ordinary conversation in a managed workspace
  -> attach project: development chat bound to the selected primary folder
  -> another folder: same chat, one-off external execution context
```

The existing global `New chat` flow therefore remains valid. A user who only
wants to ask questions does nothing differently: the new Chat has a managed
workspace but no Project. A user who wants source work can choose `Attach
project` before the first message or in the middle of a projectless
conversation. The attachment takes effect at the next Turn, so earlier turns
remain explicitly projectless. Tenon resolves the context in the background
and shows the compact project status when ready.

The project navigation has a separate `New chat in project` action. It creates
a new Chat that references the selected Project's primary root and inherits a
fresh context generation, while keeping its own Goals, Tool Tasks, and
evidence. It does not create an empty Project and does not create a second
project identity. A global `New chat` from outside that project remains
projectless. The labels must stay explicit even when the UI offers a shortcut
from the current project page.

The new Chat initially uses the same primary root and selected worktree as the
Project. If another active Chat is mutating that root, or the user asks for
parallel changes, Host offers an isolated child worktree and records that
execution identity separately. Isolation is an execution choice; it does not
duplicate the Project container.

If a projectless chat has already performed file or process work in its managed
workspace, attaching an external primary project starts a linked `New project
chat` instead of replacing the primary root. If a chat is already bound to a
project, selecting a different primary project never rewrites that chat; the UI
offers `New project chat`, and the original chat remains readable and bound to
its original context. An explicitly named external directory is different: it
can be recorded for one Tool Task while the primary project remains unchanged.
This keeps Claude Code-style cross-directory work possible without mixing
project identity or silently importing another project's instructions.

The same chat entry point also supports explicit project creation and cloning:

```text
Create project -> choose parent + name -> create directory -> open project chat
Clone repository -> enter URL + destination -> run Git clone -> open project chat
```

Both are user-started operations. Directory creation and cloning run through the
existing Host/Tool Task path, return durable receipts, and then attach the
resulting folder as the new chat's project context. They do not create a second
Git or project-state ledger.

The complete user-facing decision table is:

| User situation | Default action | Durable effect |
|---|---|---|
| New chat, no source work | Chat in managed workspace | No Project |
| Names a folder for a one-off fix | Capture external execution context and run the task | Tool Task context only |
| Chooses `+ -> Open project` | Attach selected folder | Project + Chat membership |
| Says "use this project for future chats" | Agent calls `project_bind_request`; user accepts card | Project + Chat membership |
| Chooses `New chat in project` | Create a new Chat under that Project | New Thread, same Project identity |
| Chooses global `New chat` | Create an unrelated projectless Chat | No inherited Project |
| Chooses `+ -> Clone` or `Create` | Run user-started Tool Task, then open result | New Project Chat |
| Names a second folder inside a Project Chat | Capture an external execution context | Primary Project unchanged |
| Requests another primary Project mid-chat | Offer `Open in new chat` | Original Chat unchanged |
| Same worktree is already mutating | Return `worktree_busy` | User chooses isolated worktree or waits |

### Agent-initiated project setup

The Agent may initiate project setup only when the user expresses durable
project intent in chat, but it does not directly mutate the Thread's binding.
For a one-off request to fix or inspect a named folder, it captures an explicit
execution context and keeps the Chat projectless. For durable intent, it invokes the
single model-facing `project_bind_request` capability with a canonical candidate
path and a reason. The capability creates only a pending Host action; it cannot
bind, create, clone, grant access, or run a command. The Host canonicalizes the
path, collects identity facts, and shows the binding confirmation before
committing the Project relationship. This one typed request is necessary because
parsing ordinary model text would make a project switch depend on prompt
wording. No separate model tool is added for a one-off target, refresh, clone,
or create: those remain explicit UI actions or existing Bash/Tool Task
operations with their existing receipts.

The same rule applies to an existing folder named during a task. The Agent may
request an external execution context with a path and intended operation (for
example, "update the sibling repository"). The Host validates and admits that
context, records its identity, and scopes it to the requested Tool Task. It does
not change the primary project or load the external directory's instructions as
global context. Repeated work can be promoted to a new project chat.

For example:

```text
User: Clone github.com/acme/widget into ~/Coding/widget and start working on it.
Agent: target + branch + network access -> user approval
Host: Tool Task runs git clone -> durable receipt
Host: opens a new project chat bound to the cloned folder
```

The Agent may inspect a candidate location and report that it is available. A
path mentioned in model text, command output, or a Skill cannot itself change
the current project. An already project-bound chat cannot be redirected by an
Agent request; setup creates a new project chat. A projectless chat may attach
the first project at the next Turn when it has not performed work in its
managed workspace. This gives the Agent a convenient setup workflow while
keeping project identity a Host-owned mutation.

The `project_bind_request` contract is intentionally narrow:

```text
input:  { path: string, reason: string }
output: {
  requestId,
  state: "awaiting-user" | "rejected" | "expired" | "superseded",
  candidateIdentity: { rootRealpath, worktreeRealpath, vcsKind, branch }
}
```

The input path is a candidate, not an authorization or a command. The Host
rejects non-local, ambiguous, or inaccessible candidates before showing the
card. `awaiting-user` ends the current model Turn; acceptance is a renderer
action that atomically writes the Project catalog row, Chat membership, and
accepted identity, then starts the next Turn with the new context evidence.
There is no tool result state that means "bound" before that transaction.

The same project may have many chats. Project-level declarations such as
`.tenon/agent.json` are read by each newly attached chat, while each chat keeps
its own context generation, Goals, Tool Tasks, and evidence. The project status
control is the only place a user needs to inspect or refresh project facts;
ordinary chat does not expose profile configuration unless the user opens it.

### Payload and lifecycle

The payload is persisted before provider admission:

```text
bind -> collect -> persist -> admit -> project -> replay/compact
```

`collect` reads instruction files, profile metadata, and bounded VCS facts. Each
source records path, scope, hash, provenance, and bounded text. A failed
collection produces degraded reasons; it never fabricates a complete snapshot.

`admit` performs an identity check on every root Turn. It reuses unchanged
instruction/profile hashes and captures a new observation when mutable facts
changed. Explicit refresh always appends a new generation.

`project` uses `ContextProjector` to emit additions, replacements, and clears in
the existing system-reminder context envelope. The payload reference and
generation are included in Turn diagnostics and trajectory evidence.

### Automation and lineage

Automation snapshots store the same `defaultWorkspaceRef` shape and an
immutable resolved workspace identity at dispatch, including a self-contained
copy on completed run history. They do not store a sticky
`cwd`. A standalone occurrence creates a root Thread with a managed or Project
workspace reference; an existing-Thread occurrence is admitted only when its
resolved Workspace matches that Thread's reference. A child or fork inherits
the root Thread's managed `rootThreadId` or the parent's Project Workspace
reference, unless an explicit isolated Workspace is created.

When a Project is deleted, `active` and `paused` Automation bindings block the
deletion until the user removes them or the Project is restored. Completed run
snapshots retain their resolved workspace identity for replay but cannot be
resumed. Member Chats are detached to their managed workspace in the same
catalog transaction, and their prior Project evidence remains readable.

### Protocol work

Add the smallest schema to `src/core/agent/protocol.ts` and its matching codec in
`src/core/agent/codec.ts`. The schema must reject unknown fields, bound text and
source counts, and distinguish `unknown`, `degraded`, and `ready` collection
states. Add a context dependency path in `src/main/agent/context/contextDependencies.ts`.

Because Tenon is pre-release, this feature removes the persisted `Thread.cwd`
field rather than adding a compatibility alias. Thread creation persists
`defaultWorkspaceRef`; runtime adapters derive an effective CWD before invoking
file or process tools. The codec, metadata schema, fork/delegation paths,
Automation dispatch/snapshots, and diagnostics must reject the retired field and
userData is reset when this format lands. No reader may reconstruct a workspace
from a stale cwd value.

The protocol addition is limited to the `executionContextRef`, context payload,
and `project_bind_request` request/result envelope. The request is never accepted
as evidence of a completed bind: the Host publishes a pending card, waits for
the renderer's user action, then persists the accepted catalog and Thread
membership in one transaction. A rejected, expired, or superseded request remains
a durable non-success result and cannot be retried as an implicit bind.

The renderer/IPC refresh action should call the Host context service. It is a
developer action, not a model tool. The model can inspect the admitted evidence
and may run additional read commands, but those observations do not replace the
Host generation.

### Shared worktree concurrency

Read-only Tool Tasks may run concurrently. The Tool Task runtime extends the
existing `tool_task_leases` table with a canonical `worktree_key` and creates a
partial unique index for active mutation claims. In the same SQLite transaction
that admits or promotes a lease, it inserts the worktree claim; a uniqueness
conflict returns `worktree_busy` with the owning task. Worktree claims are never
queued. Global or pool scheduling may still queue tasks that do not contend for
that worktree. On completion, stop, or restart reconciliation, the claim is
released only after the task receipt is terminal. The runtime rechecks HEAD,
index, and relevant path state at mutation admission; the claim prevents
concurrent writers but does not hide out-of-band edits.

## Requirements

- **FR-1:** A Thread stores one `defaultWorkspaceRef`; Project or managed
  workspace identity is resolved from that reference.
- **FR-2:** A Turn records the exact context payload reference it used.
- **FR-3:** Refresh preserves prior evidence and projects replacement/clear
  semantics.
- **FR-4:** Every Tool Task using an external directory records its immutable
  execution context and cannot change the Chat's default workspace.
- **FR-5:** A projectless Chat can execute a task against an explicitly named
  directory without creating a Project or changing its managed workspace.
- **FR-6:** Project catalog metadata and Chat membership have one owner in the
  existing Agent state database and never duplicate execution or Git facts.
- **FR-7:** Agent-initiated durable binding uses a typed pending request and
  explicit user confirmation; ordinary model text cannot bind a Project.
- **FR-8:** Project Workspaces have durable identities and per-Thread selection;
  Workspace rebind is continuity-checked and does not redirect other Workspaces.
- **FR-9:** Automation snapshots, forks, and child Threads use workspace
  references and preserve root-lineage inheritance.
- **FR-10:** Project deletion is atomic: active or paused Automation bindings
  block it; completed run history remains self-contained, and otherwise member
  Threads move to managed workspaces without losing evidence.

## Acceptance Criteria

- **AC-1:** A Thread stores one `defaultWorkspaceRef`; its effective CWD is
  derived by the Host and cannot silently move.
- **AC-2:** A Turn records the exact context generation and payload reference it used.
- **AC-3:** Refresh creates a new immutable generation and preserves earlier evidence.
- **AC-4:** Instruction additions, replacements, and removals project correctly.
- **AC-5:** Profile detection is advisory; required checks are explicit or trusted-source
  selected.
- **AC-6:** A failed refresh is visibly degraded or blocked, never a fabricated success.
- **AC-7:** Stable-prompt fingerprints do not change when project facts or Skills change.
- **AC-8:** A Tenon fixture and a second project with a different toolchain replay the same
  context lifecycle.
- **AC-9:** A Tool Task can operate on an explicitly named external root while
  the Project, instructions, and subsequent default workspace remain unchanged.
- **AC-10:** A projectless Chat can inspect, edit, and verify a second project
  using task-scoped context and receipts while its Project binding remains
  absent.
- **AC-11:** The Host derives each Tool Task's effective CWD from the Thread's
  `defaultWorkspaceRef` or the task's explicit external execution context.
- **AC-12:** A rejected or expired `project_bind_request` cannot alter Project
  catalog, Thread membership, or `defaultWorkspaceRef`; an accepted request
  changes all three only through one Host transaction.
- **AC-13:** Concurrent Chats cannot mutate the same worktree simultaneously:
  the second mutation receives `worktree_busy` and an isolated-worktree action;
  it is never queued behind the worktree claim, and a dirty/changed identity
  produces a conflict result.
- **AC-14:** A Project with multiple Workspaces resolves every Chat's
  `defaultWorkspaceRef` to one validated `workspaceId`; missing or mismatched
  Workspaces produce a visible non-success state.
- **AC-15:** A continuity-proven Workspace rebind updates only Threads using
  that Workspace and emits new context generations; an unrelated path creates a
  new Project and Workspace instead.
- **AC-16:** Automation dispatch, fork, and child creation preserve the root
  managed workspace identity or the selected Project Workspace without reading a
  retired `cwd` field.
- **AC-17:** Project deletion is rejected while active or paused Automation
  bindings exist; completed run snapshots remain replayable without dispatch;
  otherwise all member Threads atomically reference managed workspaces and
  remain readable after restart.

## Tests and evidence

Add core tests for canonical identity, Project Workspace selection and rebind,
nested scope, hash reuse, generation increment, replacement/removal, malformed
payload rejection, Automation snapshot migration, root-lineage inheritance,
Project deletion, completed-run replay, and restart replay.
Add renderer tests for refresh, provenance, degraded state, and stable-prompt
fingerprints. Capture one trajectory fixture showing the payload reference used
by a Turn.

## Open questions

- `ProjectContextService` in `src/main/agent/context/` owns profile detection
  after the Settings boundary; the first profile limits instruction sources to
  32 entries and 128 KiB of total projected text.
- Same-worktree mutation uses a fail-fast durable lease. A second mutating task
  receives `worktree_busy` with the owning task and an `Open isolated worktree`
  action; it is never queued against a potentially stale context.
