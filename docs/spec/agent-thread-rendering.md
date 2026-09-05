# Agent Thread Rendering

Main owns canonical Thread DTOs. Before Agent Core responses and notifications
cross main-window IPC, an exhaustive projection replaces only payload-backed
model-call arguments with the renderer-private `{ storage: 'itemBound' }` marker;
context references, internal-text references, and binding paths never enter the
renderer. There is no second event model or UI-only execution model.
Presentation-only reductions may collapse append-only Items or select the latest
projected canonical DTO, but never invent execution state or write it back as
history.

## Surface Structure

The dock has three stable regions:

1. A root Thread list with selection, creation, details, rename, fork, and delete actions.
2. A scrollable Thread view containing ordered Turns and Items.
3. A composer for starting, steering, or interrupting the active Turn.

The Thread list contains user conversations and other explicitly visible root
Threads. Delegation Threads use `threadSource: "delegation"` and are filtered at
the main-owned catalog boundary, so they never consume a keyset cursor slot,
appear in navigation, or enter the renderer Thread map. The renderer has no
Agent tree, child navigation stack, delegated transcript, or descendant-running
indicator.

The selected root's own foreground Turn state is visible in its transcript and
composer. Background Bash work, including delegation CLI invocations, appears
through the generic Tool Task strip. The strip is a projection of Tool Task
records and never reconstructs status from command Items, process output, or
Agent Session state.

Agent answers use one conversation presentation resolved for the owning root
Thread. The presentation supplies a persona and palette colour only; it does
not identify an Agent type or execution policy. Reader-authored messages retain
the right-hand reader bubble. Host and feature-authored messages use neutral
machine presentation and never borrow reader provenance.

Delegation completion is ordinary Tool Task delivery to the root. The result may
contain a Session handle for later CLI continuation, but no delegated speaker,
Agent badge, report card, chip, or hidden Thread content is rendered. The root
reads the untrusted command result and produces the user-facing synthesis.

Thread Details remains limited to the durable visible Thread container, its
model selection, Memory setting, and Thread-level controls. Trajectory remains
the technical view of the selected visible Thread; hidden delegation Threads
are not renderer-addressable.

## Item Rendering

`ThreadItemView` switches exhaustively on the canonical Item discriminant:

An active Turn preserves canonical Item identity across streamed deltas. Its
content grouper compares Item references pairwise, rebuilds structure when an
Item changes rendering role or order, and otherwise replaces only the affected
item or process block. Turn actions keep stable callbacks keyed by Turn ID and
read the current Turn through a ref. The Agent registry is identity-preserving
by contract: a streaming delta replaces exactly one Turn object and touches no
execution record, so every anchor set and every field-equal registry entry comes
back by reference. Anchors are memoized on Turn identity, which is the exact
invalidation signal. `ThreadItemView` and consecutive tool groups are memoized
against those stable inputs, so a response delta does not render unrelated
transcript Items again.

Elapsed ticking is LEAF state. The 1 Hz clock lives in the component that
displays the value — the chip, the strip row — including its accessible name and
title, so an open Agent transcript is never re-rendered once a second by a
counter above it. A Turn reads Agent liveness through a set of working Agent
IDs that changes only when an Agent starts or stops working, which is exactly
when motion ownership can change; per-Agent status and elapsed changes never
reach it.

- user and agent messages render readable text at the same content register as
  the outliner
- reasoning places a compact summary of its first visible Markdown block
  directly in the process timeline, without a `Thinking` / `Thought` prefix
  once content exists. The summary is derived from parsed Markdown rather than
  by cutting the source at a physical newline, and literal text such as glob or
  multiplication asterisks is never stripped. A leading paragraph or heading is
  carried whole by the summary line — flattening it loses inline formatting, not
  words — so expansion reveals only the remaining content and never repeats the
  headline. It is not carried whole when it holds a link, an image, or a Node
  reference: what flattening drops there is the target, which a summary line can
  neither show nor open. That block, and any structural leading block (fence,
  list, table, quote) whose summary is one line of itself, keeps expansion
  rendering the complete canonical source, so fences, lists, tables, links,
  references, and inline code remain intact. A compact summary that fits the available width is plain text
  with no disclosure affordance. A visually truncated summary becomes a
  disclosure whose expansion wraps it in place. Its first width read also runs
  when the disclosure mounts with an expanded override; streaming updates
  coalesce later reads by frame and reuse one `ResizeObserver` while the
  disclosure remains folded. A folded disclosure keeps its chevron hidden at
  rest and reveals it on hover or keyboard focus without changing row geometry;
  an open disclosure keeps the chevron visible. An empty live Item retains the
  `Thinking` placeholder and marks only that placeholder with `WorkingText`;
  once readable reasoning arrives, the streamed content remains static
- consecutive command, file, MCP, dynamic-tool, Agent-task, and search Items
  form one counted activity disclosure without creating another data model
- each tool row derives a readable summary from its canonical fields and exposes
  status plus direct argument/result data. Its readable act may use type-specific
  presentation fields, but the Arguments detail and copy source only the Item's
  `modelCall` envelope: exact inline arguments, marked redacted arguments, an Item-bound
  marker resolved on demand by main, or bounded rejection evidence. The renderer never
  receives or renders a payload-reference stub as if it were arguments. Expansion and
  Turn copy authorize the enclosing `(threadId, turnId, itemId)` through
  `thread/item/arguments/read`; main verifies and projects the complete value to at most
  32,000 characters before it crosses IPC. Inline values that fit
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
  affordances. An expanded detail is a list of labelled sections and nothing
  else. The input section is headed `Arguments` for every tool including `bash`:
  it holds what the model REQUESTED, and that provenance — not its content — is
  the load-bearing fact, so rendering shell text with bash highlighting stays an
  exception in rendering rather than one in labelling. The produced-value
  section's heading is the outcome — `Output`, `Result`, or `Error` — and
  carries status colour when the production failed. A non-zero shell exit code qualifies that heading
  (`Output · Exit code 2`), because the code explains the output it sits above.
  A successful code is redundant with the completed row and stays hidden, and a
  failure that never produced one — a timeout, a kill — gets no invented number.
  A tool that failed with its own message shows that message AS the produced
  value under the `Error` heading, the same precedence the Turn copy source and
  the persisted output payload use; failure prose is never presented under a
  neutral result heading. The heading names the CONTENT — `Error` only where the
  content is an error payload — while the status colour carries the failure, so
  a failed Agent-task call reads `Result` in danger red over its state
  snapshot. A call that produced nothing has no such section at all, failed or
  not: an exit code cannot outlive the output it qualifies, because both are
  written from the same tool envelope in one step, and a call cut off by an
  interrupted Turn was silenced rather than silent — the row's own failed
  segment is the whole statement there. The detail never adds a sentence
  restating a failure the row already reports
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
- a tool row keeps its own tool-type icon in every state, so a running or broken
  row still says which tool is involved. While running, only the neutral action
  segment uses `WorkingText`, and that segment keeps the same `--text-soft`
  resting colour and 400 weight as its terminal state so the sweep remains
  visible and settling does not change glyph metrics. When reduced motion or
  increased contrast removes the sweep, the running row deepens only its
  neutral semantic glyph to `--text-soft` while a completed sibling keeps
  `--text-faint`; the action text retains the same colour, weight, and geometry;
  a caller-authored command description remains exact rather than being rewritten
  into progressive copy. Failure still tints the glyph plus label with
  `--status-danger`, and an interrupted row is muted rather than alarmed. The
  label wording always names terminal state, so no row encodes status by colour
  alone. Status colour never becomes a fill, ring, or second slot geometry and
  persists through hover, focus, and expansion. The semantic glyph uses the
  ordinary disclosure-chevron handoff instead of doubling as a spinner. Both
  glyph layers are decorative to assistive technology: the label text and
  `aria-expanded` carry the state
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
  when one of them did. A collapsed running group applies `WorkingText` only to
  its neutral summary. Expanding it freezes that summary and mounts each member's
  own treatment, so only in-progress members move; collapsing transfers motion
  back to the group summary in the same render. Finished members remain static
- bounded tool-result projections render immediately; expanding a row resolves
  its content-addressed `outputRef` once and replaces the projection with the
  full text, while copied Turns use the same full result
- file-change results reuse the shared local-file preview affordance and expose
  the established Add to Today action without introducing an artifact DTO
- every ordinary tool, including a loaded Skill, uses the same
  expandable row inside the counted activity group; tool-specific icons,
  summaries, and images remain supplemental affordances;
  the row reads family-owned private details and canonical output references,
  never reparses the compact model-visible result header as UI state;
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
- Memory used by an answer renders through the ordinary inline Node-reference
  affordance next to the supported claim; `outline` shell calls remain in the
  process and Trajectory, with no separate Memory Item or disclosure
- context evidence stays hidden from the ordinary transcript; `contextReset` and
  `contextCompaction` render dedicated `Context cleared.` and compaction boundary rows
  at their exact canonical positions. A completed standalone `/clear` or `/compact`
  feature Turn opens Trajectory focused from that boundary and does not synthesize an empty
  response row with Copy or Continue-in-New-Chat actions

### Background Tool Tasks

A root Thread's background Tool Tasks appear in one generic work strip,
regardless of whether the producer is a plain Bash command, the delegation CLI,
or a future long-running process. Rows are keyed by Tool Task ID and render only
main-projected task state.

A row shows the task description, current status, elapsed or terminal duration,
bounded progress when supplied, and a disclosure for retained output and
artifacts. Running and settling rows expose Stop through the generic
`task_stop` path. Terminal rows expose their immutable outcome and any
available detail; clearing retained detail is a confirmed Host action and does
not delete canonical Thread history.

The strip consumes a cold task list plus transient task-change notifications.
Notifications are invalidation signals, not a second ledger. Reload, missed
notification, and restart therefore converge on the same durable task state.
Completion delivery is independent from strip visibility and commits exactly
once through canonical root Turn admission.

The strip never displays launcher identity, model policy, Agent Session state, or
a child Thread. A delegated result remains command output owned by its Tool Task;
continuation happens only when the root explicitly invokes `delegate send`
through a new Bash Item and Tool Task.

## Interaction States

When the provider catalog is loaded, at least one provider is usable, and the
catalog has no Thread, the dock automatically starts and selects one root user
Thread. The first usable surface is therefore the focused composer, not an
explanatory empty state followed by a second creation click. Provider loading is
neutral. When no provider is usable, the dock creates nothing and offers the
Providers settings action instead. Starting a Thread resolves the remembered
execution selection when it is still usable, or the current provider and Profile
defaults otherwise, plus the working directory at the main-process boundary.
Automatic creation is asynchronous: if the reader focuses another surface while
it is pending, completion preserves that newer focus instead of pulling the next
keystroke into the composer. Explicit creation reclaims only its own initiating
control or an unclaimed document body; it likewise preserves a newer focus target.

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

Once `thread/configuration/set` commits on an active, persistent root user
Thread, the host immediately remembers the complete provider, model, and
reasoning-effort selection as the default for new root conversations. Archived
and ephemeral Thread edits do not replace that app-wide default. Persistence
happens when the user chooses the setting; it does not wait for a message, Turn,
or model request. The choice survives an app restart and is shared by the
Thread-list action and `/new`.

Thread creation revalidates the remembered provider, model, and effort against
the current catalog. Provider lookup failure, an unavailable provider, or a
stale model/effort falls back to the current active provider and fresh
Configuration Profile defaults instead of blocking creation. The remembered
overlay applies only when the request does not explicitly name a provider or
Configuration Profile. It replaces only model and reasoning effort, so the fresh
default Profile still owns tools, Skills, plugins, MCP servers, developer
instructions, and capability ceilings; an explicitly requested Profile keeps
its own pinned model and effort.

Provider Settings and composer memory follow last explicit action wins. A
successful Set as Active, provider disable, or provider delete clears the
remembered selection; startup reconciliation does the same when it moves the
persisted active-provider pointer. New Threads then follow the Settings/Profile
path until another successful composer selection establishes new memory.
Existing Threads remain unchanged, and forks continue to inherit their source
Thread. A new delegated Session resolves its separate Settings-owned launcher,
model, and effort policy from the invoking root at admission; existing Sessions
retain their frozen selection across continuation.

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

Collapsing the Agent rail keeps the same `ThreadView` mounted, preserving its
composer draft, staged attachments, disclosure state, and scroll DOM. While
collapsed, the dock unsubscribes from Thread and document stores and retains a
frozen snapshot. Reopening subscribes again and
reads the newest snapshots before rendering; closing is never implemented as an
unmount or as a cleanup that discards unsent attachment resources.

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

The same terminal model governs input history. A focused composer offers plain Up at
its first visual line and plain Down at its last visual line as semantic history
actions, but only for a collapsed text selection. Shift/Control/Option/Command arrows,
ordinary movement inside wrapped or multi-line content, and arrows owned by an open
slash/mention menu or IME keep their established behavior. The editor consumes an
offered arrow only when history reports `performed`; a declined action falls through to
ProseMirror and the browser.

History is derived lazily from canonical `reader`-authored `userMessage` Items in the
exact Thread, preserving Turn and within-Turn Item order. The first eligible Up captures
the complete unsent scratch bundle, selects the newest entry, creates an editable draft
copy, and places the caret at its end. Up selects older entries, Down selects newer
entries, Down past the newest restores the current scratch working document and selection,
and Up past the oldest is a handled no-op. Scratch remains part of the active navigation
session: a subsequent Up restores the newest entry's edited working copy, and leaving
scratch again first preserves any edits made there. Each visited slot retains its working
edits for that navigation session. The session ends on submit, established clear,
Thread-view unmount, or a removed selected Item with no surviving history. If a selected
canonical Item disappears, the next arrow is consumed by one deterministic re-anchor:
the entry at its prior chronological index, otherwise the newest predecessor, otherwise
scratch and idle.

A bundle contains the ProseMirror document and selection, ordered structured text/Node/
file atoms, settled attachments, and renderer-only preview/source/excerpt metadata.
History never reparses marker text: Node and file atoms continue through recall, resend,
transcript reload, and provider projection as structured values, producing only
`[[node://...]]` and `[[file:///...]]`. A recalled submission uses the ordinary
admission/send path with fresh draft attachment identities. Missing or unreadable
managed content produces the established recoverable composer error and restores the
complete draft rather than crashing navigation or dropping one part.
When the mounted renderer already admitted an image preview, a successful send retains
that preview lease against the accepted canonical attachment. Recall aliases the same
lease under the fresh draft identity without rereading or copying source bytes; an
attachment whose thumbnail is unavailable keeps the generic name/type/size card.
The renderer preserves the complete `turn/submit` result across its send boundary:
`deduplicated` says whether the submitted attachment identities became canonical, while
the nullable `turn` field says only whether main opened a new Turn for layout and
anchoring. A successful active-Turn steer therefore retains submitted preview leases
even though its response has `turn: null`.

Picker, paste, drop, browser-file, mention, and generated-paste admissions remain in the
single serialized queue and never move into a history slot. While any such admission is
queued or running, history declines Up and Down until it settles, cancels, or fails.
Hidden scratch and working slots retain complete current managed-resource handles plus
renderer-only UI metadata in a session registry. Attachment limits count only the
visible slot and pending admissions. Navigation creates no storage, copies no bytes,
and never interprets the current handle's digest-shaped field. Session cleanup asks the
existing main-process resource authority to discard only when no visible or hidden
session link remains; canonical Thread links are checked independently by that authority,
so releasing one slot cannot invalidate a surviving Item or another slot. Renderer-only
preview leases are revoked separately when neither a canonical attachment nor any draft
slot retains them.

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

Root user Threads expose the composer. Delegation, Automation, Memory, and other
feature Threads are driven through privileged canonical admission paths instead
of accepting renderer-authored Turns; delegation Threads do not enter the
renderer at all. A user can fork terminal root history into a new root user
Thread before continuing it.

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
Nodes, and 64 KiB; main resolves current authoritative Node data. Text, attachments,
Outliner Node references, and Thread references remain distinct structured parts in the same order the
user placed them in the ProseMirror document. Sending a Node from its context
menu adds a removable Node-reference part to the composer; it never inserts
reference markup into text. The `@` menu's Chats section queries bounded recent root
user Threads for an empty query and matching title, preview, or visible history for text
queries, always excluding the current Thread and retaining archived results. Keyboard or
pointer selection inserts one `threadReference` atom. Draft snapshots, exact input
history, resend, and transcript reload preserve its structured ID while refreshing its
title from current metadata. Search loading, empty, failure, and stale-result states do
not discard the draft or selection. Edit replaces only the message text while preserving
the complete original structured input. An attachment-only or Node-reference-only
Turn can add text through Edit without losing its structured content.

Only the latest reader-authored user message in a terminal Turn exposes Edit; earlier
messages and every Agent-, host-, or feature-authored provider input remain copyable but
not editable, and an active Turn cannot be edited while its response is running.
Editing autofocuses the existing edit field. Escape cancels and
Cmd/Ctrl+Enter saves. Saving appends a `thread/rollback` marker for the final
Turn, then resubmits the original structured content with only its text replaced
as a fresh Turn in the same Thread. It does not mutate the sealed source Turn or
undo any document, file, tool, Goal, or external effect.

Attachment interaction retains source identity without carrying source bytes.
Local paths deduplicate by path. Pathless files stream to Thread-owned storage
and deduplicate by the returned content digest, so same-named files with
different content remain distinct. Native picker, browser file, drag-and-drop,
and mention admissions share one serialized composer queue, so duplicate and
attachment-limit checks observe every previously committed admission. One message
accepts at most 20 attachments, of which at most 10 may be images. Pending generated
text attachments reserve a total-attachment slot before encoding; all attachment
entry points recheck their capacity inside the queue.
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
it. Rejected ownership files do not consume accepted-attachment slots.

Every staged attachment has two linked projections over one identity: an inline
file-reference atom at its authored message position and one item in the fixed-height
tray above the editor. The tray includes picker, drop, clipboard, local-file mention,
directory, and generated-paste inputs; it never creates another attachment. Preview-first
176 x 112 px cards show images edge to edge, generated pasted text as a whitespace-collapsed
continuous excerpt of at most three visual lines and 256 UTF-16 units above a neutral
`Pasted` or pending-status label, and all other formats with a wrapping filename and size
above a compact semantic type label/icon. The single row uses an 8 px gap and scrolls
horizontally without wrapping or collapsing to `+N`. Its card-height viewport keeps a
straight overflow cut, softened by a narrow tokenized inner shadow only on edges with more
content; at the 280 px rail minimum one complete card remains visible with an overflow clue.
The visual scrollbar stays hidden; native horizontal scrolling, inset edge chevrons,
Left/Right navigation, and Enter-to-preview expose all 20 items. Overflow clips at the
composer inset instead of the rail edge. New items scroll into view without taking editor
focus, and resize keeps the focused item visible. The first card's top and inline-start
edges and the tray's following margin use the same composer inset.

The card is already a preview surface, so card hover only deepens the existing 1 px neutral
boundary without changing its thickness and reveals the remove control. It does not show
the inline-reference hover preview or a native title tooltip. Activating the card opens
the shared full preview.

Removing either projection deletes both and releases a managed resource only when no
retained draft or history identity owns it. The unboxed Remove control keeps an equal
radius-derived inset from the card's top and trailing edges and deepens only its glyph on
hover/focus. That state also applies a neutral transient removal preview to the paired
inline atom without changing ProseMirror selection or the caret; leave, blur, Escape,
cancellation, and activation clear it. The control's accessible name states that both the
file and its message reference are removed.

A plain-text paste is classified before ProseMirror construction. An incoming paste
at or above 4 KiB UTF-8 bytes or over 2,000 normalized line breaks becomes one managed
`Pasted*.txt` attachment; a fitting paste stays editable. Repeated fitting
pastes are rejected when the projected editor would exceed 256 Ki UTF-16 units or
8,000 inline atoms. Text above 8 Mi UTF-16 units is rejected before `File` construction
and must be saved and attached manually. Rejection changes neither draft nor clipboard.
Conversion immediately replaces the selection with a fixed request-id atom while the
body remains outside canonical draft content. Button and keyboard submission share one
pending guard until the serialized upload settles that exact atom to the same
`attachmentId`. A large paste synchronously rejects a replacement selection containing
another pending atom, leaving that request and the draft unchanged. Attachment-count
admission uses the projected result after fully replaced settled identities are removed,
so replacing one attachment at the 20-item limit is allowed. Failure restores the replaced
slice together with settled attachment ownership for any marker it contained and reports
that the paste was not inserted; it never recreates a pending atom whose request has ended.
Explicit removal cancels the request. Names increase monotonically within the mounted draft
and reset after a successful Send.

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
and owns New Thread plus every Thread-management action. New Thread is also
available through `Command+Shift+O`; the control's native hover title teaches
that registry-owned shortcut, while `aria-keyshortcuts` exposes it to assistive
technology without changing the control's accessible name. The dock
header does not expose the technical Thread-wide Trajectory command; Trajectory
remains available from response actions and native message menus. Each row exposes one More
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
changes coalesce through one frame-level bottom pin. Before either path writes,
it compares the current DOM position with the last synchronized position; an
upward divergence releases follow even when the browser's `scroll` event is
still queued in the same task. A lower maximum caused by content contraction is
treated as browser clamping rather than reader intent. Both paths yield to a
pending send anchor and to explicit disclosure anchors. Moving upward releases
follow, so later Item updates never pull the reader away from earlier evidence.
A visible Jump to latest material pill appears only when follow is inactive and
content remains below the viewport; activating it returns to the bottom,
re-engages follow, and restores composer focus.

A send costs exactly one viewport movement, and it starts on the keystroke. The
transcript draws the sent message itself, from the composer, as a view-only
in-progress Turn appended after the canonical list — the renderer's only
optimistic state, held in the view and never admitted to the store, so no
derivation outside the transcript can read it as canonical. It is suppressed in
the first render that resolves the Turn the send became, which makes the
handover a swap of one row for an identical one rather than an arrival: no frame
holds two of the message and none holds neither.

That Turn is resolved two ways, because not every send becomes a message. The
first is the `clientUserMessageId` the view minted. The second is the Turn the
host reports accepting, which is the only way home for a submission that carries
nothing of the reader's at all: `/clear` and `/compact` leave the composer as
ordinary text and come back as a `contextReset` / `contextCompaction` Item under
a Turn of their own, so the client id never appears anywhere and a row waiting
only on it could never be retired. A submission the host answers with no Turn —
a deduplicated repeat, a steer, a Thread the reader has left — retires the row on
the spot, since nothing is coming that could replace it. A refused send takes its
row back out along with the composer draft it restores. Only a send that opens a
Turn draws one; a steer joins the Turn already running, where the row does not
belong.

When the real transcript already exceeds its viewport at send time, the message
is anchored at the transcript top inset on the layout pass it first renders, and
follow is re-derived from the resulting position. A transcript that still fits
within one viewport creates no send-anchor spacer and stays on ordinary bottom
follow, so earlier short-conversation content remains naturally above the new
message. This decision uses pre-send real transcript geometry; optimistic rows,
temporary runway, and later response growth do not switch modes. The anchor names
its Turn by the same two-way resolution, re-run on every pass and never latched:
the id it resolves first is usually the stand-in row's, and that row leaves the
DOM the moment the canonical Turn lands — an anchor holding it would have
nothing to measure, and since a pending anchor is what suspends the bottom pin,
the transcript would stop following streaming replies for the life of the mount.
Searching by client id rather than by "a Turn appeared" is what keeps a delegated
Agent's result delivery — also a user-role Item, also arriving in this window —
from being mistaken for this send. The bottom pin is suspended from the click until the anchor
lands, so the message is never parked at the bottom edge on the way. A long
conversation therefore streams below the anchored message without moving it;
short conversations continue following without anchoring. The anchor identifies
and mounts its target before measuring it, and
an optimistic-to-canonical replacement repeats that staging for the new row.
The target's inline disclosures must commit their initial collapsed layout and
the Turn-height cache must match the live row before the runway is calculated.
Each new target measurement advances the anchor to a later pre-paint layout
pass; only then are its runway spacer and target coverage committed before the
scroll that uses them. An uncovered target or a pass whose own measurements do
not yet place the message at the top defers the write rather than exposing a
position it will have to correct. The `turn/submit` response's `turn` field contains
the exact newly accepted Turn when main started one and is `null` when main steered or
deduplicated the submission, so a concurrently loaded history page cannot be mistaken
for the new send; it remains the anchor's fallback for a send whose Item never arrives
by notification, and a submission with nothing anchorable falls back to the tail. This
layout signal is independent from the response's admission disposition. Main,
not the renderer's cached snapshot, owns the start-or-steer decision. Steering
an existing active Turn keeps the bottom-follow path: the
transcript reads the steer off the Item landing in the Turn that was already the
tail at click time, and never anchors a reply the reader is in the middle of.
The renderer does not alter notification order.

That one movement is spent as travel rather than as a cut: the scroll is tweened
to the anchor over `--motion-layout-duration`, easing out, so the message rises
into place instead of the viewport changing pictures. It is the scroll that
animates and not a transform over it — a transformed descendant contributes its
transformed geometry to the scroll container's overflow, which would inflate the
`scrollHeight` the runway spacer is computed from and let the anchor undo
itself. Every frame therefore writes a real scroll position, the bottom pin is
suspended for the duration, and a scroll the reader makes mid-travel cancels the
remainder. Reduced motion, a distance under a pixel, and a distance over two
viewports all take the cut instead.
A temporary renderer-only tail spacer gives the new message enough scroll runway
to reach the top before response content exists. It carries no document state,
shrinks as real response content replaces that runway, and is removed when no
runway remains or the reader jumps to the latest content. Spacer-only runway does
not count as unread content for the Jump to latest control. The first optimistic
row and its initial runway are staged in the same send commit, before the host
has accepted or steered the submission. If the optimistic row is replaced by the
canonical Turn, the anchor repeats target coverage and measurement staging for
the canonical row; measurements taken for the optimistic row cannot satisfy the
replacement.

Each Thread keeps an ephemeral scroll snapshot across Thread switches, recording
the Turn at the top of the viewport and its offset there rather than a scroll
offset alone. Returning to a Thread waits for non-empty loaded history, then puts
that Turn back at that offset, correcting after layout until the anchored row
agrees and the transcript has remained stable across two animation frames.
Repeated layout effects in one React commit do not count as independent stability
observations. An anchored Turn that is not rendered yet is placed by the saved
offset first, which prepares its virtual range before applying the position. A
bounded attempt count releases exact anchor correction when geometry cannot
satisfy it, at the nearest browser-clamped offset; it never releases the coverage
requirement for that actual offset. Empty history never replaces the saved
snapshot with a top clamp.

A restore outlives its first application, so it yields where every other writer
of the scroll position yields. User scrolling takes ownership and cancels it; an
activated disclosure holds the position the reader just asked for and the restore
waits without spending an attempt; sending cancels it outright, because asking
for the end of the conversation outranks a position that was left. While one is
pending, follow is not re-derived and the snapshot is not re-cached from the
geometry it is passing through — an intermediate offset clamped near an unsettled
maximum reads as bottom-follow and would hand the transcript to the bottom pin.
The settling attempt releases the request before its own write, so the position
it lands on is what both are taken from. A failed send restores the pre-send
position, anchor, and follow state. A followed Thread resumes at the bottom and
records no anchor. A Thread left without a final scroll event — its position
moved by content growth alone — still records that position as it unmounts.

The transcript has one paint owner at every size. Eight or fewer Turns use normal
DOM layout and paint; a Turn never delegates its paint timing to
`content-visibility`. Nine or more Turns use the measured-row renderer window,
with 240 pixels of overscan as a performance cushion. Terminal offscreen Turns do
not remain mounted. Flow rows still populate the measured-height cache without
forcing a render for each measurement, so crossing the threshold consumes real
heights immediately. Virtual rows update the layout when their measurements
change; unmeasured rows use the bounded content-derived estimate.

The virtual coordinate origin is `.thread-transcript-turns`, not the transcript
scroller. The renderer derives that origin from the live scroller and Turns
container rectangles, then intersects the Turn-local viewport with the virtual
layout. Goal height, content padding, and the Goal-to-Turn gap therefore affect
only the origin; they never masquerade as progress through the Turn list. The
same pure range calculation selects overscan rows and determines whether the
currently committed range contains every Turn intersecting the real viewport. A
viewport wholly inside the Goal or beyond the Turn extent requires no Turn row.

Coverage is a pre-paint invariant, not an overscan assumption. A covered native
scroll retains the one-update-per-animation-frame metrics path. When a native
event or an event/rAF scroll writer leaves the committed virtual range, the
imperative adapter reads the browser-clamped position and live Turns origin, then
uses `flushSync` only for that uncovered range before the callback returns. Rapid
reader scrolls cancel stale height compensation; trusted scroll events caused by
layout settling retain it. Pointer drag, wheel, touch, keyboard, and untrusted
test scrolls are all classified as reader intent. Pointerdown that begins on an
interactive control inside the transcript is not scroll intent by itself; if the
control click or browser action actually moves the scroller, the later scroll
event is what arbitrates ownership.

A layout-effect writer never calls `flushSync`. It creates a generation-tagged
transaction and predicts the clamped target viewport. If that viewport is not
covered, the first pass commits its range without changing `scrollTop`; a later
layout pass verifies that the transaction is still current, writes the position,
and rechecks the actual browser-clamped viewport. Changed geometry repeats the
prepare pass before paint. New reader intent or a higher-priority imperative
writer invalidates the transaction. Send anchoring prepares the whole short
travel interval before its first tween frame, while long travel prepares only
the cut target.

A send cut keeps owning its anchor after it first writes the target position. It
does not release to bottom-follow, ordinary virtual coverage sync, or virtual
height compensation until the target is still at the top, the scroll height is
unchanged, the target top is unchanged, and the Turn measurement generation is
unchanged across two independent animation frames. Layout effects inside one
React commit are not stability observations. A reader scroll, a new send, a
steer, send failure, a resultless submission, unmount, or Jump to latest cancels
that ownership and removes any remaining send-only spacer.

When a row fully above the viewport replaces an estimate with a measurement,
virtual height compensation records the visible Turn and its viewport offset
before committing the new total height. Its rAF writer restores that real anchor
after all measurements in the batch; the accumulated height delta is only the
fallback when the anchor row is unexpectedly unavailable. Browser clamping and
concurrent newly mounted measurements therefore cannot move the reader's Turn.

Measured long user messages start clamped on their first layout until measurement
proves that the content is short. The measurement update still commits before
paint, so short messages do not expose the temporary mask, but virtual parents
never cache a one-frame full-height version of a long message before its own
disclosure effect collapses it.

Provider request and stream retries are transient execution state, not Items.
The selected Thread shows `Retrying` for request recovery and `Reconnecting` for
stream recovery in the matching Turn's response footer, replacing the rose
generating indicator in that fixed slot. The initial request is separate from
request retries `1/5` through `5/5`. The status and every intermediate failure
disappear when the provider recovers; exhaustion leaves only the terminal Turn
error and its main-authorized recovery actions.

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
then the first `pending` one. An incomplete closed pill keeps `PlanToolIcon`
static and applies `WorkingText` only to that summary label while the Turn is
advancing. A Turn blocked on user input keeps the closed Plan summary static.
Opening the Plan removes all Plan motion, and collapsing resumes only the
summary sweep once the Turn is advancing again.

The pill also renders on a visible Thread that has no composer, such as an
Automation Thread, because `update_plan` is `anyThread`-scoped and such a Thread
has a Plan to show. It is equally interactive there; only the focus destination
differs, since there is no composer to return to.

Hover previews the complete checklist; activating the summary opens the same
scrollable checklist and moves keyboard focus into it. The current step is
marked by strong text, 600 weight, a neutral filled dot in the fixed status slot,
and `aria-current="step"`; it never shimmers. Completed steps stay dimmed and use
a check glyph, while pending steps keep a static hollow dot. Step
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

Process, expandable reasoning, tool-group, and tool-detail disclosures keep per-Thread UI
overrides in versioned local storage. Their keys use canonical Item identities;
switching Threads, streaming-to-terminal remounts, and application reloads do not
discard an explicit user choice. A live reasoning Item starts folded while
streaming and remains folded when that Turn settles. A terminal multi-line
reasoning Item first observed after settlement rests folded unless it is the
only process Item in a Turn without a final agent response, in which case it
opens by default. A single-line reasoning Item has disclosure state only while
its collapsed text exceeds the available row width. Expanding
or collapsing any explicit transcript disclosure preserves its activated surface's
viewport position. This includes the persisted process, reasoning, tool-group, and
tool-detail disclosures as well as measured long-user-message and image-gallery
controls. The activated anchor owns that layout transaction while delayed
measurements settle, so frame-level bottom follow yields instead of moving the
surface the user just activated. The image gallery anchors its persistent container
because the `+N` control unmounts when the full grid replaces it. Follow is derived
from the resulting geometry after the anchor settles rather than released by the
toggle.

Capture starts its fallback restore loop immediately, so an owning row that
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
release. Capturing a disclosure anchor pauses scroll writers that could move the
viewport, but it does not erase a mounted send spacer; the spacer is the current
rendered range that lets the explicit anchor preserve its surface. Virtual row
compensation yields while the explicit anchor is active, because that anchor is
authoritative for concurrent geometry changes.

Which point of the activated surface stays fixed follows from where its control
sits and which way the surface is moving. A control above the content it opens —
every persisted process, reasoning, tool-group, and tool-detail chevron — is
itself that point, and its content opens below it. The measured
long-user-message control hangs below its own text, so pinning it while opening
would grow every revealed line upward: opening holds the message's collapsed
block by its own top edge instead, and an Agent's brief at the head of its
transcript and a long message reached by scrolling back both open downward from
where they are read. The exception is a transcript riding a tail it can actually
scroll, where holding the control is what staying at the bottom means; a
transcript shorter than its viewport has no such tail. A mounted send spacer owns
the rendered bottom rather than extending real content, so while it exists a
long message always opens from its block even when the scroller is at that
synthetic bottom. The range is otherwise measured over real content so the
anchor runway cannot invent a tail. Collapsing holds the control in every case,
because nothing grows: the control is what the reader just clicked and the only
point the geometry guarantees is on screen, while the block's top edge in a
message taller than the viewport is far above it.

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

`threadStore` applies every decoded notification to its snapshot synchronously, so
request guards and imperative reads always see the latest state. Subscriber delivery for
`item/delta` is coalesced to at most once per animation frame, with a 16 ms timer fallback
when `requestAnimationFrame` is unavailable. Request/response and lifecycle changes
notify synchronously; they preserve focus and state-transition semantics and invalidate
any older scheduled delta delivery. `useSyncExternalStore` reads the latest snapshot when
a delta delivery runs, so concurrent visible Thread streams do not force a
React render for every token and an occluded window can defer delta rendering without
stale store state.

## Visual Contract

The Agent dock follows the shared design system:

- content text uses the outliner reading size and line height
- chrome uses tokenized neutral states and icon controls
- dialogs and menus use shared overlay primitives
- the pre-refactor transcript, composer, disclosure, attachment, and message
  action geometry remains the visual baseline even though renderer-projected
  canonical DTOs now drive it directly
- focus remains visible, motion respects user preference, and hover never moves
  layout
- the minimal header reserves the global rail-toggle zone so its list trigger
  does not overlap window chrome

All user-facing copy comes from typed i18n messages. UI nouns are Thread, Turn,
Item, Goal, and Tool Task. Agent Session and launcher appear only in delegation
Settings or CLI results, not as conversation participants.
