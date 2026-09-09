# Projects and Conversation Work Folders

## Goal

Let a person start work in a folder, keep that choice when returning to a
conversation, and identify it in history. Ordinary conversation and occasional
cross-directory work remain straightforward. The primary user alternates between
general assistance and work in local repositories, including several worktrees
and related files distributed across directories.

**OBJ-1:** Choosing a work folder is an explicit, durable conversation setting,
available through both the UI and an Agent acting on the user's instruction.
**OBJ-2:** History identifies that setting without confusing a Project name with
an execution directory. **OBJ-3:** A temporary operation elsewhere does not
change where later work defaults.

Minimum acceptable outcome: choose, inspect, change, clear, restore, and display
the work folder, with truthful invalid-directory and concurrent-change handling.
A label-only change or a prompt promising to remember a folder does not meet it.

## Non-goals

A new Workspace entity; Project-based permissions; automatic binding on file
visits; implicit configuration/profile changes; new Git/worktree management;
reordering the entire history surface; or redesigning scheduled work. The
archived [Agent Project Capability Parity](archive/agent-project-cli-parity.md)
alternative records the narrower restoration approach. All requirements for this
broader feature are defined here; archived alternatives are provenance only.

## Design

### Decision, constraints, and alternatives

**Shape: (a) ONE complete feature in one PR.** Project source folders and primary
selection, conversation settings, UI and Agent access, runtime resolution,
history labels, persistence, and failure handling ship together. Shared interface
coordination precedes consumers under the repository's existing ownership rules.

**DEC-1:** The selected target uses a conversation-owned default work folder,
optional Projects that retain related chats and source folders, and task-owned
actual execution addresses. A default is a convenience; the immutable admitted
task address remains the record
of where an operation actually executes.

| Option | Benefit | Cost / decision |
| --- | --- | --- |
| Per-call cwd only, as today | Simple task ownership and flexible cross-directory work | No durable conversation location; insufficient for OBJ-1 |
| Project controls all member conversations' cwd | One setup point | Project edits affect unrelated work; distinct worktrees need another mapping; reject |
| Conversation folder only, remove Projects | Small clean-slate surface | Loses existing organization and Agent management capabilities; reject for this change |
| Project sources and primary folder initialize an independent conversation folder | Reusable project context, direct folder workflow, independent worktrees | Requires clear initialization and change semantics; selected |

**CON-1, hard:** Preserve task execution evidence, process ownership, capability
admission, and repository process/security boundaries. A folder choice grants no
permission. **CON-2, user constraint:** Removing model tools must preserve their
useful operations through another executable interface. **CON-3, revisable legacy
choice:** The blanket prohibition on a Thread default cwd is not required for
immutable task evidence. **TRD-1:** The UI must clearly separate a saved default
from an operation's actual directory; copying a Project folder on creation is
deliberate initialization, not a live dependency.

### Product concepts and main flow

Daily work exposes **Project** and **Conversation**. A Project brings related
conversations and zero or more source folders together. When folders exist,
exactly one is primary. The primary folder is the initial location for new chats;
each conversation owns its accepted default work folder thereafter. A work folder
is a setting, not another navigation container or Workspace entity. Direct
conversation folder selection remains available without creating a Project.

The composer has one compact Project/location entry. It shows the selected Project
and, when needed to avoid ambiguity, the conversation's different work folder.
Its popover offers Project search/selection, creation, no Project, and the current
work-folder setting. Full paths are inspectable. Related folder lists belong in
Project editing/context details, not an always-expanded composer configuration
form. An unbound chat can show a quiet Choose project entry without a missing-state
warning. The composer uses the same saved-folder versus application-default
distinction as history in FR-4.

**FR-1:** A new conversation can remain unbound. Its folder control offers the
native directory picker and shows the application default in location details
when no work folder is saved. Selecting an existing directory validates and saves
its canonical path, then displays its basename with the full path available. The
person can change or clear it through the same control. Clearing it selects the
application default under BR-1, even while Project membership remains; it does
not adopt the Project primary folder. Ordinary chat remains usable if a chosen
folder later disappears; the control shows the unavailable
path and offers selection of a replacement or clearing the setting.

**FR-2:** An explicit request such as "Use this folder for this conversation"
can perform the same persisted operation through Agent access. A request merely
to inspect another directory uses a task override. The accepted setting is
visible to the Agent and UI; context compaction or a restart cannot substitute a
remembered textual promise for the saved value. The Agent can inspect the current
value and must report conflict or failure instead of claiming a successful change.
Explicit authorized setting changes require no additional product confirmation.
No new dedicated model tool is introduced.

**FR-3:** "New chat in Project" initializes the work folder from that
Project's primary folder. The new conversation visibly owns a copy, which can be
changed independently. A Project without a directory creates an unbound chat.
For an existing conversation, a Project change preserves its current work folder
by default. The picker previews the resulting Project and folder; choosing Use
project primary folder explicitly applies both through the shared Host operation.
The Agent can request the same combined operation when the user's instruction
includes working in the new Project. Organizational intent alone changes only
membership and available Project references. Project rename, primary changes,
unbinding, or deletion never redirects existing chats or accepted operations.
Forks copy the parent conversation setting by value. Descendant Project membership
can follow the existing lineage rule without propagating a root folder change
into a descendant's independently owned directory or isolation context.

**FR-4:** Each history row identifies its Project and work location alongside
the existing title, activity, and time. With a saved work folder, use Project name
as the secondary label and append the folder basename when it differs from the
Project primary folder. A folder-only conversation shows that folder. A tooltip
and accessible label expose the complete accepted path; colliding basenames receive parent-path
context. An unavailable selected folder retains its identity and an unavailable
indication. A chat with neither selection needs no missing-Project warning.
Preserve existing ordering, grouping, and management entry points. Preserve
system-source and startup-availability information. Unknown Project membership
does not become a false No Project claim, and the last tool cwd never replaces
the saved conversation location in a row.

A Project-associated conversation with no saved work folder displays
`<Project name> · Application default` in both composer and history. This includes
clearing a folder while retaining membership, assigning a Project without adopting
its primary folder, and creating a chat in a Project with no primary folder.
The label remains explicit even if the current application default happens to
equal the Project primary path: the saved setting is still different. Location
details expose the current Host-resolved application-default path. If that path
cannot be resolved, show its location as unavailable; do not infer the Project
primary or a previously used task cwd. This presentation does not save the
application-default path as a conversation setting.

**FR-5:** Project creation/editing presents a name and Source folders with native
Add folder, Remove, and Make primary controls. The first folder supplies an
editable suggested name and becomes primary. Canonical duplicate paths are
rejected. A nonempty list always has one explicit primary. Removing the primary
requires choosing its replacement in that edit, or removing all folders; no
arbitrary reorder silently changes it. An empty list is supported and labelled
as a Project for organizing conversations, with folders addable later.

The selected Project's folder paths are discoverable context references for its
conversations, including secondary folders. They are not copied file contents,
an instruction to scan every folder, or a new permission boundary. Project
updates become visible at the next context publication boundary with their
revision; prior task evidence remains unchanged. Missing secondary folders are
shown as unavailable and block only operations that require them. Removing a
folder removes the Project reference, not files or previously authorized access.

**FR-6:** Restore bounded Agent inspection, creation, editing, membership changes,
unbinding, and deletion through packaged CLI plus built-in Skill. Extend the same
surface for folder-list/primary management and the conversation setting. UI and
Agent access use the same Host owners, revision checks, availability, and outcome
notifications. Preserve the pre-#660 caller/target scope, cancellation and native
confirmation for Project proposals, descendant membership rules, Automation
dependency handling, and preservation of chats/files/tasks on Project deletion.
No direct store edits or replacement dedicated model tools are introduced.
Creating then selecting a Project reports partial results truthfully; an uncertain
response never causes blind duplicate creation. The combined membership/folder
update in FR-3 either commits both or reports no committed selection change.

Invocation authority must come from the Host's trusted source Thread/Turn/Item
context, bound to the exact request and checked against the current capability;
an ID or ordinary CLI argument cannot grant authority. Preserve bounded paginated
inspection and revision-based updates. Project proposals show canonical paths,
names, and affected conversation, then revalidate revision/directory identity
after confirmation. Cancellation before commit must prevent persistence; a lost
reply after commit must be distinguishable from rejection before any retry.
CLI transport must be available without enabling the delegation experiment and
must not open private databases. Successful changes invalidate the existing UI
catalog/current-context views without discarding selection or unsent input.

### Execution and change rules

**BR-1:** Resolve each operation from its explicit cwd override, otherwise the
saved conversation folder, otherwise the documented application default for an
unbound conversation. Relative overrides resolve against the selected base.
Validate and capture the resulting address before admission/spawn under the
existing task contract. A missing explicitly selected folder does not silently
fall back. A valid explicit override can still address another directory.

**BR-2:** Directory-setting changes and task admissions have a defined Host order.
Each admitted task captures the setting revision it used and its actual address.
An update affects later admissions only, including when the Agent updates its own
active conversation. It cannot redirect admitted, queued-after-admission, running,
or background work. Stale concurrent UI/Agent edits return a conflict rather than
overwrite the newer setting. Publish the accepted setting before the next model
continuation so subsequent unqualified calls can use it intentionally.

**BR-3:** Shell `cd`, reading an absolute path, repository discovery, and completing
a task in another directory never update the saved folder. Repository instructions
follow actual admitted paths. Folder changes do not select a configuration source,
model, persona, Skill catalog, or access mode. Existing explicit configuration
selection remains with its current owner.

**BR-4:** Delegated execution retains its admitted worktree/isolation ownership;
the root setting cannot rebind it. A future scheduled-task implementation may
offer the current folder as an explicit initial choice when saving an assignment,
but must persist its own work-location selection. Later execution must not read
the originating chat's mutable default. Existing Automation behavior is outside
this feature and must not change as an incidental effect.

### Evidence and implementation suggestions

**EVD-1:** The user supplied Codex history labels and reported that an Agent could
use a directory but could not durably associate the conversation through the
remaining Project interface. **EVD-2:** The workbench design in #639 and runtime
#646 removed Thread cwd while introducing task-owned execution context; #651
shipped Project Agent operations and #660 removed their Agent entry points.
These are different product capabilities, not interchangeable implementations.

**EVD-3:** The user's additional screenshots show name plus multiple Source
folders, one Primary badge, and a composer Project selector with search, New
project, and Don't work in a project. Codex's official
[Projects and chats](https://learn.chatgpt.com/docs/projects#use-local-projects-for-folders-and-codebases)
confirms zero or more local folders, primary initialization for new chats, and
secondary-folder access. Its
[App Server](https://learn.chatgpt.com/docs/app-server) also documents session cwd
and per-turn overrides. These support the distinction between a reusable Project
and a conversation location; the screenshots do not prove how changing an
existing chat's Project alters cwd, so FR-3 is a Tenon recommendation.
**ASM-1:** A single compact composer entry can explain normal Project selection
and exceptional folder overrides. Validate with ordinary chat, a folder-less
Project, a multi-folder Project, two worktrees, and a cross-directory inspection.

Implementation suggestions: use the existing persistent Thread metadata owner
for one revisioned folder setting; extend Host admission and the current-context
projection, rather than adding another store of execution authority. Agent access
can use packaged Project/conversation commands plus a built-in Skill through
the existing invocation-bound Host transport. UI and CLI share operation and
lifecycle rules. The interface, operations, and packaged discovery ship together.
Replace the ambiguous optional root hint with explicit Project folders and a
primary selection. Existing Automation Project references resolve through the
primary-directory owner, preserving dependency and missing-directory outcomes;
they do not acquire conversation-default lookup or multi-folder fan-out.

Expected areas: Agent Thread protocol and metadata persistence, Thread service
operations, resource/default-directory resolution, local-tool admission and
context publication, packaged CLI/Skill admission, ThreadDock/ThreadList and
Project catalog/service/storage/editing and membership flow, Automation Project
directory resolution, localization, and focused Core/renderer/Electron tests.
Update Agent Core, tool design, rendering, and affected context specs together.
In particular, reconcile the stale Agent Core opening that says Thread owns a
working directory with its later current contract; do not preserve both claims.

Collision evidence was checked against `origin/main` at `7c17f32d`: #664 startup
fault isolation and #668 scheduled-work design are integrated. Open #669 claims
Thread source resolution, runtime context, records, and lifecycle; this design
overlaps those owners and must consume its final contract before implementation.
Scheduled-work design currently assumes no sticky Thread cwd; reconcile that
premise while keeping scheduled assignments independently owned. CLI packaging
can overlap scheduling; coordinate shared ownership and repeat
the open-PR file-scope check before claiming implementation. No board or changelog
change is part of this draft.

## Open questions

**OQ-1:** Ratify DEC-1, the multi-folder Project in FR-5, and the creation/move
distinction in FR-3 as the product contract before code. The alternative
catalog-only history design is retained
in [the archive](archive/thread-history-project-labels.md); it does not solve
durable work-folder selection.

## Acceptance and verification

- **AC-1:** A user starts an unbound chat, chooses a folder in the UI or through
  an explicit Agent instruction, restarts, and observes the same accepted setting
  in the conversation, history, and subsequent default execution. Covers FR-1/2.
- **AC-2:** A one-off operation in B from a chat bound to A records B accurately;
  the next unqualified operation uses A. An explicit switch to B changes that
  default, with no change to earlier tasks. Covers FR-2 and BR-1/2/3.
- **AC-3:** Two chats initialized from one Project can use different worktrees.
  Moving, renaming, changing, or deleting that Project redirects neither; a fork
  copies its parent's setting without a live link. Covers FR-3.
- **AC-4:** Deleting the selected folder shows its unavailable identity, blocks
  dependent default execution, allows valid explicit overrides and ordinary chat,
  and supports clear/reselect recovery without silent substitution. Covers FR-1
  and BR-1.
- **AC-5:** Competing edits, a setting change during a live task, a restored
  conversation, and an Agent changing its own active chat produce truthful revision
  results and task addresses. Covers FR-2 and BR-2.
- **AC-6:** Long/colliding folder names, absent folders, Project groups, system
  sources, and startup failures remain distinguishable in narrow light/dark history
  layouts without hover reflow or extra nested row actions. Covers FR-4.
- **AC-7:** Folder selection leaves access/configuration unchanged, does not
  redirect a delegated task, and does not change saved Automation behavior.
  Covers BR-3/4.
- **AC-8:** Packaged and source-launched UI/Agent paths persist and refresh the
  same setting; unavailable Host, invalid path, and stale revisions cannot report
  success. No dedicated model tool is added. Covers FR-1/2.
- **AC-9:** Create/edit a zero-, one-, and multi-folder Project through UI and
  Agent access. Verify primary initialization, duplicate rejection, explicit
  primary replacement, secondary-folder discovery and unavailability, and that
  a Project edit does not redirect an existing chat. Covers FR-3/5.
- **AC-10:** Through the actual packaged CLI/Skill, inspect a paginated catalog,
  create/edit, bind/move/unbind, and delete a Project. Verify caller/target scope,
  cancellation, native proposal revision conflicts, UI refresh, dependency rules,
  ambiguous/partial create outcomes, and atomic combined membership/folder edits.
  Covers FR-6 and the combined operation in FR-3.
- **AC-11:** With Project P primary A and a chat using A, clear the chat's work
  folder while retaining P. Composer and history show `P · Application default`,
  location details expose Host default H, and the next unqualified operation uses
  H. Restart retains the unset setting and its explicit label. Covers FR-1/4 and
  BR-1.
- **AC-12:** Assign an existing chat with no saved work folder to P through a
  membership-only change. It remains unset and shows the same application-default
  identity and resolved path as AC-11, including when H equals P's primary path.
  Unavailable default-path resolution shows unavailable location details and never
  substitutes P's primary or the last task cwd. Covers FR-3/4 and BR-1.

Run typecheck, relevant owner/integration tests, real CLI discovery, focused
Electron interaction and restart checks, docs checks, and light/dark verification
before marking the implementing PR ready. For this design artifact, validate
links, requirement coverage, and the scenario walkthroughs; no runtime behavior
is claimed by a document check.
