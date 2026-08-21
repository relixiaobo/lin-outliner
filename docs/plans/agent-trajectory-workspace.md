# Agent Trajectory Workspace

Shape: **(a) ONE complete feature in one PR.** The Thread projection, live
updates, workspace, inspector, export, tests, and current specifications land
together. Internal build order establishes the protocol and projection before
their renderer consumers.

## Goal

Replace the single-Turn, document-style Model Interactions inspector with a
Thread-wide Trajectory workspace. A technical user can locate and inspect
input, context, assistant, tool, retry, compaction, and delegation activity
across the complete execution history without losing the surrounding
conversation.

The selected target adopts the DeepSeek Harness Trajectory product logic and
interactions while retaining Tenon's canonical Thread, Turn, and Item authority,
diagnostics redaction, audited payload reads, workspace layout, process boundary,
and visual system.

The minimum acceptable outcome is that a user can open one Thread's Trajectory,
follow live activity, search or narrow the ordered ledger, select any record,
and inspect the exact retained evidence without leaving that Thread's context.

## Non-goals

- Do not expose rollout JSONL, payload paths, or digest-addressed reads to the
  renderer.
- Do not create a second durable execution ledger or make inspection state
  authoritative.
- Do not change provider request bytes, model execution, tool admission, or Turn
  settlement.
- Do not combine descendant Threads into one flattened trace. A delegation is a
  parent record that opens the child Thread's own Trajectory.
- Do not replace application-wide error diagnostics or Settings diagnostics
  export.
- Do not copy DeepSeek Harness brand tokens, fonts, application shell, plugin
  architecture, floating composer, or source code wholesale. Its Trajectory
  composition, density, information hierarchy, and interaction model are the
  product-interface authority; Tenon expresses them through its own tokens and
  process boundary.
- Do not retain a compatibility reader or route for the retired pre-release
  Model Interactions workspace.

## Design

### Product model

Trajectory is a Thread-wide investigation workspace, not a Turn details modal.
Its central surface follows the DeepSeek Harness Trajectory interface rather
than a generic Tenon reading page: full-width horizontal bands, a compact
three-lane overview, a dense event ledger, and an inspector that appears beside
the ledger only while a record is selected. Summary metadata is integrated into
the toolbar and inspector; the workspace must not become a vertical stack of
framed cards.

It combines three synchronized surfaces:

1. An Input / Assistant / Tools overview establishes ordering, timing, and scale.
2. A tail-first ledger groups stable records by Turn and provides bounded
   previews, states, timing, and usage.
3. A record-specific inspector lazily reads the exact retained evidence for one
   selected record.

The active workspace pane shows Trajectory while the Thread dock remains visible
as the conversation surface. Tenon does not reproduce the DeepSeek Harness
floating composer because Thread input already has one owner.

DeepSeek Harness `TrajectoryTimeline`, `TrajectoryToolbar`, and
`TrajectoryTable` are the layout and behavioral references for density,
message-first rows, synchronized selection, range navigation, folding, and
adaptive inspection. Deviations require a Tenon-specific product constraint,
not a preference for an existing generic panel primitive. Tenon's implementation
is decomposed around its own process seam, protocol codecs, renderer store, and
design tokens rather than transplanting the reference components.

### Concept alignment and record taxonomy

Trajectory uses message-first presentation and evidence-first identity. The
ledger reads like DeepSeek Harness: input, context, Assistant work, tools,
retries, compaction, delegation, then the next Assistant work. The backing data
does not copy DeepSeek Harness records. Trajectory records are projection
records: bounded, stable, inspection-only summaries derived by main from
canonical Thread, Turn, Item, and immutable diagnostics facts. Adding Trajectory
therefore must not widen the `ThreadItem` union, create another durable
transcript, or make debug visibility an execution precondition.

The top-level Trajectory record kind set is:

| Kind | Meaning | Lane |
|---|---|---|
| `input` | One canonical `userMessage` Item admitted as initial input or steering. | Input |
| `context` | Stable prompt changes, provider-visible tool catalog changes, and prepared provider-context parts that emitted model-visible context text. | Input |
| `assistant` | One provider/model call presented as Assistant work, with request, response, reasoning, usage, and timing facts. | Assistant |
| `tool` | Shell, file, MCP, dynamic tool, search, and other non-delegating tool work. | Tools |
| `retry` | Request or stream retry linked to its source and next Assistant/provider calls. | Assistant |
| `compaction` | Manual, automatic-preflight, or provider-overflow context compaction. | Input |
| `delegation` | Child Agent spawn, message, stop, outcome, and child-Trajectory navigation. | Tools |

An `assistant` record is not a canonical `AgentMessageThreadItem`. Its primary
evidence is exactly one provider call addressed by Thread, Turn, and provider
call index from immutable Turn diagnostics. Transcript Items, assistant text,
and reasoning are related evidence or preview content for that Assistant record
when available; they never replace the provider-call identity. If a provider
call did not produce visible transcript text because it requested tools, failed,
or was interrupted, it still remains one Assistant record with its recorded
request, response, timing, and state.

An `input` record is one canonical `userMessage` Item. Its primary evidence is
the Thread Item itself; the accepted-input diagnostic activity and the first
provider call that consumed it are related evidence. Context Items admitted in
the same envelope do not automatically become `context` records. A CONTEXT row
exists only for stable prompt text, a provider-call tool catalog snapshot that
changed the model-visible tool schemas, or a prepared provider-context part whose
diagnostics prove that model-visible context text was emitted. A USER
preview/detail must therefore render the original user content only and must not
concatenate `contextEvidence`, stable prompt, user view, skills, roles,
tool-output projection, or additional-context summaries into the USER row.
Provider request payloads are shown as request evidence on the consumed provider
call, not as USER content.

Every Trajectory record has one primary evidence reference and may have related
evidence references. Detail reads resolve from the primary evidence and then
authorize related evidence through the same owning Thread and Turn. Missing,
corrupt, redacted, or unavailable evidence marks only that record or tab as
partial or unavailable; the projector must not infer provider-call order from
Item adjacency, attach tool results to the nearest Assistant row by guesswork,
fill missing values with zero, or treat a transcript Item as proof of a provider
call that was not recorded.

Steering is an `input` source, not a separate record kind. DeepSeek Harness
`tool` and `subtool` map to one hierarchical `tool` kind with parent call
identity rather than two top-level kinds. Agent-related tool calls collapse into
one `delegation` record so the same activity is not shown as both a generic tool
and an Agent row. Turn headers, Assistant/provider-call summaries, older-history
controls, timeline ellipses, and fold placeholders are structural rows, not
record kinds.

### Entry and navigation

The active Thread header opens Trajectory for the complete Thread. A Details
action on a Turn, message, Assistant/provider call, or tool record opens the
same workspace with the exact owning record selected. The entry contract is
Thread-addressed; selection is an optional deep link, not a separate
Turn-addressed page.

On entry:

1. The workspace loads the latest lightweight trajectory page and a compact
   whole-Thread summary.
2. The overview and ledger render without mounting detailed payloads.
3. Selecting a timeline span or ledger row keeps the row visible and opens the
   applicable inspector.
4. Loading an older page prepends records without moving stable selection or a
   reader who has suspended tail following.
5. Closing Trajectory restores the previous workspace location while the Thread
   dock retains its conversation state.

An empty, loading, active, terminal, partially available, page-error, and
export-error state are explicit. A missing or corrupt diagnostic affects only
the narrowest record or inspector tab; canonical Turns and Items remain visible.

### Main-owned projection

Main owns a paged, lightweight trajectory projection derived from canonical
Turns and Items plus immutable Turn diagnostics. It preserves recorded activity
order and never reconstructs Assistant/provider-call relationships from Item
adjacency.
Stable record identities survive paging, restoration, live replacement, and
history prepends.

The projection includes only bounded summaries required to locate a record:
record identity and kind, Thread and Turn ownership, parent call identity where
applicable, lifecycle state, recorded timestamps, bounded preview, usage summary,
and typed availability markers. Full request, response, arguments, result,
schema, and audit evidence remain behind record-specific reads.

A rebuildable read cache is permitted only if a cold-read probe demonstrates a
need. It is never another source of truth or a second persisted execution log.

For an active Turn, the diagnostics collector contributes bounded, secret-free
lifecycle summaries at request, response-header, assistant-terminal, tool
start/terminal, retry, steering, and compaction boundaries. Contributions are
best effort, coalesced, and inspection-only. Item deltas remain the sole owner of
streaming preview content; Trajectory does not publish another token stream.

Projection, notification, paging, or renderer failure must never fail,
interrupt, delay settlement of, or otherwise change a Turn. Runtime projection
invariants degrade by recording, healing, or skipping at the affected record.

### Protocol and process boundary

The Agent protocol exposes:

- a tail-first paged trajectory query addressed by Thread;
- a bounded live-change notification carrying invalidation or replacement facts;
- a record-detail query addressed by exact Thread, Turn, and record identity;
- a Thread trajectory export command that returns a user-selected file result.

All request and response values use explicit codecs. Main validates ownership
before resolving any detail. The renderer never receives filesystem paths,
digest-only authority, arbitrary response headers, raw recognized secrets,
host credentials, or unbounded binary content.

Existing audited readers such as Turn details, Item output, and context payload
reads remain the detail authority where their ownership already matches. The
new projection composes those authorities; it does not duplicate their payloads.

### Overview interaction contract

The overview has three lanes: Input, Assistant, and Tools. It supports two
modes:

- **Duration** places spans against recorded wall-clock time and exposes actual
  gaps and overlap.
- **Sequence** gives ordered activity readable space without claiming that width
  represents elapsed time.

Hover exposes exact clock and duration facts. Assistant spans distinguish
time-to-first-token from decoding when both are recorded. Running operations use
a start marker and running state and never fabricate a duration.

Clicking a span selects its ledger record. Dragging a range filters to records
active in the interval. Wheel zoom and secondary-button pan operate only inside
the overview. Search dims unmatched spans; clearing search restores the current
paging, range, and fold state.

### Ledger interaction contract

The ledger is ordered by recorded activity and grouped by Turn. Each record is
one compact, table-like row whose leading tag names the message/event role and
whose main column starts with the actual content preview. Internal titles,
identifiers, evidence references, and lifecycle metadata must not displace the
message content as the primary scan target. Turn folds preserve the first
ordinary content row plus one summary row; System and provider-visible Tools
request-header rows stay outside the fold. Assistant/provider-call folds
preserve one summary row and stable selection semantics. Search filters
the currently loaded window; it does not imply that unloaded history was
searched. The UI states that scope and offers earlier-page loading from an
explicit ledger row and overview ellipsis.

The initial view follows the tail. User scrolling, time-range selection, or
detail inspection suspends following until the user explicitly restores it.
Streaming changes update bounded previews without changing record identity.

Once the loaded ledger exceeds 100 visible candidates, rows mount through a
measured visible window with bounded overscan. Derived search indexes, record
maps, timeline geometry, and grouped rows are computed once per relevant input;
transient pointer and pan values do not subscribe the full ledger to frame-rate
state.

### Record inspector

On wide desktop layouts, selection opens a resizable companion pane. At narrow
widths the inspector replaces the ledger and provides Back rather than
compressing both surfaces below their readable minimum.

Tabs are record-specific and follow the DeepSeek Harness content-first model:

- Input: Summary, Preview, Raw.
- Context: Summary, Preview, Raw; stable prompt records expose System Prompt,
  and provider-visible tool catalog records expose Tools.
- Assistant: Summary, Preview, Raw. Summary integrates source request, state,
  usage, rendered response, and timing; Raw contains the typed redacted request
  and response evidence.
- Tool: Summary, Input, Output, Schema, Raw.
- Retry and Compaction: Summary, Preview, Raw.
- Delegation: Summary, Preview, Raw, Open child Trajectory.

Context Preview uses captured model-visible context text from the prepared
canonical provider context whenever diagnostics retained it. That is the
`<system-reminder>` / `<context-evidence ...>` text the model saw at the
provider-context boundary, after projection, budgeting, compaction, and
renderer-facing sanitization. Non-stable context rows are keyed by a
diagnostics-backed prepared-context-part evidence reference, not by the retained
`contextEvidence` Item. A prepared provider content part is the ledger unit: if
one `<system-reminder>` part contains multiple `<context-evidence>` blocks, it
appears as one CONTEXT row and the inspector shows the whole part text. If a
retained `contextEvidence` Item emitted no
model-visible text, it is not a Trajectory message row. Tool catalog Preview is
not message text; its row is grounded on the provider call's prepared
`toolNames` and retained canonical schemas. It appears once when the first
non-empty catalog is sent and again only when a later provider call changes the
prepared catalog; repeated calls with the same tool schemas do not add duplicate
rows. Tool catalog rows are system-like request-header rows: they sit with
stable prompt changes before the Turn's ordinary USER / CONTEXT / ASSISTANT
body rows, and Turn folding never hides them. Frozen tool-output
projection Items are storage evidence for replaying tool results; they do not
appear as CONTEXT rows unless their text is explicitly emitted inside prepared
provider context. The retained context payload remains Raw storage evidence
when it is selected through another authority; it is not the Preview and not the
exact post-adapter provider request.

The Assistant inspector may title the backing evidence as a Model Call because
the details are provider-call diagnostics. That title is evidence vocabulary,
not a top-level ledger kind. Large content and syntax presentation mount lazily.
Raw means Tenon's typed, secret-redacted diagnostic representation. It never
means an unrecorded HTTP body, arbitrary headers, image bytes, or credentials.
Missing, corrupt, redacted, or unavailable evidence leaves the selected record
and its siblings intact and explains the limitation in the affected tab.

### Child Threads

A child Agent execution remains a record in the parent's trajectory with the
same lineage and execution facts that the canonical parent Thread owns. Opening
it selects the child Thread and its own Trajectory. Descendants are never
flattened into a synthetic parent timeline, and child evidence is never copied
into the parent projection merely to support navigation.

### Summary and export

The workspace summary reports whole-Thread counts and totals that can be derived
truthfully from retained evidence: Turns, Assistant/provider calls, tools,
recorded duration, tokens, cache use, and cost when available. Missing
contributors produce typed partial coverage rather than an apparently complete
zero.

Export creates a user-selected Thread trajectory bundle from the same typed
projection and retained diagnostics used by the inspector. It states omissions
and limitations, excludes secrets and unrecorded transport data, and makes no
byte-for-byte HTTP fidelity claim. Export failure leaves the workspace unchanged
and provides a retryable local error.

### Visual and accessibility contract

Trajectory uses the existing opaque workspace base, tokenized content surfaces,
and material only where existing chrome permits it. Selection, hover, focus, and
active state remain neutral; status colors convey status only. Icon controls use
the existing icon library, native tooltip and focus conventions, and do not add
rounded-square hover fills. Type chips may use identity/status tokens for
message/event scanning, but those colors never paint selection, hover, active,
or focus state.

Keyboard users can reach the toolbar, timeline records, ledger rows, fold
controls, tabs, resize control, and Back/close actions with visible focus.
Light and dark themes, increased contrast, reduced motion, reduced transparency,
wide desktop, and the minimum supported pane width preserve readable,
non-overlapping content. Timeline pointer gestures have keyboard-accessible
selection and zoom alternatives.

### Files and ownership

Expected protocol work is under `src/core/agent/protocol.ts` and
`src/core/agent/codec.ts`. Main work belongs near `ThreadService`,
`ThreadResourceOps`, Turn diagnostics, and the runtime lifecycle observer.
Renderer work replaces `ThreadTurnDetailsPanel` and the `thread-turn-details`
workspace route with focused trajectory projection, timeline, ledger,
virtualization, inspector, and styling modules.

Focused protocol, projector, runtime, renderer, and Electron E2E suites cover
the feature. Current behavior is folded into `agent-core.md`,
`agent-thread-rendering.md`, and `agent-model-runtime.md` in the same PR.

### Risks and mitigations

- A derived trace can drift from execution history. The projector consumes
  canonical artifacts and recorded activity order and is rebuildable.
- Eager diagnostics reads can make long Threads expensive. Reads are tail-first
  and paged, detail is lazy, and caching requires measured evidence.
- Live inspection can become a user-path invariant. Every contribution is best
  effort and cannot affect execution or settlement.
- A dense split can become unreadable. The inspector has stable width limits and
  becomes a replacement view below the two-pane threshold.
- Timeline geometry can imply false precision. Duration mode uses recorded time;
  sequence mode is labeled and makes no duration claim.
- Export can overstate or leak evidence. It uses typed redacted values and
  carries explicit limitations.

## Acceptance Criteria

- Opening Trajectory from a Thread header shows that complete Thread; opening
  Details from an existing record selects the exact matching Thread, Turn,
  Item, and Assistant/provider-call identities in the same workspace.
- While a Turn runs, lifecycle rows and bounded previews update without manual
  refresh. After restart, completed history reconstructs in the same recorded
  order without consulting current provider settings or tool catalogs.
- Selecting a record exposes only applicable tabs and lazily reads large detail.
  Missing inspection evidence degrades locally and never removes the record.
- Older-page prepend, streaming replacement, search clearing, and folds preserve
  selection and measured scroll position through stable record identities.
- The timeline preserves recorded order, shows no fabricated duration, and keeps
  selection and search matches synchronized with the ledger.
- The renderer and export never receive credentials, raw recognized secrets,
  arbitrary response headers, image bytes, direct payload paths, or digest-only
  authority.
- The complete interaction is keyboard accessible and visually verified in
  light and dark themes at wide desktop and the minimum pane width.
- Protocol/codec rejection, projection degradation, live runtime, restart
  reconstruction, all record kinds, paging, folding, search, export, responsive
  replacement, accessibility, and a long virtualized Thread have focused
  automated coverage.

## Open Questions

None. The PM selected the complete DeepSeek Harness interaction target; Tenon's
existing authority, security, process, workspace, and visual boundaries remain
hard constraints.
