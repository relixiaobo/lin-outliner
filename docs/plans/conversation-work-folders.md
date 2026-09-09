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
change where later work defaults. **OBJ-4:** Ordinary conversations without a
Project or selected folder keep the composer free of extra setup/status chrome.

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

**DEC-2:** The composer uses an Add (`+`) menu in place of the attachment icon.
Project/location status appears immediately beside Add only when a Project or
work folder is selected. This follows the PM's explicit interaction direction
for the expected majority of conversations without a Project.

**DEC-3:** The model control uses a compact model name and reasoning label, such
as `Sonnet 5 · Med`. Full model/connection identity and reasoning labels remain
available in its menu and tooltip. This presentation shares the toolbar space
with the optional Project/location chip.

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

The composer toolbar starts with Add (`+`), which opens attachment and optional
Project/work-folder actions. With neither Project nor work folder selected, this
is the only context-entry control: no Choose project prompt, status chip, or extra
Project row is displayed. After a selection is accepted, one compact status chip
appears immediately to the right of Add in the same toolbar row. Its label uses
the same saved-folder versus application-default distinction as history in FR-4.
Full paths and related folder lists are available in Project/location details.
FR-7 defines the menu and status interaction.

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

**FR-7:** Add opens a menu with Add attachments, Choose project, and Set work
folder actions. Choose project opens the searchable selector with creation and
no-Project options; Set work folder opens the location control/native picker from
FR-1. Once a selection exists, the same actions allow changes, and clicking the
status chip opens its Project/location details. There is no separate persistent
Project control above the composer.

| Accepted conversation settings | Status immediately beside Add |
| --- | --- |
| No Project and no saved folder | No status chip |
| Project P and its primary folder A saved | P |
| Project P and another folder B saved | P · B |
| Project P and no saved folder | P · Application default |
| No Project and folder B saved | B |

Changing or clearing a setting updates the chip after Host acceptance. Leaving a
Project retains any saved work folder, so a folder-only chip remains; clearing
both settings removes the chip. Pending/failed reads never convert an unknown
selection into a false empty state. Selected unavailable locations stay visible
and expose repair actions. The no-selection application default remains
inspectable through Set work folder without adding persistent toolbar status.

Add attachments uses the existing attachment picker and admission path. Attachment
limits or attachment-specific unavailability disable that action, not unrelated
Project/location inspection or otherwise admissible setting changes. File paste,
drop, tray/removal behavior, and draft preservation remain part of the existing
attachment owner. Attaching a file does not select a Project or work folder.
Menu dismissal restores focus, keyboard operation exposes every eligible action,
and the neutral icon/chip follows the existing design tokens. Long Project names
truncate before hiding the application-default qualifier or different-folder
identity; full text is accessible in details. At supported narrow widths the
chip stays in the toolbar without displacing send/stop controls or adding a
permanent row. Hover never changes geometry.

**FR-8:** The composer model button displays a compact form of the model already
resolved by the existing selection owner. Apply the following naming rules to
recognized display-name forms, independently of whether the connection is direct,
a gateway, or custom. These are formatting examples, not a new model inventory
or a claim that a particular connection offers every family.

| Model family / input form | Compact-name rule |
| --- | --- |
| Claude Sonnet, Opus, Haiku | Omit a redundant vendor/`Claude` prefix; `Claude Sonnet 5` becomes `Sonnet 5`. Retain family, version, and variant. |
| OpenAI GPT and o-series | Omit a redundant `OpenAI` provider prefix when present. Keep `GPT` or the o-series identity, version, and variants such as mini, nano, Pro, Codex, or named variants. |
| Google Gemini | Omit a redundant `Google` provider prefix when present. Keep `Gemini`, version, and Pro, Flash, or Flash-Lite distinctions. |
| DeepSeek | Keep the DeepSeek family and version/variant, including R/V-series and reasoning/coder distinctions when supplied. |
| Qwen | Keep Qwen, version, parameter-size identifiers, and Coder/VL/Thinking/Instruct distinctions when supplied. |
| Kimi, GLM, Grok | Keep the family, version, and meaningful variants; already concise names need no further abbreviation. |
| MiniMax, Mistral, MiMo, and other families | Keep the supplied model identity; remove only a separately recognized redundant provider prefix, never a model-family word by position. |
| Unknown IDs and user-defined names | Preserve the supplied display name, or the existing model-ID fallback. Do not invent a family or parse an unknown name into a guessed version. |

Do not shorten different models to generic labels such as `Pro`, `Flash`, or
`Chat`. Snapshot/date, preview, context-window, quantization, and other suffixes
remain when they distinguish models. If two different IDs in one connection
would acquire the same compact label, retain a distinguishing source qualifier
or fall back to the original name/ID. Across connections, existing menu origin
labels and full connection details distinguish the same model name. The full
catalog/configured name remains unchanged in menus and configuration. Width
ellipsis is presentation only; it never rewrites identity or supplies a new ID.

All seven current canonical reasoning levels have an explicit button policy:

| Standard full display label | Compact English button label |
| --- | --- |
| Off | No effort badge; Off remains inspectable in the menu/details |
| Minimal | Min |
| Low | Low |
| Medium | Med |
| High | High |
| XHigh / Extra High | XH |
| Max | Max |

Use locale-specific compact copy; already short localized labels remain short
rather than being replaced with English initials. Minimal and Medium, and XHigh
and Max, remain distinct. Show only the levels actually supported by the selected
model; a model does not acquire seven choices merely because the shared ladder
has seven entries. The existing Default marker describes a supported selection
and does not become an eighth effort level.

Resolve a provider-specific full display label before applying the abbreviation
table. For example, a canonical slot exposed by its provider as `max` displays
`Max`, even if that slot's canonical key is `xhigh`. Unknown labels, including
Auto/Adaptive/Thinking/Ultra if actually supplied by the owner, retain their
meaning and are not guessed to equal Medium, High, or Max. The formatter neither
creates these choices nor changes the underlying level. The full reasoning label
appears in the menu and tooltip; canonical off retains the existing hidden badge.

Model name and compact effort stay visible at rest, with quieter effort text.
The button's accessible label and inspectable details expose the full model name,
connection identity, and reasoning level; hover is not the only way to recover
the full information. Model selection, current connection, floating versus pinned
selection, effort support/fallback, and execution remain owned by the existing
selection path. This adds no model resolver, catalog rewrite, or configuration
mutation. The row composes as Add, optional Project/location chip, flexible space,
compact model/effort, and send/stop. Supported narrow layouts retain the location
distinctions from FR-7 and usable model and send/stop controls without hover reflow.

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
**EVD-4:** The PM expects most conversations to have no Project and supplied a
Tenon screenshot directing replacement of the attachment icon with Add, Project
selection inside its menu, and selected status beside Add. This is the supplied
product direction, not a measured usage statistic.
**EVD-5:** The PM requested shortening the adjacent model control, explicitly
giving `Sonnet 5` as sufficient for a Claude model and asking to abbreviate
`Medium`, considered together with the Add/status toolbar interaction. The PM
also requested coverage of other model families and all reasoning levels.
**ASM-1:** Add remains discoverable without an empty Project prompt. Validate with
ordinary chat, attachment use, a folder-less Project, a multi-folder Project, two
worktrees, cross-directory inspection, keyboard navigation, and a narrow composer
with compact model/effort labels.

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
context publication, packaged CLI/Skill admission, ThreadView's composer toolbar,
ThreadComposerModelControl and its private display formatting, ThreadDock/ThreadList,
composer/Project styles, attachment-menu integration, and
Project catalog/service/storage/editing and membership flow, Automation Project
directory resolution, localization, and focused Core/renderer/Electron tests.
Update Agent Core, tool design, rendering, and affected context specs together.
In particular, reconcile the stale Agent Core opening that says Thread owns a
working directory with its later current contract; do not preserve both claims.

Collision evidence was checked against `origin/main` at `7c17f32d`: #664 startup
fault isolation and #668 scheduled-work design are integrated. Open #669 claims
Thread source resolution, runtime context, records, and lifecycle; this design
overlaps those owners and must consume its final contract before implementation.
The scheduled-work design keeps its assignment location independent of a
conversation default; it may copy an explicit initial choice, then resolves its
saved Project selection through the same primary-folder owner. CLI packaging
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
- **AC-13:** A chat with neither Project nor saved work folder shows Add in place
  of the attachment icon and no Project prompt/chip/extra row. Mouse and keyboard
  can reach attachments, Project selection, and work-folder selection. Attachment
  limits disable only their own action; picker, paste/drop, draft, and attachment
  removal continue through the existing owner. Covers FR-7 and OBJ-4.
- **AC-14:** UI and Agent changes produce each FR-7 status immediately beside Add
  after acceptance, including the explicit application-default state in AC-11/12.
  Leaving a Project with a saved folder yields the folder-only chip; clearing both
  settings removes it. Pending/failure states remain truthful. Long names and a
  narrow light/dark composer retain location distinctions and accessible send/stop
  controls, and menu dismissal preserves input/focus. Covers FR-4/7.
- **AC-15:** A resolved `Claude Sonnet 5` with displayed effort `Medium` shows
  `Sonnet 5 · Med`; menus, tooltip, and accessible details retain full model,
  connection, and effort identity. Check localized short labels, retained version/
  variant suffixes, unknown/custom names, and provider-specific effort labels.
  Floating and pinned selections still display the actual resolved model without
  changing the selection or reasoning behavior. Covers FR-8.
- **AC-16:** With no context selection and with each FR-7 chip state, a narrow
  light/dark composer fits the compact model control and usable send/stop controls.
  Model and effort remain visible at rest; keyboard users can inspect full labels,
  change supported selections, and restore focus without losing the draft.
  Covers FR-7/8.
- **AC-17:** Naming fixtures cover every FR-8 family row through direct and gateway
  connections, meaningful version/variant/size/snapshot suffixes, two IDs that
  would otherwise collapse to the same label, same-name models across connections,
  and unknown/custom names. Compact labels and full details identify the selected
  model without changing its canonical ID. Covers FR-8.
- **AC-18:** Effort fixtures cover all seven standard display policies, a model
  supporting only a subset, reasoning off, localized labels, provider mappings
  whose native label differs from the canonical key, and unknown native labels.
  Minimal/Medium and XHigh/Max remain distinguishable, unsupported levels never
  appear, and shortening does not change the saved or admitted effort. Covers FR-8.

Run typecheck, relevant owner/integration tests, real CLI discovery, focused
Electron interaction and restart checks, docs checks, and light/dark verification
before marking the implementing PR ready. For this design artifact, validate
links, requirement coverage, and the scenario walkthroughs; no runtime behavior
is claimed by a document check.
