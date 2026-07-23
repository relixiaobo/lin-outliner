# Agent Thread Rendering

The Agent dock renders canonical Thread DTOs directly. There is no second event
projection or UI-only execution model.

## Surface Structure

The dock has three stable regions:

1. A Thread list with selection, creation, rename, fork, and delete actions.
2. A scrollable Thread view containing ordered Turns and Items.
3. A composer for starting, steering, or interrupting the active Turn.

Child Threads are visibly nested under their parent. Forks remain top-level user
Threads and expose their source lineage in details rather than masquerading as
children.

The selected Thread ID is renderer state. Thread catalog, loaded pages, root
Thread execution selections, active input requests, and Goals live in
`threadStore`; components do not maintain parallel copies.

## Item Rendering

`ThreadItemView` switches exhaustively on the canonical Item discriminant:

- user and agent messages render readable text at the same content register as
  the outliner
- plans render their current step list without becoming a separate work object
- reasoning uses the established `Thinking` / `Thought` disclosure with a
  one-line gist while collapsed; only the actual tail Item streams
- consecutive command, file, MCP, dynamic-tool, collaboration, and search Items
  form one counted activity disclosure without creating another data model
- each tool row derives a readable summary from its canonical fields and exposes
  status, arguments, output, copy actions, syntax-highlighted code, and image
  previews where the Item carries them; a completed row rests on its tool-type
  icon rather than a generic success check, while only failure carries a status
  ring
- bounded tool-result projections render immediately; expanding a row resolves
  its content-addressed `outputRef` once and replaces the projection with the
  full text, while copied Turns use the same full result
- file-change results reuse the shared local-file preview affordance and expose
  the established Add to Today action without introducing an artifact DTO
- an ordinary loaded Skill remains the established compact `/skill args` row;
  isolated Skill execution remains an expandable tool row, and loaded Skills do
  not disappear inside a counted tool group
- collaboration Items and Subagent activity link directly to their canonical
  child Thread
- compaction renders as a history boundary

A completed Turn with a final answer and known duration folds its process Items
under the established `Worked for ...` disclosure while leaving the answer
outside the fold. Live and resultless process timelines remain visible; a live
timeline uses the established `Working` / `Working for ...` status row even
before its first process Item arrives. Rendering builds one Turn-level process
projection from every reasoning, commentary, plan, image-view, Subagent, and
tool Item. That block is placed before the first final response regardless of
the Items' persisted arrival order, so a late reasoning Item cannot appear
below the answer. The process disclosure contains the independent reasoning,
activity-group, and tool detail disclosures rather than replacing them.

An active Turn ends with one rose shape indicator after all currently visible
process and response content. It is the stable generating affordance for both
empty and streaming responses; Markdown does not add a second caret. The
indicator disappears only when the Turn becomes terminal and stops animating
under reduced-motion preferences. A failed or interrupted Turn with partial
response prose keeps its process presentation neutral because the response tail
already owns the terminal error or stopped state.

Unknown Item kinds are protocol errors, not generic fallback cards. Item status
comes from the Item itself; the renderer never infers completion from missing
events.

Agent Markdown reuses the shared read-only code surface and dual-theme Shiki
highlighter. Stable completed blocks are memoized; only the final streaming
block is repaired and rendered live, with text commits throttled so token deltas
do not rerender the complete response. Node and local-file reference markers
render through the same inline reference and preview surfaces as the outliner;
Cmd/Ctrl-click preserves new-pane navigation, and HTTP links use the app preview
route. User and final agent messages retain the established hover actions for
copy, edit, retry, and regenerate. User messages that exceed five reading lines
retain the established measured Show more / Show less disclosure instead of
growing the transcript without bound.

A terminal response owns one action row directly below its visible content.
Successful responses expose Regenerate, Copy, Continue in new chat, and Details
in that order; failed and interrupted responses replace Regenerate with Retry
without moving the row. Continue in new chat is the only user-visible history
fork action and uses the `afterTurn` boundary. The `beforeTurn` boundary remains
an internal Edit/Retry/Regenerate mechanism and is never presented as a second
fork command. There is no separate Turn footer or second action surface. A
failed response keeps any partial answer first, then shows a bounded, parsed
error summary, then the same action row. JSON and HTML provider payloads never
render as unbounded transcript prose. An interrupted response uses the
established quiet stopped row and the same Retry action. Hover and keyboard
focus reveal the row without changing geometry.

Copy on a response copies the complete assistant side of that Turn in order:
commentary and plan text, tool arguments, full tool results when available, and
the final response. A partial failed response remains the copy authority; its
error summary is used only when the Turn has no copyable assistant content.
Right-clicking the terminal response opens the native message menu with the same
Copy, Retry/Regenerate, and Details commands.

The Details icon preserves the established two-level interaction. Hover or
keyboard focus shows a non-interactive usage breakdown with token and cost
segments. Click opens the message details popover with timestamp, provider,
model, reasoning effort, token summary, and cost. The popover is anchored in a
portal, closes on outside pointer or Escape, and cannot be clipped by transcript
scrolling.

Normal Thread UI may visually group Items by Turn without printing every Turn ID.
Details and diagnostics must show the same Thread, Turn, and Item identities as
the transport.

## Interaction States

When the provider catalog is loaded, at least one provider is usable, and the
catalog has no Thread, the dock automatically starts and selects one root user
Thread. The first usable surface is therefore the focused composer, not an
explanatory empty state followed by a second creation click. Provider loading is
neutral. When no provider is usable, the dock creates nothing and offers the
Providers settings action instead. Starting a Thread resolves the current
provider and working directory at the main-process boundary.

The first accepted user input sets a Thread's empty preview from the first
non-empty text part, then an attachment name, then a Node-reference note. The
preview is whitespace-normalized and bounded. `turn/started` updates the local
catalog immediately, while the host persists the same value for both persistent
and ephemeral Threads. Explicit names remain authoritative and later Turns do
not replace the initial preview.

For an idle Thread, submit starts a Turn. For an active Thread, submit steers the
exact active Turn. Stop interrupts that Turn. Buttons remain dimensionally stable
while their icon and label state changes. The primary composer action is one
state machine: an active Turn with no draft shows Stop; adding a draft replaces
Stop with Steer; an idle Thread shows Send. Stop and Send are never presented as
competing primary actions.

The composer reads the selected root Thread's canonical execution selection and
the provider catalog. Its established model/reasoning chip, anchored menu,
flyout submenus, hover behavior, keyboard navigation, focus restoration, and
viewport clamping are retained. A selection submits one atomic
`thread/configuration/set` request. The chip is disabled during an active Turn,
while a request is pending, and for non-root Threads; it never edits another
agent entity or exposes host-private capability configuration.

Reopening the Agent rail restores focus to the composer of an editable Thread.
An active `request_user_input` keeps focus in its current step instead; opening
the rail never steals focus from that blocking form.

Typing `/` opens the established composer command menu. It is populated from
the current user-invocable Skill catalog and inserts `/<skill> ` without
flattening other structured composer content. A direct Skill invocation without
attachments is resolved by the Turn's Skill runtime before the model prompt is
sent; the canonical userMessage Item retains exactly what the user submitted.
Messages with attachments and unknown slash text remain ordinary Turn input.

Only a root user Thread exposes the composer. Child, Automation, Memory, and
other feature Threads remain fully inspectable but are driven through their
own canonical admission path instead of accepting renderer-authored Turns. A
user can fork terminal history into a root user Thread before continuing it.

Provider settings distinguish initial loading from a completed unavailable or
failed read. Loading is neutral; once loaded, the selected Thread provider must
be enabled and credentialed before Send or attachments are available. Thread
creation requires any usable active provider. The unavailable empty state opens
the Providers settings category, and settings-change broadcasts refresh the dock
without discarding an existing draft.

The composer submits `ThreadUserContent[]` directly. Text, attachments, and
Outliner Node references remain distinct structured parts in the same order the
user placed them in the ProseMirror document. Sending a Node from its context
menu adds a removable Node-reference part to the composer; it never inserts
reference markup into text. Edit replaces only the message text, while retry and
regenerate replay the complete original structured input. An attachment-only or
Node-reference-only Turn is therefore sendable and retryable.

Editing a user message autofocuses the existing edit field. Escape cancels and
Cmd/Ctrl+Enter saves. Saving forks at `beforeTurn` and resubmits the original
structured content with only its text replaced; it does not mutate the sealed
source Turn.

Attachment interaction retains the established source-identity rules. Local
paths deduplicate by path; pathless files deduplicate by a renderer-only content
hash, so same-named files from different sources remain distinct. Duplicate and
attachment-limit skips produce transient feedback. Supported images selected by
the native picker remain inline model-vision input while their composer reference
keeps the local path for preview; renderer-only source keys, icons, thumbnails,
and hashes never enter `ThreadAttachmentContent`.

`request_user_input` replaces the editor inside the existing composer surface
with an in-dock form tied to one Item. It is a product-input surface, never a
permission prompt or a modal over the transcript. Multiple questions use the
established one-at-a-time flow with progress, Back/Next navigation, retained
answers, and focus moved into each newly shown step. The form adapts only the
canonical option-or-Other contract. Removed question outcomes and rich-answer
fields are not part of this contract. A response includes the exact Thread, Turn, and Item IDs
and is rejected if the request is no longer active.

Rename uses the shared `Dialog`; delete uses `ConfirmDialog`. Browser-native
prompt and confirm APIs are not used. Fork creates and selects the new Thread
without mutating the source. Deleting the selected Thread chooses the next
catalog Thread and loads its Turns, Goal, and editable execution selection before
presenting it. Deleting the final Thread returns through the same automatic
root-Thread path, leaving a focused composer rather than a dead-end empty state.

The Thread list is an anchored popover. It clamps to the viewport, closes on an
outside pointer or Escape, traps focus while open, restores focus to its trigger,
and exposes row actions on hover or keyboard focus without moving row geometry.
The Thread action menu uses the same anchored-overlay contract with native menu
arrow-key navigation; it is not a CSS-only `focus-within` disclosure.

The transcript follows streaming output only while the reader remains near its
bottom edge. Scrolling upward or opening a reasoning, tool, plan, or long-message
disclosure releases that lock, so later Item updates never pull the reader away
from earlier evidence. A new explicit send restores bottom following.

Each Thread keeps an ephemeral scroll snapshot across Thread switches. Returning
to a Thread restores its prior position, or continues following the bottom when
the snapshot was bottom-locked. Threads above forty Turns reuse the established
measured-row virtual transcript with viewport overscan; terminal offscreen Turns
do not remain mounted, while the active viewport and disclosure scroll anchors
remain stable as measured heights replace estimates.

Provider request and stream retries are transient execution state, not Items.
The selected Thread shows the established live reconnecting row while retrying
and removes it when the provider recovers or the Turn becomes terminal.

Process, reasoning, plan, tool-group, and tool-detail disclosures keep per-Thread UI
overrides in versioned local storage. Their keys use canonical Item identities;
switching Threads, streaming-to-terminal remounts, and application reloads do not
discard an explicit user choice. A live reasoning Item is open while streaming.
A terminal reasoning Item rests folded unless it is the only process Item in a
Turn without a final agent response, in which case it opens by default. Expanding
or collapsing a disclosure preserves the clicked row's scroll position while
releasing transcript bottom-follow.

## Pagination And Notifications

Thread list and history reads use opaque cursors. Persistent and ephemeral
Threads share one `(updatedAt, id, direction)` keyset and one cursor after they
are merged, so an ephemeral row cannot displace a persistent row between pages.
The store may append live notifications to loaded pages, but a reload always
reconstructs the same view from canonical paged reads.

Each history load carries a per-Thread generation and observes the Thread's live
notification revision. A superseded request is discarded. If a notification
lands during an older request, the response is merged monotonically: a terminal
Turn cannot return to `inProgress`, completed Items cannot be replaced by older
Items, a terminal execution Item from either source wins over `inProgress`, and
live-only Turns remain present. History notifications update only a Thread whose
history is loading or already loaded; other Threads wait for a canonical page
read instead of manufacturing partial history.

Turns, Goal, and root Thread execution selection load in parallel. Configuration
reads and writes carry a separate per-Thread revision: an older read or slower
write response cannot overwrite a later user selection or roll catalog
`modelProvider` metadata backward.

Notifications are decoded before entering renderer state. A notification for an
unloaded Thread updates catalog metadata without manufacturing partial history.
When a page is loaded, Item order follows persisted rollout position.

## Visual Contract

The Agent dock follows the shared design system:

- content text uses the outliner reading size and line height
- chrome uses tokenized neutral states and icon controls
- dialogs and menus use shared overlay primitives
- the pre-refactor transcript, composer, disclosure, attachment, and message
  action geometry remains the visual baseline even though canonical DTOs now
  drive it directly
- focus remains visible, motion respects user preference, and hover never moves
  layout
- the header reserves the global rail-toggle zone so Thread actions do not
  overlap window chrome

All user-facing copy comes from typed i18n messages. UI nouns are Thread, Turn,
Item, Goal, Role, and Subagent.
