# Agent Thread Rendering

The Agent dock renders canonical Thread DTOs directly. There is no second event
projection or UI-only execution model. Presentation-only reductions may collapse
append-only Items or select the latest canonical DTO, but never invent execution
state or write it back as history.

## Surface Structure

The dock has three stable regions:

1. A Thread list with selection, creation, details, rename, fork, and delete actions.
2. A scrollable Thread view containing ordered Turns and Items.
3. A composer for starting, steering, or interrupting the active Turn.

The Thread list is root conversations only. A child Thread is an execution
artifact of a Turn rather than a conversation the user had, so `thread/list`
filters children out in SQL — they never occupy a keyset cursor slot and cannot
displace a root between pages — and the list renders no lineage indent. A child
is reached from the parent transcript, from the parent's Thread Details, or by
direct id; the renderer's Thread map is a catalog rather than the list, so a
child recovered that way keeps its identity and live status, and a reload's
omission of children proves nothing about them. A root shows a neutral
background-activity indicator on its list row when it is not selected and its
own Turn is actively running, or whenever its subtree has an actively running
descendant Turn. A Thread flagged `waitingOnUserInput` is blocked rather than
running and does not receive that indicator. The selected root's own foreground
Turn does not duplicate its status in the list. This is also the only place a
fire-and-forget child is visible after its parent Turn ended.

A selected child Thread gains a back affordance naming its parent, ahead of the
list affordance rather than in place of it: the Thread list is the only route to
create, rename, details, and delete, so no view may be without it. Lineage
deeper than one level collapses to the immediate parent. Every child link —
transcript row, Thread Details row, back affordance — resolves through the
catalog-recovering open path, and a Thread that is genuinely gone surfaces the
dock's transient failure copy instead of throwing behind a bare call.

Parent Thread Details lists the descendant subtree newest-activity first with a
readable name, status, and last activity; the read names the subtree while the
Thread catalog keeps each status current, so a child that starts or stops while
the dialog is open does not go stale. Each row opens that child, and each can be
deleted. A bulk action removes finished Subagents, which means Threads whose
whole subtree has stopped: a finished parent with a running child is never
swept, because deletion cascades, and neither is a child holding queued work,
because idle is not finished — work already handed to it has not run yet. Both
deletions are confirmed first and re-decided against a fresh read at the moment
they are confirmed, since deletion force-stops a live subtree and cannot be
undone.

Forks remain top-level user
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
  status plus direct argument/result data. Its readable act may use type-specific
  presentation fields, but the Arguments detail and copy source only the Item's
  `modelCall` envelope: exact inline arguments, marked redacted arguments, a payload
  resolved on demand by main, or bounded rejection evidence. The renderer never renders
  a payload-reference stub as if it were arguments. Expansion and Turn copy request the
  exact authorized payload, then bound its renderer-facing value to 32,000 characters
  before caching, formatting, syntax highlighting, or copying. Inline values that fit
  the 32 KiB storage contract remain complete even when pretty-printed JSON is longer.
  While a payload read is pending, missing, or mismatched, the disclosure and Turn copy
  show the same typed unavailable value. Neither surface falls back to presentation
  fields or a payload-reference identifier. Host
  execution metadata such as command `cwd` is labelled separately and never appears as
  a model argument. Structured arguments and results render as their JSON rather than a
  second presentation model. `bash` is the deliberate exception to JSON argument rendering:
  its expanded input shows the envelope's `command` as copyable shell text with bash
  highlighting, while optional fields remain available through canonical diagnostics.
  Presentation Item construction receives the complete transient redacted argument
  structure and applies bounds to each stored display field, so a large `file_write`
  retains its path even when content moves to a payload. Command output,
  file interaction, copy actions, and image previews retain their native
  affordances; a successful shell exit code is redundant with the completed row
  and stays hidden, while a non-zero exit code is rendered as an explicit failure
  explanation. A failure that never produced an exit code — a timeout, a kill —
  keeps a null code and says only that the command failed; the renderer never
  borrows a plausible code the shell did not report. Every other tool failure
  surfaces its own message, or, when it has none, states plainly that it failed
  without one; failure prose is never presented under a neutral result heading
- a command row is labelled by the **caller's own description** of the command
  when there is one. The `bash` contract already requires a one-line account in
  active voice, so the transcript states intent rather than shell syntax, and
  three identical `python3 - <<'PY'` heredocs read as three different acts.
  Because that description displaces the shell text, the row's title always
  carries the command itself: the description is the caller's *claim*, the
  command is what actually ran, and a transcript must never let the claim stand
  alone. The command is also one expand away under Arguments
- `description` is optional on the Item, and Items persisted before the field
  existed decode with a null description rather than failing. When it is absent
  the row falls back to the command text with the parts that are provably not
  the point removed — a heredoc body, a leading `cd X &&`, and the Thread
  working-directory prefix — so the label's budget is spent on the operative
  text. Those removals are deliberately narrow: a heredoc opener is recognised
  only as `<<WORD`, never a here-string or a bit shift, and a root working
  directory has no prefix worth stripping. The renderer does not otherwise
  interpret shell syntax
- a tool row keeps its own tool-type icon in every terminal state, so a broken
  row still says which tool broke; only the running state substitutes a glyph,
  because there the spinner *is* the state. Status is carried by colour on that
  glyph plus the label — failure tints both with `--status-danger`, an
  interrupted row is muted rather than alarmed — and the label wording always
  names the state, so no row encodes status by colour alone. The status colour
  rides on the label and never becomes a fill, ring, or second slot geometry, and
  it persists through hover, focus, and expansion instead of being swapped away
  by the disclosure chevron. A running row likewise keeps its spinner through
  hover, focus, and expansion, and a group only ever animates its own glyph, not
  the finished children inside it. The indicator is decorative to assistive
  technology: the label text and `aria-expanded` carry the state
- a tool row says **what the agent did**, in the user's terms, and never shows a
  model-facing tool identifier for a tool the renderer can map: built-in tool
  calls resolve to one shared activity vocabulary, and the identifier survives
  only for an MCP or plugin tool where the name genuinely is the most
  informative thing known. Single rows and counted groups derive their wording
  from that same vocabulary, so a lone call and a group of one read alike
- a row names its subject wherever the call carries one — the file's basename,
  the Node's title (resolved like any Node reference, falling back to the id),
  the search pattern or query, the fetched URL, the Skill — and a summary names
  up to two subjects before eliding ("Read intro.xhtml, ch01.xhtml and 4 more");
  the row's title re-derives the same summary with no elision, so the names the
  label could not fit stay one hover away. A subject phrase drops the redundant
  noun, because the subject already supplies it. When only some of a bucket's
  subjects are nameable, the summary counts instead of naming: a partly-named
  summary would read as if the unnamed work never happened
- terminal status is **one** idiom for every tool kind — the act, then the
  outcome as an annotation (`Read intro.xhtml · failed`) — rather than a
  per-kind failure sentence. A scanning user learns the pattern once. The act
  and the outcome are separate elements: the act ellipsizes when the pane is
  narrow, the outcome never does. A truncatable outcome would leave a failed
  row asserting the act succeeded, and would strip a collapsed group of its only
  failure cue
- every tool a row can show resolves to a **distinct** glyph, judged at the
  14px the transcript actually renders: opposite actions never differ by a
  single stroke (file delete is an X, not a minus beside create's plus), a
  connected MCP tool never wears the unknown-tool fallback glyph, and a fetched
  page is not drawn as a document; a group's glyph is the same size whether its
  members agree on a tool or not. Glyph choices app-wide remain
  `docs/plans/icon-semantics.md`'s; these tool-row rows are recorded there
- a counted activity group summarizes mixed outcomes, so it is **not** painted by
  its worst member: its glyph and its activity phrase stay neutral, and only the
  appended tally of what went wrong ("Ran 3 commands · 1 failed · 1 interrupted")
  carries status colour — the failed count in `--status-danger`, the interrupted
  count muted. Colouring the whole line would say every call in the group failed
  when one of them did. The group's own status class still drives the running
  spinner, and each member row inside carries its own status treatment
- bounded tool-result projections render immediately; expanding a row resolves
  its content-addressed `outputRef` once and replaces the projection with the
  full text, while copied Turns use the same full result
- file-change results reuse the shared local-file preview affordance and expose
  the established Add to Today action without introducing an artifact DTO
- every ordinary tool, including a loaded or isolated Skill, uses the same
  expandable row inside the counted activity group; tool-specific icons,
  summaries, images, and child-Thread links remain supplemental affordances;
  tool images resolve from their stable `artifactRef` through the owning Thread. Preview
  selects the original first and observation second, then serves a disposable stable
  extensionless materialization with MIME derived from its bytes. The renderer never
  receives a canonical payload path or chooses a rendition itself. Add to Today sends
  the same typed identity to a main-only ingest seam, which reauthorizes ownership and
  returns asset metadata without accepting or returning a managed path
- local paths in tool arguments and results retain the surrounding terminal-style
  code rendering: no file icon, resting background, independent wrapping, or
  ordinary-click navigation. Holding the platform primary modifier reveals the
  path link affordance, and Cmd/Ctrl-click follows the global new-pane navigation
  meaning; keyboard focus plus Enter opens in the current pane. The shared
  inline-file hover preview, right-click context menu, and title tooltip still
  attach through the same delegation attributes. Absolute paths link directly,
  while relative values in path-bearing JSON fields resolve against the Thread
  working directory; glob checks apply only outside declared path fields. Glob
  expressions and URL text are not treated as concrete local paths, and
  main-process preview checks remain authoritative
- collaboration Items and Subagent activity link directly to their canonical
  child Thread. Every delegated form is projected the same way, including an
  isolated Skill child, whose row is the parent's only live signal that a
  delegated agent is working while its `skill` call is still in flight. A row
  records which form it describes: a wait counts only collaboration children,
  and a collaboration tool row is accountable only for those, so a Skill child
  is never counted as work the parent is waiting for. Within one parent Turn,
  all `subAgentActivity` Items for the same
  child collapse into one presentation row at the first Item's position. A
  terminal activity Item is authoritative; otherwise the row combines the
  Thread catalog with the latest canonical child `turn/started` or
  `turn/completed` DTO retained by `threadStore`, even when that child's paged
  history is not loaded. This lets a running row show elapsed time and flip to
  completed, interrupted, or failed as soon as the child Turn notification
  arrives, without waiting for the parent activity queue to flush. A catalog
  reload drops the latest-Turn cache entry for a ROOT it no longer returns, and
  subtree deletion drops the whole subtree's entries; a child's absence from a
  root-only list is not evidence about the child
- Subagent rows use task-path identity first, then nickname, Role, and finally a
  shortened Thread id. Running copy is `Started subagent <name>` plus elapsed
  time when known; idle remains distinct from completed. A failed row exposes a
  bounded user-facing error and tints its glyph and label with
  `--status-danger`; interrupted and unavailable rows stay muted. These colours
  survive hover and focus, and every status is also named in text and accessible
  labels
- persisted collaboration result snapshots contain, per child, `status`,
  `taskPath`, `nickname`, and `role`. Spawn and wait rows render those identities
  through the same live projection instead of treating the persisted status as
  current truth. The snapshot remains available in expanded result JSON and in
  Turn copy after a child is deleted. Renderer user surfaces never resolve a
  collaboration Item's raw `outputRef`, because the model-facing result also
  contains internal budget receipts; they expose only the typed snapshot
- Memory used by an answer renders through the ordinary inline Node-reference
  affordance next to the supported claim; `node_search` and `node_read` remain
  in the process and Turn Diagnostics, with no separate Memory Item or disclosure
- context evidence stays hidden from the ordinary transcript; `contextReset` and
  `contextCompaction` render dedicated `Context cleared.` and compaction boundary rows
  at their exact canonical positions. A completed standalone `/clear` or `/compact`
  feature Turn exposes Turn Diagnostics from that boundary and does not synthesize an empty
  response row with Copy or Continue-in-New-Chat actions

While at least one child spawned by a Turn is still alive, that Turn's process
block carries a live delegation card: one line per delegated child, in canonical
order, with a readable name, live status, elapsed time, and a terminal glyph as
each settles. The card is the per-child presentation for as long as it is up, so
the projected activity rows for those children stand down and return as the
post-hoc rendering once the last child settles. Every delegated form is listed —
an isolated Skill child is delegated work too — and membership is the Turn's
projection rather than a second split by source. Each running line exposes Stop,
and so does the header of a child Thread view while its Turn is active. Like
every delegation surface the card speaks time and status only: no token quantity
reaches its text, its title, or its accessible labels, and a failed line carries
the same bounded, code-classified copy the rows use. There is no dock-level
agents panel; cross-thread awareness is the Thread list's activity indicator.

A completed Turn with a final answer and known duration folds its process Items
under the established `Worked for ...` disclosure while leaving the answer
outside the fold. Live and resultless process timelines remain visible; a live
timeline uses the established `Working` / `Working for ...` status row even
before its first process Item arrives. When `collaboration.wait_agent` is the
only in-progress tool and at least one projected child remains active, that row
instead reads `Waiting on N subagents` plus the same live elapsed time. A
receiverless wait does not count as an additional agent; the count is the
distinct active child Thread identities in the projection. Rendering builds one
Turn-level process projection from every reasoning, commentary, image-view, Subagent, and
tool Item. That block is placed before the first final response regardless of
the Items' persisted arrival order, so a late reasoning Item cannot appear
below the answer. The process disclosure contains the independent reasoning,
activity-group, and tool detail disclosures rather than replacing them.
An empty process does not render an empty timeline container. The status line,
separator, visible timeline, and following answer use the same tokenized
vertical interval on either side of the separator. Within the timeline, the
reasoning headline, expanded reasoning body, and adjacent compact process rows
use one shared tokenized interval; expanding reasoning does not introduce a
tighter headline-to-body step than the surrounding row rhythm.

The status line never claims more than the run is doing. A settled Turn is
described in the past — it never falls through to the live `Working` label —
and when a Turn is **blocked on the user** (`waitingOnUserInput`) the line says
so and the spinner stops, because a spinner claims work is happening. The
elapsed time is deliberately **not** adjusted: it is wall-clock since the Turn
started, the same span the server records as `durationMs`, so the live label
and the settled one measure the same thing and cannot contradict each other.
The wait is named rather than subtracted. Exactly
one element owns a Turn's terminal status, and something always does: the
divider states it when there is no final response **and a process block
actually renders**, and the synthetic response tail then shows actions only.
A Turn with no process Items renders no process block at all, so there the tail
keeps the status. When the tail owns it the divider is suppressed, but the
timeline still keeps a neutral, status-free header rather than becoming an
unlabelled list of rows.
Counted activity reports finished and in-flight work separately — "Read 5 files
· reading 1", never one present-tense count covering work that has already
finished. A reasoning disclosure that opened by default **latches** open for the rest of
the session: the default is otherwise recomputed each render from live state,
so a newly arriving Item retracted it and snapped the disclosure shut mid-run,
shifting the layout under the reader. An explicit collapse is recorded and
still wins over the latch. The latch is Thread-session state, not a persisted
override — it survives a Turn row unmounting to virtualization, and a reloaded
transcript rests at the settled default rather than permanently expanding every
reasoning Item a reader once watched live. The
empty placeholder carries the same classes as the populated one so the first
token does not restyle the element. The reconnect
banner honors `prefers-reduced-motion` and is cleared when a new Turn starts or
the Thread list reloads, so it cannot outlive the attempt it describes.

An active Turn ends with one rose shape indicator after all currently visible
process and response content. It is the stable generating affordance for both
empty and streaming responses; Markdown does not add a second caret. The
indicator occupies the same persistent response-footer slot as the terminal
Copy, Continue in new chat, and Details controls, and swaps to those controls
without moving the response. User-message actions likewise fill a persistent
slot that remains empty and non-interactive while the Turn is live. The indicator
stops animating under reduced-motion preferences. A failed or interrupted Turn
with partial response prose keeps its process presentation neutral because the
response tail already owns the terminal error or stopped state.

Unknown Item kinds are protocol errors, not generic fallback cards. Item status
comes from the Item itself; the renderer never infers completion from missing
events.

Agent Markdown reuses the shared read-only code surface and dual-theme Shiki
highlighter. Stable completed blocks are memoized; only the final streaming
block is repaired and rendered live, with text commits throttled so token deltas
do not rerender the complete response. Every block keeps the same memoized React
component identity as the final streaming block seals. Node and local-file
reference markers render through the same inline reference and preview surfaces
as the outliner; Cmd/Ctrl-click preserves new-pane navigation, and HTTP links use
the app preview route. User messages retain Copy and, for the latest terminal
Turn only, Edit; final agent messages retain Copy, Continue in new chat, and
Details. User messages that exceed five reading lines retain the established
measured Show more / Show less disclosure instead of
growing the transcript without bound.

User-message rendering is a presentation projection over canonical
`ThreadUserContent[]`; it does not claim to show provider part order. Every image
attachment in one message is collected in canonical image order into one leading
gallery. Every attachment, including each gallery image, also retains its inline
file reference in the following narrative at its canonical position. The reference
is not duplicate decoration: it exposes the same attachment identity and readable
path represented by the provider-facing `[[file:...]]` marker, while the gallery is
only a visual preview. Text, Node references, directories, and file references form
one narrative bubble in their original relative order. Structured user messages use
the same block inline flow, whitespace preservation, and overflow wrapping as the
composer within the established user-bubble measure, so references and adjacent text
wrap naturally instead of being laid out as separate transcript rows. The gallery uses dedicated
layouts for one, two, three, and four images. More than four images initially
show four thumbnails with a `+N` control; expanding shows every image and adds a
collapse control. The overflow control is a compact bottom-right media-HUD badge:
it uses the shared fixed-contrast palette and compact inset outline over arbitrary
image pixels, exposes rest/hover/active/focus feedback, and does not add a
backdrop filter or the file-preview action shadow. The ordinary file reference
retains its Thread-scoped preview identity without a second attachment-card
wrapper; every gallery tile retains the same scoped identity and opens the shared
reader. Image attachments resolve through their artifact's original-then-observation
fallback without changing the attachment's canonical file identity; an unavailable
rendition leaves the rest of the message usable. Replay, fork, context projection, and
Model Interactions consume the
unchanged canonical ordering rather than reconstructing attachment placement from
this presentation projection. Free-text editing is exposed only when
canonical content contains at most one text part, and replacement preserves every
non-text part in place. A split-text mixed message omits Edit until a structured
content editor can represent each text boundary without flattening the sequence.
The single narrative bubble keeps the five-line measured disclosure, so the
collapse mask never crops gallery content.

Copy on a user message serializes that complete visible narrative in canonical
order: authored text remains unchanged, attachments contribute their stable file
names, directly adjacent attachments receive one presentation space for readability,
and Node references contribute their current display names. The visible narrative
uses the same adjacent-attachment separator, without changing canonical content. Copy
does not include the presentation-only gallery or claim to reproduce the provider
request. Execution-lifetime managed-resource paths are never invented in renderer
copy; the Model Call export remains the authority for the recorded provider payload.

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

Subagent token limits are system internals. Stable admission- and mid-Turn-budget
errors carry `subagent_budget_exhausted`; renderer surfaces classify that code rather
than model-facing copy. They translate it before transcript display or copy into
localized resource-limit copy that says produced results were preserved. The same
translation applies in Turn Details and structured Automation run errors. Token counts
never render on these user surfaces. For a budget error, Turn Details omits the
canonical error `detail`, replaces a Subagent activity's raw error record with
the localized record, and does not resolve collaboration raw output; this holds
inside the lazy Canonical Items disclosure as well as the default Summary.

Copy on a response copies the complete assistant side of that Turn in order:
commentary, tool arguments, full tool results when available, and
the final response. Tool arguments use the canonical envelope and never reverse-map
command, file-change, MCP/dynamic display, collaboration, or result fields. A partial
failed response remains the copy authority; its
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
Each tool entry exposes its recorded admission disposition, canonical identity, and
admission-time schema digest when present. Those are historical facts rather than a
revalidation against the currently loaded tool catalog. Rejected admission is labelled
argument/tool admission, never permission denial; a later capability-unavailable result
remains a separate execution fact.
The timeline expresses hierarchy with disclosure indentation and horizontal activity
separators only; it does not draw a vertical guide-line axis through nested content.

Request first renders the content-bearing fields from the final post-adapter **Provider
Request** observed immediately before transport. Stable provider parameters such as model,
streaming, output limits, reasoning options, and tool-selection controls stay out of the main
content flow and appear in the Model Call information surface and copied Model Call export.
Provider fields preserve top-level insertion order only as a serialization fact; they receive no
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
the same call's copy action. The recorded pre-adapter Model Context remains available in that
export in semantic order: System Instructions, Tool Definitions, then Messages. It is nested
under Request as Tenon's adapter input, not presented as a second transport payload. The main
Request/Response reading flow contains no parallel raw-JSON, pre-adapter, or metadata
disclosures; the semantic Provider Request Content and Model Response are the only peers.

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
HTTP timing/status/request ID, token budget, common-prefix count, provider parameters,
stop reason, provider-reported token/cache/reasoning usage, calculated cost, and normalized
error on hover or keyboard focus. The adjacent copy control materializes one typed Model Call
diagnostics export only when invoked. It contains runtime selection; Request with the complete
recorded Model Context, ordered image-sanitized Provider Payload, and Request Facts; and
Response with allowlisted transport facts plus the provider-neutral normalized model response,
usage, stop reason, and error. A limitations object states that image bytes are omitted with
length/digest markers and that secret headers and the raw provider response body were not
recorded. The export does not claim to be a byte-for-byte HTTP exchange.
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
The same IPC method may read payload-backed tool arguments only when main derives the
requested reference from that exact Item's canonical `modelCall`; another Item or digest
is rejected. Renderer caching keys the immutable Thread-owned payload identity and stores
only its bounded display projection. New argument-bearing views consume the required
canonical envelope. Diagnostics and exports show
only structured secret-redacted values and RFC 6901 redaction paths; they never reveal a
raw model-authored secret or host-injected credential.
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

Model selection is model-first. The list is flat: the model name leads each row,
and the provider appears only as a secondary origin label, only when more than
one provider is listed, and never as a group heading or a raw provider ID. The
listed providers are the usable ones plus, when the Thread is pinned to a
provider that is no longer usable, that provider. The Thread's own provider is
listed first, the rest follow the preferred provider order, and models keep the
catalog order, which main has already ranked newest-first. Providers survive as
a truncation unit — each keeps its own "show all" budget, that expander names
its provider whenever origin labels are shown, and a pinned model outside the
window stays visible.

The list leads with a floating selection that follows the connection's newest
model. Choosing it writes only the model field, as the `inherit` sentinel; the
Thread's provider is never rewritten, so the selection cannot move a Thread to a
different connection. It is offered only when that connection resolves a model,
since the sentinel is otherwise unsatisfiable. Because main validates the
sentinel by resolving it, the submitted reasoning effort is clamped against the
model the sentinel resolves to — the connection's head, not the model being
un-pinned, which is a different model whenever the Thread is pinned at all.

A pinned selection is reported verbatim, including a model id stored without a
`providerId/` qualifier; it is never replaced by the connection's head, which
would name one model while the runtime ran another. Only a floating selection
resolves to the head.

The chip and the parent menu row name the model that will actually run in either
state. Only the check mark distinguishes the two, and it is placed from the
stored value rather than the resolved one — a floating selection resolves to the
same model an explicit pin to the newest model resolves to, so inferring the
state after resolution would make the two indistinguishable and strand a Thread
on a model it never chose to pin.

Reopening the Agent rail restores focus to the composer of an editable Thread.
An active `request_user_input` keeps focus in its current step instead; opening
the rail never steals focus from that blocking form.

Within an editable Thread the composer is also the pointer's default focus
target ("terminal model"): a mouse click anywhere in the thread view that is
not claimed by anything hands focus back to the composer, so transcript
blank space and one-shot actions (copy, fork, disclosure toggles, details)
never strand focus outside the input. A click is claimed by a typing surface
(inputs, `contenteditable`), a link or Node reference (attention moves to the
document or an external browser), a text selection the user still needs for
copying, or any surface that installs its own focus target within a frame of
the click (self-focusing popovers, dialogs, the inline message editor).
Keyboard-activated clicks are never intercepted, and an active
`request_user_input` suspends the hand-back entirely.

Typing `/` opens the established composer command menu. It keeps `/compact` as
the default entry, followed by `/clear` and `/new`, then appends the current
user-invocable Skill catalog. Runtime names are reserved case-insensitively, so
a conflicting Skill entry is omitted rather than rendered as an unreachable
duplicate. Filtering ranks label matches ahead of description-only matches.
`/new` and `/clear` insert their complete command; an exact-cased complete token
closes the menu so the next Enter submits it. `/compact` inserts a trailing
space for optional instructions. A case-variant query remains in the menu, so
Enter accepts the selected canonical command text and waits for a subsequent
submission. Skill entries insert `/<skill> ` without flattening other structured
composer content. A direct Skill invocation without attachments is resolved by
the Turn's Skill runtime before the model prompt is sent; the canonical
userMessage Item retains exactly what the user submitted.

Submitting `/new` as the exact trimmed text with no attachments, Node
references, file references, or other structured content routes to the same
dock-owned `thread/start` action as the Thread list. It creates and selects one
root user Thread, focuses its empty composer, and starts no Turn. The prior
Thread remains intact; an active prior Turn continues in the background without
an interrupt or steer request. Thread creation uses the list action's
any-usable-provider gate, pending guard, and dock error presentation rather than
the selected Thread's send gate. A failed creation keeps the old selection and
the `/new` draft and restores focus only after the pending disabled state has
cleared. A keyboard submission blocked by the provider gate shows the existing
provider-required copy inline. Structured content accompanying exact `/new`
blocks both Thread and Turn creation, preserves the complete draft, and shows
inline validation until the user removes that content or edits away from the
command.

`/compact` and `/clear` are recognized only as the sole text part and require an
idle Thread; they create completed feature Turns without sending a user message
or launching the model. A case variant submitted without accepting its canonical
menu completion, `/new` with additional text, messages with attachments that are
not exact `/new`, and unknown slash text remain ordinary Turn input.

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

The transcript follows streaming output only while its visible follow state is
within 56 pixels of the bottom after a user or programmatic scroll. While follow
is active, a canonical Item-count increase pins from the content layout commit,
so the new row and its final bottom-followed position paint together rather than
moving the existing transcript one frame later. Other Turn updates, non-Turn
transcript content, transcript viewport changes, and composer-region height
changes coalesce through one frame-level bottom pin. The structural path yields
to pending send and explicit disclosure anchors. Moving upward releases follow,
so later Item updates never pull the reader away from earlier evidence. A visible
Jump to latest material pill appears only when follow is inactive and content
remains below the viewport; activating it returns to the bottom, re-engages
follow, and restores composer focus.

Starting a new Turn first moves to the existing tail for immediate feedback. Once
the accepted user message mounts and measures, that message is anchored at the
transcript top inset and follow is re-derived from the resulting position. A long
conversation therefore streams below the anchored message without moving it;
short conversations that are still within the bottom threshold continue
following. The existing `turn/start` response identifies the exact accepted Turn,
so a concurrently loaded history page cannot be mistaken for the new send.
Steering an existing active Turn keeps the bottom-follow path. The renderer does
not insert an optimistic user message or alter notification order.
A temporary renderer-only tail spacer gives the new message enough scroll runway
to reach the top before response content exists. It carries no document state,
shrinks as real response content replaces that runway, and is removed when no
runway remains or the reader jumps to the latest content. Spacer-only runway does
not count as unread content for the Jump to latest control.

Each Thread keeps an ephemeral scroll snapshot across Thread switches. Returning
to a Thread waits for non-empty loaded history, then restores the prior position
or the nearest reachable offset when viewport or history changes made the exact
offset unavailable; empty history never replaces the saved snapshot with a top
clamp. User scrolling takes ownership and cancels the pending restore. A failed
send restores the pre-send position and follow state. A followed Thread continues
at the bottom. Threads above forty Turns reuse the established
measured-row virtual transcript with viewport overscan; terminal offscreen Turns
do not remain mounted. When a row fully above the viewport replaces an estimate
with a measurement, its height delta is applied after the virtual container
commits the corresponding total-height change, so browser clamping cannot discard
the compensation and the visible reading position remains stable. Measurements
ignore subtrees currently skipped by `content-visibility: auto`, preventing its
intrinsic fallback size from entering the measured-height cache. The same
content-visibility containment applies from a Turn's first render through its
terminal state, so completion never swaps a measured live height for an intrinsic
fallback.

Provider request and stream retries are transient execution state, not Items.
The selected Thread shows the established live reconnecting row while retrying
and removes it when the provider recovers or the Turn becomes terminal.

`update_plan` is an ordinary tool call and is recorded like any other: the
session shows the complete, actual process, so a Plan update the agent
performed appears in the transcript, in counted activity groups, in Turn
Diagnostics, and in history after a reload. It is worded as the act — "Updated
the plan", collapsing to "Updated the plan 3 times" in a group — never as
`Used update_plan`, and carries its own glyph. This deliberately reverses the
transient exclusion from `agent-execution-interaction-consistency` (#438),
which left the model visibly deliberating about a tool that never appeared to
run; see `docs/plans/archive/agent-plan-visibility.md`.

`turn/plan/updated` remains the pill's ephemeral fast path, not an Item. The
selected Thread keeps only the latest snapshot for its active Turn and shows it as a
compact pill, horizontally centered above the composer. The pill's persistent
affordance is **the current step's text**, not a bare counter: `2/5 · Draft the
summary`, ellipsized to one line, on a fixed single-line height so it never
reflows the composer. A Plan whose every step is complete reads as complete
rather than as its last step. The current step is the first `in_progress` step,
then the first `pending` one.

The pill also renders on a Thread that has **no composer** — a watched child or
automation Thread — because `update_plan` is `anyThread`-scoped and such a
Thread has a Plan to show. It is equally interactive there; only the focus
destination differs, since there is no composer to return to.

Hover previews the complete checklist; activating the summary opens the same
scrollable checklist and moves keyboard focus into it. The current step is
marked by weight and text colour rather than by the spinning icon alone, whose
cue disappears entirely under reduced motion; completed steps stay dimmed. Step
rows carry their status as text for assistive technology, since the icons are
decorative, and the live announcement includes the current step's text rather
than only a counter. Deliberately closing it — Escape, or re-activating the
summary — restores focus to the composer: the Plan is a status affordance, not
a destination to be stranded in. On a Thread with no composer that focus
returns to the pill, never to the document body. Closing by blur moves focus
nowhere, because the blur already took it somewhere the reader chose. Steps
render at the transcript's own text scale. A
replacement snapshot overwrites the prior one;
terminal completion, failure, interruption, Thread deletion, catalog reload,
or application restart removes it. The pill is the Plan's *content* surface —
the current step — and does not replace the record that the tool ran.

Process, reasoning, tool-group, and tool-detail disclosures keep per-Thread UI
overrides in versioned local storage. Their keys use canonical Item identities;
switching Threads, streaming-to-terminal remounts, and application reloads do not
discard an explicit user choice. A live reasoning Item is open while streaming.
A terminal reasoning Item rests folded unless it is the only process Item in a
Turn without a final agent response, in which case it opens by default. Expanding
or collapsing any explicit transcript disclosure preserves its activated surface's
viewport position. This includes the persisted process, reasoning, tool-group, and
tool-detail disclosures as well as measured long-user-message and image-gallery
controls. The activated anchor owns that layout transaction while delayed
measurements settle, so frame-level bottom follow yields instead of moving the
surface the user just activated. The image gallery anchors its persistent container
because the `+N` control unmounts when the full grid replaces it. Follow is derived
from the resulting geometry after the anchor settles rather than released by the
toggle. Capture starts its fallback restore loop immediately, so an owning row that
unmounts before its layout effect cannot latch the transcript. Bottom-follow work
caused by canonical Turn changes is replayed after release, while disclosure-only
ResizeObserver work is discarded because replaying it would move the activated
surface. If growth above the activated control needs more scroll range than the
transcript naturally has, a transient renderer-only tail runway supplies exactly
the missing range. It is excluded from real-content metrics and is consumed by a
collapse when geometry permits, later content, or independent scrolling. A
bottom-clamped collapse that removes content below its control may itself need this
temporary range to keep the control fixed; the range remains only until content or
navigation can consume it. An asynchronous tool-output read holds that anchor until
the expanded content lands, with a three-second safety bound so a lost reply cannot
latch scrolling. Wheel, pointer, touch, keyboard, or independent scroll intent still
cancels the pending correction immediately. Sending or choosing Jump to latest
explicitly supersedes the anchor; pending send-anchor layout otherwise resumes on
release. Virtual row compensation yields while the explicit anchor is active,
because that anchor is authoritative for concurrent geometry changes.

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
