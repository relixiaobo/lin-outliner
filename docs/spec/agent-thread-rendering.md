# Agent Thread Rendering

The Agent dock renders canonical Thread DTOs directly. There is no second event
projection or UI-only execution model.

## Surface Structure

The dock has three stable regions:

1. A Thread list with selection, creation, details, rename, fork, and delete actions.
2. A scrollable Thread view containing ordered Turns and Items.
3. A composer for starting, steering, or interrupting the active Turn.

Child Threads are visibly nested under their parent. Forks remain top-level user
Threads and expose their source lineage in details rather than masquerading as
children.

The selected Thread ID is renderer state. Thread catalog, loaded pages, root
Thread execution selections, active input requests, Turn-local Plan snapshots,
and Goals live in `threadStore`; components do not maintain parallel copies.

The Thread list opens the separate Automations surface defined by
[`agent-automations.md`](agent-automations.md). Its React chunk loads only when
opened, so the default Thread and composer path does not load the schedule editor.
Its canonical definition/run store merges realtime notifications monotonically
with in-flight initial reads; it does not reuse or duplicate `threadStore`.

## Item Rendering

`ThreadItemView` switches exhaustively on the canonical Item discriminant:

- user and agent messages render readable text at the same content register as
  the outliner
- reasoning uses the established `Thinking` / `Thought` disclosure with a
  one-line gist while collapsed and every provider-supplied summary/content
  part in the expanded body; every non-empty reasoning Item remains expandable,
  including a single-part or single-line provider summary, so truncation never
  removes access to the complete text; only the actual tail Item streams
- consecutive command, file, MCP, dynamic-tool, collaboration, and search Items
  form one counted activity disclosure without creating another data model
- each tool row derives a readable summary from its canonical fields and exposes
  status plus direct argument/result data; structured arguments and results render
  as their JSON rather than a second presentation model, while command output,
  file interaction, copy actions, and image previews retain their native
  affordances; a successful shell exit code is redundant with the completed row
  and stays hidden, while a non-zero exit code is rendered as an explicit failure
  explanation; a completed row rests on its tool-type icon rather than a generic
  success check, while only failure carries a status ring
- bounded tool-result projections render immediately; expanding a row resolves
  its content-addressed `outputRef` once and replaces the projection with the
  full text, while copied Turns use the same full result
- file-change results reuse the shared local-file preview affordance and expose
  the established Add to Today action without introducing an artifact DTO
- every ordinary tool, including a loaded or isolated Skill, uses the same
  expandable row inside the counted activity group; tool-specific icons,
  summaries, images, and child-Thread links remain supplemental affordances;
  managed tool images resolve from their typed resource reference through the owning
  Thread and preview only a disposable scratch copy; Add to Today sends the same typed
  identity to a main-only ingest seam, which reauthorizes ownership and returns asset
  metadata without accepting or returning a managed path
- local paths in tool arguments and results use the shared inline-file reference
  affordance; absolute paths link directly, while relative values in path-bearing
  JSON fields resolve against the Thread working directory. URL text is not
  treated as a local path, and main-process preview checks remain authoritative
- collaboration Items and Subagent activity link directly to their canonical
  child Thread
- Memory used by an answer renders through the ordinary inline Node-reference
  affordance next to the supported claim; `node_search` and `node_read` remain
  in the process and Turn Diagnostics, with no separate Memory Item or disclosure
- context evidence stays hidden from the ordinary transcript; `contextReset` and
  `contextCompaction` render dedicated `Context cleared.` and compaction boundary rows
  at their exact canonical positions. A completed standalone `/clear` or `/compact`
  feature Turn exposes Turn Diagnostics from that boundary and does not synthesize an empty
  response row with Copy or Continue-in-New-Chat actions

A completed Turn with a final answer and known duration folds its process Items
under the established `Worked for ...` disclosure while leaving the answer
outside the fold. Live and resultless process timelines remain visible; a live
timeline uses the established `Working` / `Working for ...` status row even
before its first process Item arrives. Rendering builds one Turn-level process
projection from every reasoning, commentary, image-view, Subagent, and
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
route. User messages retain Copy and, for the latest terminal Turn only, Edit;
final agent messages retain Copy, Continue in new chat, and Details. User messages that exceed five reading lines
retain the established measured Show more / Show less disclosure instead of
growing the transcript without bound.

User-message rendering consumes canonical `ThreadUserContent[]` in submitted
order. Text, Node references, directories, and every attachment retain an inline
marker inside a message bubble. Consecutive image attachments additionally form
one external gallery immediately after their marker-bearing inline run and before
the next canonical content run; the preview never replaces the image's message
marker. The gallery uses dedicated
layouts for one, two, three, and four images. More than four images initially
show four thumbnails with a `+N` control; expanding shows every image and adds a
collapse control. The overflow control is a compact bottom-right media-HUD badge:
it uses the shared fixed-contrast palette and compact inset outline over arbitrary
image pixels, exposes rest/hover/active/focus feedback, and does not add a
backdrop filter or the file-preview action shadow. The ordinary file reference
retains its Thread-scoped preview identity without a second attachment-card
wrapper; every gallery tile retains the same scoped identity and opens the shared
reader. Replay and fork consume the same canonical ordering rather than
reconstructing attachment placement. Free-text editing is exposed only when
canonical content contains at most one text part, and replacement preserves every
non-text part in place. A split-text mixed message omits Edit until a structured
content editor can represent each text boundary without flattening the sequence.
Each inline bubble keeps the five-line measured disclosure independently, so
the collapse mask never crops gallery content.

A terminal response owns one action row directly below its visible content.
Every terminal response exposes Copy, Continue in new chat, and Details as
applicable. Continue in new chat is the only user-visible history fork action
and uses the `afterTurn` boundary. There is no separate Turn footer or second
action surface. A
failed response keeps any partial answer first, then shows a bounded, parsed
error summary, then the same action row. JSON and HTML provider payloads never
render as unbounded transcript prose. An interrupted response uses the
established quiet stopped row and the same three actions. Hover and keyboard
focus reveal the row without changing geometry.

Copy on a response copies the complete assistant side of that Turn in order:
commentary, tool arguments, full tool results when available, and
the final response. A partial failed response remains the copy authority; its
error summary is used only when the Turn has no copyable assistant content.
Right-clicking the terminal response opens the native message menu with the same
Copy, Continue in new chat, and Details commands.

The Details icon preserves the established two-level interaction without
duplicating information surfaces. Hover or keyboard focus shows one
non-interactive card containing timestamp, provider, model, reasoning effort,
and the complete token/cost usage breakdown. The card is anchored in a portal
and cannot be clipped by transcript scrolling. Clicking the icon, or choosing
Details from the native message menu, opens Turn Diagnostics in the active workspace
pane.

Turn Diagnostics is the technical workspace view for one canonical Turn; its user-facing
title is **Model Interactions**. The default surface is Summary plus an Interaction Timeline
grounded on the provider boundary. Tenon's accepted-input records, canonical Items,
configuration, projection evidence, and provenance live behind one collapsed Internal
diagnostics disclosure and mount only on demand. They never appear as peers of an outbound
Request or masquerade as provider `user` messages. There is no independent Context
Construction section: attachments, stable instructions, system reminders, Skill/Role/view/
compaction evidence, tool definitions, and provider options are visible in the Request that
actually carried them, while their Tenon source records remain available in Internal
diagnostics.
Summary reads model, timing, status, Model Call count, tool-execution count,
input/output/cache token usage, cost, and any terminal error code/message/detail from the
immutable Turn and diagnostics. Canonical Item counts remain internal. `Input tokens`
means `usage.input`; cache reads and writes remain separate facts and are never relabeled
as input context.

The renderer performs one `thread/turn/details/read` request. Main returns the exact
Thread, Turn, and immutable diagnostics payload referenced by
`Turn.execution.diagnosticsRef`; renderer code never scans Turn pages, recomputes a
context epoch or cache affinity, or substitutes current configuration for historical
facts. A Turn without a diagnostics reference explicitly reports that request
diagnostics were not recorded. A referenced payload that is missing, corrupt, or does
not match the Turn fails closed instead of appearing absent.

Interaction Timeline renders every Model Call plus the tool-execution, retry, and compaction
activities that bridge Calls in their recorded order; the renderer never derives the sequence
by scanning canonical Items. Accepted initial and steering input remain recorded, but are
input-admission evidence rather than model interaction and therefore appear only in Internal
diagnostics. A Model Call owns exactly one Request and its corresponding Response. Tool
execution is a sibling activity after its source Call and before the Call that consumes its
results, not a child of either Response or Request. Parallel tools from one model response form
one batch; a transient tool with no canonical Item remains an explicit execution fact.
Wrapper-level retries create another Call and a typed retry activity; retries hidden inside a
provider SDK remain part of that SDK invocation.
The timeline expresses hierarchy with disclosure indentation and horizontal activity
separators only; it does not draw a vertical guide-line axis through nested content.

Request first renders the content-bearing fields from the final post-adapter **Provider
Request** observed immediately before transport. Stable provider parameters such as model,
streaming, output limits, reasoning options, and tool-selection controls stay out of the main
content flow and appear in the Model Call information surface and Request metadata. The raw
Provider Request JSON and copied request diagnostics remain complete and lossless. Provider
fields preserve top-level insertion order only as a serialization fact; they receive no
synthetic numeric context order. `messages`,
`input`, `contents`, and equivalent sequence fields preserve element order and every
message's content-part order. The renderer may add presentation labels such as attachment
or System Context, but never derives authority, reorders, merges, or substitutes the
recorded value. Main records exact, unambiguous adapter-to-canonical content-part matches as
typed provenance; unmatched fragments stay unlabeled. A System Context part expands to its
ordered semantic entries (Environment, User View, Available Skills, Available Roles, and
other typed kinds) with authority and purpose, plus the untouched raw provider part. The
renderer never parses reminder XML, and literal user text that resembles a reminder remains
ordinary text. The complete image-sanitized provider request is available as JSON from
the same call. The recorded pre-adapter Model Context remains available through a secondary
disclosure in semantic order: System Instructions, Tool Definitions, then Messages. It is
explicitly labeled as Tenon's projection passed to the adapter, not as the transport payload.

Each call distinguishes request time,
HTTP-headers time and latency,
and assistant-response completion time and total duration. It exposes an HTTP status and
allowlisted provider request ID when available, but never arbitrary response headers. It
also exposes the protected message boundary, token budget, common-prefix count, request
fingerprint, cache-breakpoint paths, complete provider request, and assistant response.
Provider-reported input/output/cache/reasoning usage and
stop reason, plus locally calculated cost and normalized error details, are typed call
facts rather than renderer inferences. The
Call summary derives completed, failed, or
interrupted from the response stop reason rather than treating every response as success.
The Model Call header keeps only its ordinal and derived result status in the main reading
flow. Its trailing information control exposes the recorded model, provider, request time,
duration, estimated input, provider-reported token/cache/reasoning usage, and calculated
cost on hover or keyboard focus. The adjacent copy control materializes one typed request
diagnostics export only when invoked: runtime selection, complete recorded Model Context,
ordered image-sanitized Provider Payload, and Request Facts. It does not claim to be an HTTP
request, expose secret headers, or restore omitted image bytes.
Repetition-heavy request fields use the diagnostics fragment pool without losing a value
or its position. Each fragmented request field carries an aligned optional provenance array;
the codec requires exact fragment and content-part cardinality whenever provenance exists.
Image bytes are never returned to the renderer: binary/base64/data-URL
content is represented by an omission marker containing its byte length and SHA-256.

Internal diagnostics exposes accepted-input admission records, accepted user records,
canonical Thread/Turn/Session and provenance identities, context epoch, cache affinity,
effective configuration, L0/L1/L2 prompt blocks and fingerprints, canonical tool schemas,
the resolved runtime, the prepared message pool, and exhaustive Canonical Items including
context evidence, reset, and compaction Items. These facts explain or verify a request; they
do not compete with the post-adapter Request as a second account of what was sent. The whole
section is collapsed and lazy by default. Large prompt blocks,
schemas, provider messages, responses, and Item JSON mount
only while their disclosure is open. Expanding an evidence Item issues one exact
`(threadId, turnId, itemId, contextId)` audit read and renders the decoded semantic
payload; it never receives a canonical payload path or gains digest-only read authority.
Missing, corrupt, rolled-back, or mismatched evidence remains explicitly unavailable.
Opening Turn Diagnostics pushes the current view onto the pane's Back stack and never creates a
split. Opening another Turn while Turn Diagnostics is current replaces only the target,
without adding history noise; Back or close returns to the prior view.

Normal Thread UI may visually group Items by Turn without printing every Turn
ID. Turn Diagnostics must show the same Thread, Turn, and Item
identities as the transport.

Thread Details exposes `ThreadMemoryMode` only for persistent root user Threads.
Its loading, disabled, busy, and error states reuse the existing switch and
diagnostic typography. Global Memory settings, Reset, and timeline navigation
are owned by [`agent-memory.md`](agent-memory.md).

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

After the first Turn becomes terminal, the preview remains visible while the
host asynchronously generates a short name with the current Thread model.
`thread/name/updated` atomically refreshes both the dock header and Thread list;
it does not change Thread activity time or reorder the list. Generation failure
keeps the preview. Rename and explicit clear permanently take precedence. A
Continue-in-new-chat fork appears as `Title (1)`, `Title (2)`, and so on across
the same fork lineage, including when continuing from an already suffixed fork.

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
the reserved `/compact` and `/clear` commands plus the current user-invocable Skill
catalog. `/compact` inserts a trailing space for optional instructions; `/clear` inserts
the complete command. Skill entries insert `/<skill> ` without
flattening other structured composer content. A direct Skill invocation without
attachments is resolved by the Turn's Skill runtime before the model prompt is
sent; the canonical userMessage Item retains exactly what the user submitted.
The two reserved commands are recognized only as the sole text part and require an idle
Thread; they create completed feature Turns without sending a user message or launching
the model. Messages with attachments and unknown slash text remain ordinary Turn input.

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

The composer submits `ThreadUserContent[]` directly together with one bounded
structural user-view hint snapshot. The hint contains panel, root, focused, selected,
visible Node identities, depth, and expansion state, but never renderer-authored Node
titles or content. It is globally capped at 80 visible Nodes, depth 5, 50 selected
Nodes, and 64 KiB; main resolves current authoritative Node data. Text, attachments, and
Outliner Node references remain distinct structured parts in the same order the
user placed them in the ProseMirror document. Sending a Node from its context
menu adds a removable Node-reference part to the composer; it never inserts
reference markup into text. Edit replaces only the message text while preserving
the complete original structured input. An attachment-only or Node-reference-only
Turn can add text through Edit without losing its structured content.

Only the latest user message in a terminal Turn exposes Edit; earlier messages
remain copyable, and an active Turn cannot be edited while its response is
running. Editing autofocuses the existing edit field. Escape cancels and
Cmd/Ctrl+Enter saves. Saving appends a `thread/rollback` marker for the final
Turn, then resubmits the original structured content with only its text replaced
as a fresh Turn in the same Thread. It does not mutate the sealed source Turn or
undo any document, file, tool, Goal, or external effect.

Attachment interaction retains source identity without carrying source bytes.
Local paths deduplicate by path. Pathless files stream to Thread-owned storage
and deduplicate by the returned content digest, so same-named files with
different content remain distinct. Native picker, browser file, drag-and-drop,
and mention admissions share one serialized composer queue, so duplicate and
six-attachment limit checks observe every previously committed admission.
Removing an unsent managed reference or leaving its Thread aborts an unfinished
upload and discards a completed payload when neither another retained draft
reference nor canonical history owns it. Duplicate and attachment-count skips
produce transient feedback. Composer previews may use renderer-only object URLs
or native thumbnails, but icons, thumbnails, object URLs, and upload state never
enter `ThreadAttachmentContent`. Images receive their bounded immutable prompt
snapshot during main-process admission, not in renderer canvas code.
Office ownership files with `.~` or `~$` prefixes and Office document extensions
are rejected before upload by picker, paste, and drop admission. A native picker
names an exact original-file sibling when present but never silently substitutes
it. Rejected ownership files do not consume the six accepted-attachment slots.

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
and owns New Thread plus every Thread-management action. The dock header contains
only the list trigger and global dock-close chrome. Each row exposes one More
control on hover or keyboard focus without moving row geometry; its Details,
Rename, and Delete menu uses the same anchored-overlay contract with native menu
arrow-key navigation. Ordinary root-user rows show relative time only. Special
sources show a localized product label and never expose raw `threadSource` enum
values.

The transcript follows streaming output only while the reader remains near its
bottom edge. Scrolling upward or opening a reasoning, tool, or long-message
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

`turn/plan/updated` is also transient execution state, not an Item. The selected
Thread keeps only the latest snapshot for its active Turn and shows compact
`Step n / total` progress above the composer. Hover previews the complete
checklist; activating the summary opens the same scrollable checklist and moves
keyboard focus into it. Escape closes it and restores focus to the summary. A
replacement snapshot overwrites the prior one;
terminal completion, failure, interruption, Thread deletion, catalog reload,
or application restart removes it. It never appears in transcript history, Turn
Details, response copy, or as `Used update_plan`.

Process, reasoning, tool-group, and tool-detail disclosures keep per-Thread UI
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
- the minimal header reserves the global rail-toggle zone so its list trigger
  does not overlap window chrome

All user-facing copy comes from typed i18n messages. UI nouns are Thread, Turn,
Item, Goal, Role, and Subagent.
