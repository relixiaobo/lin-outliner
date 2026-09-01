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

**An Agent is read as a level pushed over the conversation.** A delegated child
is an execution artifact of a Turn, so it is opened rather than travelled to and
the Thread list never gains a row for it. 330px of drawer inside a 344px deck is
not a drawer, so the detail view takes the whole deck body and COVERS the
conversation instead of replacing it in the tree. The transcript underneath
stays mounted but hidden (`visibility: hidden`), which keeps it out of tab order
and out of the accessibility tree while it keeps its scroll position and its
measured layout: returning is a reveal, not a reload.

The pushed level TAKES THE TITLE BAR, exactly as the Automations surface beside
it does: a back arrow, the Agent's name, what kind of Agent it is as a badge
after that name, a worktree mark when it is isolated, and Stop while it runs.
Leaving the conversation's title above it made the loudest line on screen the
one thing the reader was not looking at, gave the Agent two headers, and kept
offering a list chevron that could not act on anything below it.

The kind is a BADGE rather than a leading glyph, because a glyph asks the reader
to know an icon while the badge carries the word — and the word is the useful
half for the specialized types, which are the ones worth telling apart. The
title carries NO status: the transcript directly below says what the run did and
how long it took, so a status there would be the same fact twice on one screen
(PM 2026-08-15).

Back pops exactly one level and its accessible name says which level that is —
the conversation at depth one, the delegating Agent deeper in. The visible title
names the level you are ON rather than the one below (PM 2026-08-15, replacing
the ratified "the back button shows the parent level's name"): that wording was
written for a drawer, which had no title bar to put the current level's name in.
A 344px bar carries one name, and showing both truncated each to a syllable —
`统计 render…` `核对…` — so the current level takes it and the parent's name
rides the back control's label and tooltip. A nested Agent pushes
through the same component; delegation is capped at depth three, so the stack is
bounded at four levels by the protocol rather than by a rule of its own. Opening
always resolves the target's lineage from the conversation, so a descendant
deepens the stack while a sibling reached through `agent_message` opens at its
own level: reachability is not lineage, and a stack that grew on reachability
would draw a delegation edge that does not exist.

Every anchor opens the same view. A chip in the transcript, a work-strip row, a
Thread Details row, and a nested chip inside another Agent are one gesture to
one surface, so an Agent has exactly one place it is read.

Inside the view the transcript renders EXACTLY as the main conversation does —
same message stream, same bubbles, same rows — because it is the same thing: a
request and the work it produced. What differs is which actions are valid.

**Position is identity, and everyone who is not the reader is a speaker.** The
delegation graph is a set of participants sending each other messages, and every
surface that shows one reads like any message stream.

Every non-reader block therefore wears the SAME structure — a header carrying a
mark beside two stacked lines, WHO (persona and Agent type) over WHAT THEY
DID (the Turn's work summary for this transcript's own agent; a delegated
child's own elapsed for its report) — then what they said beneath it. The work
line IS the work summary and the only control that opens the timeline. It is
two lines rather than one because they answer different questions and the
second one GROWS: an elapsed time ticking up beside a name squeezes the name at
deck width, and a persona is the thing that must never be truncated. What the
earlier one-line rule refused was four elements for one sentence — a name row,
a summary line, a rule, and sometimes a second summary line (PM 2026-08-15);
two tight lines under one mark are not that, and the prototype the identity
system was ratified from stacks them (PM 2026-08-18). One structure for all of them: the conversation's own agent
answering, a delegated child delivering its report, the Agent that wrote a
brief. The mark and the two identity lines form a header ROW at the block's
left edge, and the words beneath take the WHOLE column — no avatar lane, no
hanging indent. An avatar lane is what a chat app spends on short bubbles; what
arrives in this deck is documents — tables, code blocks, galleries — in the
narrowest column the app has, where a lane costs 13% of the measure and a
three-column table pays for it (PM 2026-08-18). What an indent would buy is a
visible change of speaker, and the header row says that louder anyway: a
mark, and a persona in the content register. Before this, `main` was unattributed prose and a child's report was a
labelled bubble, which made two participants look like two different sorts of
thing (PM 2026-08-15). Consecutive blocks group under a single header only within one
PARTICIPANT — never merely within one type. A `general-purpose` child inside a
`general-purpose` parent otherwise swallowed the brief its parent wrote into its
own header and hung its own elapsed over someone else's words (PM 2026-08-15):
which participant is speaking and what its avatar looks like are two questions,
and only the first may merge two blocks. So an agent that works and then answers
is named once, not twice;
a delivery Turn genuinely has two speakers (the child, then the agent reading
its result) and shows two.

Two things never open a speaker run, because both produce a header standing over
nothing — a participant who apparently said something the reader cannot see. A
delivery whose Agent is no longer in the registry has no report to show and no
speaker to name, so its block is dropped rather than handed to the Turn's host
author. And a block that DRAWS nothing is skipped before grouping at all: a
delivery Turn as the host writes it opens with the settled activity Item and
three `contextEvidence` rows, none of which the transcript renders, and all of
which belong to this Thread's own agent — so ungrouped they put a named `main`
above an empty box before the child that actually spoke.

That renderability boundary is structural and author-independent. A
`userMessage` with no attachment or Node reference and only empty or
whitespace text contributes no bubble, speaker, copy target, accessibility
output, or spacing. Attachment-only and Node-reference-only messages remain
visible. A resolved `SubagentReport` is the visible projection of its delivery
Item, so the replacement remains visible even when the underlying provider-role
content is empty.

Content under a speaker is PLAIN PROSE, never a bubble. The avatar and name
above already say who is talking, and a second container would draw the same
fact twice. That is what retires the `From <name>` label the report and the
brief used to carry inside their own bubbles.

The reader is the one exception, deliberately: their own messages keep the
right-hand bubble and get no avatar. Which side a message is on is the fastest
identity signal in the stream, and Tenon has no user profile to draw a face
from — so `I asked this` stays a matter of position, and `main asked this` a
matter of the name above it. Neither is ever left to a hover.

That position comes from each `userMessage` Item's canonical author, never from its
provider role, Turn position, trigger, provenance, or client ID. Only `reader` uses the
reader bubble and may expose Edit. `agent(threadId)` resolves that source Thread's
identity and opens a speaker run. `host`, `feature`, and an Agent whose identity cannot
be resolved use the neutral Agent-event presentation and never borrow either the reader
or the transcript's own Agent identity. Mixed reader and machine steering inside one
Turn is classified Item by Item.

A participant is named by its PERSONA everywhere it SPEAKS — in the
conversation and inside its own pushed view alike — with the Agent TYPE beside
it in a quieter register: who it is, then what it is. The persona comes from
the identity catalog (`identities/get`, resolved by `resolveAgentIdentity`),
keyed by type, and an identity with none configured is named after its type,
which is what an unconfigured Role should look like. Resolution happens at
RENDER time, never recorded on the message: renaming a persona renames the
speaker of every message that Agent ever sent. A type appears verbatim, because
that IS what a user writes in configuration and passes as `subagent_type`. Two
participants show no type label at all: the conversation's own agent, per the
delegate's-badge rule below, and an isolated Skill, whose own name already says
what it is. Not the task it was handed. The
execution record's description (`count spec Markdown`) is a task label, and a
task label standing where a name goes reads as a sentence fragment rather than
as somebody speaking; the task appears right below it, as the report's own first
line. This is deliberately NOT the rule for the chip or the pushed view's TITLE bar:
both answer *which* Agent this is, and the type is `general-purpose` for nearly
every one, so there the task is the only thing that tells two of them apart.
Naming (who is speaking) and identification (which one is this) are different
questions (PM 2026-08-15). An isolated Skill keeps its own name, which is its
type.

Both halves of a header — the name and what that participant did — share one
meta rule. Styled apart, the child's elapsed
came out at content size and stood its whole header taller than the agent's
above it, so two headers that say the same kind of thing did not look alike.

The mark is sized to ANCHOR the header, not to match a line of text. Every
mobile IM does this — Slack 36, Discord 40, WeChat and Telegram 40, iMessage 28,
all against ~18px lines — and Tenon's two-line header makes the requirement
stronger rather than weaker: a disc scaled to one line covers the name and
leaves the work line under it dangling beside empty margin (PM 2026-08-18). It
centres against both lines rather than hanging off the first. Tenon departs
from those apps in one way, deliberately: they put the timestamp on the name's
own line, which is only safe because a timestamp is fixed-width. Ours grows
while a Turn runs.

The persona sits ONE STEP above the metadata beside it, and the header sits at
near line spacing from the words it names: one utterance, not two blocks. Body
size — the way Slack sets a sender's name — is right while the message hangs
from that name in a shared column; with the message at full width the header is
its own row above the words rather than their first line, and a body-sized name
jumps a third over everything else on its own lines (PM 2026-08-18). Weight and
colour carry the anchoring; the size step finishes it.

**A delegate wears its type; the conversation's own agent does not.** There is
exactly one `main`, the reader is addressing it, and labelling it states the
only thing about that participant nobody was wondering. The label answers
"which kind of helper is this", which is a question only a delegate raises.

**The header no longer shares a glyph column with the rows beneath it**
(PM 2026-08-19). That rule — the speaker's avatar centred on the same axis as a
chip's 12px glyph, its name on the chip label's text column — was written for
the one-line header carrying a 16px letter disc (PM 2026-08-15). The two-line
header anchored by a mark sized to span it (PM 2026-08-18) cannot also sit on a
12px glyph's axis; the two rules were incompatible, and the header wins because
it answers WHO IS SPEAKING while a chip is a row of content inside what they
said. What replaced it is the header's own column, below.

One header, one anchor. The header's own two lines share one left edge beside
the mark: nothing in it may poke outside the block or indent past that
edge, which is why the mark carries no optical overhang and the work line's
control carries no inline padding — as a `<button>` it otherwise wears the UA's
inline padding and steps out of the column. Within the header the PERSONA is
the only emphasis, because a message stream is scanned by who said it; the
Agent type beside it and the work line below share one quieter level. Three
separate greys made the header read as loose fragments and grouped it against
its own meaning (PM 2026-08-18).

The mark is frameless — no tile, no crop, no hairline. The form is its own
edge; the frame treatment existed for raster portraits whose painted grounds
had no boundary of their own, and it retired with them.

The avatar is a GENERATED MARK (`AgentMark.tsx`): one soft form shared by every
participant, filled with the identity's colour, with two round-capped eye holes
cut through the mask to the panel behind — so a mark has exactly one colour and
its eyes can never be mis-paired against a theme. Identity IS the colour, from
the shared `--identity-tint-*` palette: the default roster pins well-separated
hues (Aspen teal `main`, Rena orange `explore`, Ada blue `plan`, Bruno amber
`general-purpose`), and every other identity derives its hue from its type name
(core `deriveIdentityColor`) over the hues the roster did not take — a
user-created Role is distinct the moment it is named, nobody draws anything,
and a fresh Role can neither walk in wearing Aspen's teal nor the
danger-adjacent red (PM 2026-08-18, replacing the portrait assets tried
first). The conversation's own agent is named the same way as the rest and does
NOT carry the product's name: a transcript names the participants in it, not
the application they run inside (PM 2026-08-18). Keyed by Agent TYPE: **one
type, one mark — everywhere, in every conversation.** The marks are ALIVE, within strict bounds:

- **Expressions.** The eyes are one thick round-capped stroke per side,
  parameterised (`agentMarkGeometry`); a mood is data over that rig, so states
  MORPH rather than swap. Moods restate state the text beside them already
  tells, never more: a Turn in progress reads down and scans (working), one
  blocked on an input request looks straight out (needs-you), a failed Turn
  droops — sorry, not angry, because an agent that failed the user has nothing
  to be cross about — a user-interrupted one sleeps, and a delegate signs its
  delivered report with a smile (or the failure's droop, or the stop's closed
  eyes). Everything settled and ordinary is idle.
- **The sphere.** The face is a ball, not a disc: each eye is a point on a
  sphere, the pose turns it, the far eye narrows toward the limb, and the
  stroke is clamped inside the silhouette — a hole crossing the outline reads
  as a bite out of the face. A unit invariant sweeps every mood over the full
  pose envelope and holds containment.
- **Gaze.** While the pointer crosses a speaker HEADER, that mark turns to
  follow it with inertia (the head has more mass than the expression); events
  bind to the header only, so a still pointer costs nothing. A working mark
  scans line-by-line on its own.
- **Blinking.** Mostly both eyes, now and then just one, each mark on its own
  clock, fast shut and unhurried open. A blink is a rig PARAMETER — the stroke
  collapses onto its own anchor — not a CSS transform on the mask group: a
  scale there is the layout-free "pop" B7 refuses, and its duration would be an
  untokenized motion literal (B1). The stylesheet holds no animation for the
  mark at all. Closed-eye moods (done, stopped, failed) do not blink.
- **Motion discipline.** One module-wide rAF loop animates only marks with
  something actually moving, stops when none has, and sleeps between blinks on
  a timer; marks scrolled out of view hold still. Updates are ref-driven
  attribute writes, never React state (A9). A scheduler that calls back
  synchronously is guarded against re-entry. `prefers-reduced-motion` keeps
  each mood's static shape and stills everything.
Derived rather than enumerated, since a project can name a type anything at all
in `.claude/agents/*.md` and a hand-kept table would miss exactly the ones that
matter to that workspace. Keyed by Agent id instead, two `general-purpose`
siblings shared one NAME in this stream but wore different discs — saying they
were different kinds of participant — and the same Agent was repainted on the
way into its own pushed view (PM 2026-08-15). What tells two siblings apart is
the task on each one's report, not its colour. `main` is pinned to an
untranslated key, so it is neither rehashed per conversation nor repainted when
the language changes. Red is excluded: it sits
next to `--status-danger`, and an Agent that reads as an error every time it
speaks is a worse trade than one fewer hue. This is the design system's
**identity** category (`design-system.md`), distinct from functional state (B3,
neutral), status (B4), and the rose accent (B4) — the same category the tag
chips already use, so the app reads as one coordinated set rather than three
inventions. Identity colour never paints selection, hover, active, focus, or
status; those stay exactly as neutral as they were. A hue may repeat across a
large conversation; the name beside the disc is the identity of record.

Each Turn after the first IS a new generation, and nothing marks it as one. A
generation counter is the execution record's word for a resume, not the
reader's, and the message that started the run is directly below the boundary
anyway: their own bubble, or one under the avatar and name of the Agent that
sent it (PM 2026-08-15, replacing the ratified `Generation 2 · Continued by
main` divider).

Every embedded child drops Edit and Continue in new chat because neither
rewrites or forks child history; they are hidden rather than disabled, because a
control that never works is not a control. Copy and Open Trajectory stay, because
both work.

The composer is the physical form of user authority. A message sent here is the
top-priority instruction for that Agent and is the only action that clears a
user stop, so a user-stopped Agent's placeholder says so
(`Message this Agent… (resumes after your stop)`) rather than leaving the rule
to documentation. An isolated Skill has no composer: its result is owned by the
`skill` call that invoked it.

The title bar states identity and NEVER moves: the Agent's own transcript is
directly below it and carries the live cue on the most specific row that is
working, so a moving title would be the same work claimed twice.

A retained managed worktree gets a footer naming its branch and the number of
changed paths, with a control to list those paths and one to reveal the
directory. The renderer names the Agent, never a path: main resolves the
directory from the execution record, so no renderer-supplied path can turn the
footer into an arbitrary filesystem read or a Finder window anywhere on disk. A
removed worktree is a tombstone and never resolves — the footer does not offer
to open a directory the host has already deleted. Tenon has no diff viewer, so
"view changes" lists the changed paths rather than pretending to be one.

Parent Thread Details lists the descendant subtree newest-activity first with a
readable name, status, and last activity; the read names the subtree while the
Thread catalog keeps each status current, so a child that starts or stops while
the dialog is open does not go stale. Each row opens that child in the same
pushed view, carrying its lineage so a grandchild opens at its own depth rather
than at the ancestor that happened to be reachable, and each can be deleted. A
bulk action removes finished Subagents, which means Threads whose whole subtree
has stopped: a finished parent with a running child is never swept, because
deletion cascades, and neither is a child holding queued work, because idle is
not finished — work already handed to it has not run yet. Both deletions are
confirmed first and re-decided against a fresh read at the moment they are
confirmed, since deletion force-stops a live subtree and cannot be undone.

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
- Agent-task Items and Subagent activity link directly to their canonical child
  Thread. Every delegated form is projected through the same row, including an
  isolated Skill child whose `skill` call is still in flight. Within one parent
  Turn, all activity for the same Agent ID and child Thread collapses into one
  presentation row. That row stands in for the tool call that delegated the work
  — `skill` or `agent`, named by the spawn-time Item's `spawnItemId` — and takes
  its canonical slot. The raw tool exchange stays inspectable in Trajectory. Only
  spawn-time activity claims a slot; a terminal event flushed into a later Turn
  keeps the original row rather than claiming an unrelated call.
- Projection membership comes from canonical parent lineage and Agent execution
  records, never an in-progress wait Item or a model-maintained roster. The row
  combines Agent ID/generation, the Thread catalog, the latest canonical child
  `turn/started` or `turn/completed` DTO retained by `threadStore`, durable
  activity, and pending notification state. Updates are monotonic within a
  generation, and a later resume advances the same Agent identity to a new
  generation rather than creating a second logical Agent. This lets a running
  row show elapsed time and settle immediately even when paged child history is
  unloaded. A catalog reload drops latest-Turn cache only for a root it actually
  omits; subtree deletion drops the complete related projection.
- Agent ID and child Thread ID are stable identity; neither is normally display
  copy. Agent rows display the task description first, then Role nickname or
  canonical Agent type, and finally a shortened ID. An isolated Skill displays
  the recorded Skill name and uses its internal child identity only to
  disambiguate repeated runs. The child Thread's source chooses the delegated
  form; address-like text never changes semantics. Row title, accessible name,
  child header, and Thread Details use the same display-name projection.
- Display names are unique within a Turn. Two runs of one Skill would otherwise
  render two identically-named rows, the address suffix that told them apart
  being exactly what the row stops showing; repeats are numbered in canonical
  order, so the visible row, its title, and the accessible name a screen-reader
  user selects a button from all disambiguate together.
- A row reads name first, then its status as a trailing segment — the status
  vocabulary plus elapsed time when known; idle remains distinct from completed.
  A running child measures from its start; a settled one has no clock left, so
  the duration is the one its own Turn recorded, and a row left with only a
  terminal Item after a reload states the status alone rather than inventing a
  span. The form glyph and identity name stay static while a `pendingInit` or
  running status phrase alone uses `WorkingText`; the separate fixed-size Stop
  action remains available while the child can be interrupted. The lifecycle
  line reserves its available width, its disclosure consumes the flexible
  slot, and the elapsed phrase uses tabular numerals, so digit and unit changes
  never move Stop.
  The name ellipsizes and the status never does, so a row can never truncate
  away the outcome it is reporting. A failed row exposes a
  bounded user-facing error on its own wrapping line and tints its glyph and label with
  `--status-danger`; interrupted and unavailable rows stay muted. These colours
  survive hover and focus — the hover treatment exempts them rather than
  repainting a failure neutral — and every status is also named in text and
  accessible labels
- persisted Agent result snapshots contain the ID/generation, child identity,
  status, canonical type, display metadata, and notification state needed for
  historical rendering. Live projection wins over a stale snapshot; the
  snapshot remains inspectable after child deletion. Renderer user surfaces do
  not promote transcript paths, task IDs, pins, or budget receipts into labels.
  When an Agent-task tool detail is expanded, each child keeps its Agent glyph
  and identity static while a live status phrase uses `WorkingText`; that
  mounted child status owns motion instead of the parent tool summary
- Memory used by an answer renders through the ordinary inline Node-reference
  affordance next to the supported claim; `outline` shell calls remain in the
  process and Trajectory, with no separate Memory Item or disclosure
- context evidence stays hidden from the ordinary transcript; `contextReset` and
  `contextCompaction` render dedicated `Context cleared.` and compaction boundary rows
  at their exact canonical positions. A completed standalone `/clear` or `/compact`
  feature Turn opens Trajectory focused from that boundary and does not synthesize an empty
  response row with Copy or Continue-in-New-Chat actions

### Agent Anchors And The Work Strip

Presentation re-derives an Agent's lifecycle from the canonical execution record
projected across the seam (`thread/subagents/list` plus
`subagent/execution/changed`), never from a wait Item or a model-maintained
roster. The renderer holds one REGISTRY keyed by the stable Agent ID, scoped to
the conversation subtree, built from those records joined to each child Thread
and its current generation Turn. A resume appends a generation to the same
Agent, so a Turn-anchored projection would duplicate that Agent under every Turn
that touched it or orphan the generations no Turn owns.

The record's `currentTurnId` names the generation being described. When the
renderer holds that exact Turn it supplies the duration and the typed error;
otherwise the durable terminal status still states the outcome, so a
conversation reopened days later never calls a finished Agent `Idle` for want of
a Turn it never loaded. A delegated child whose record was retired is still
readable: its identity is synthesized from the Thread, because a chip that said
`Not found` about work the conversation plainly did would be a worse answer than
a thinner one. Uncommitted admissions are absent by construction — the host
publishes no start for one and may still roll it back, so a chip for it would be
a delegation the conversation never made.

The conversation is the only narrative, and every lifecycle event leaves an
ANCHOR in it at the point where it happened:

- a **spawn chip** at the delegating call's canonical slot. The chip replaces
  both the call and the activity row that repeated it — one delegation reaching
  the reader twice in two vocabularies is the thing this collapse exists to
  prevent — and it can never precede the reasoning that produced it, because it
  takes the call's slot rather than the activity's;
- a **resume chip** at each later `agent_message`, referencing the same Agent;
- a **report** at the head of the Turn the host started to deliver a result: the
  Agent's own terminal answer, rendered as a MESSAGE from that Agent. It stands
  exactly where the model-facing notification context would be and replaces it,
  because that context is host framing addressed to the model and never a message to the
  reader. Position is identity here too (above): the report is one more speaker
  in the stream — its own avatar, its own name, its own elapsed on that header
  line. Its body
  sits in an OUTLINED CARD rather than in the prose column `main` uses, because
  it is not part of this conversation's narrative: it is a self-contained thing
  brought back from somewhere else, which the reader may open. An outline says
  that; a fill would shout it and bare prose would hide it. The card's first
  line is the task the Agent was handed, suppressed when the header is already
  saying it — an Agent with no type falls back to its task description for a
  name, and one sentence printed twice is not a heading.

  The WHOLE CARD is the control that opens the Agent (PM 2026-08-15). A preview
  of something you can open should open when you click it, rather than hiding
  that behind a link in its corner. Its body is clamped and faded rather than
  carrying a Show more: once the card opens the full transcript, an in-place
  expander is a second, weaker way to read the same thing. Content inside takes
  no pointer events, so there is exactly one thing a click on the card can mean.
  It signals itself with the neutral fill ladder and the focus ring, never a
  hand cursor (B3, B8, B10), and it says what it does through a hint occupying
  the message actions' own slot at the message actions' own height — so
  revealing that on hover moves nothing (B7) and a report ends exactly where any
  other message ends. The hint carries a POINTER, not a chevron: what that row
  teaches is that the card takes a click, which is the one thing about it a
  reader cannot see.

  A report keeps the measure every message here keeps (`min(100%, 520px)`): run
  to the full width of a deck the reader has widened, it stopped reading as one
  thing somebody said and started reading as a panel. And it is a block like any
  other: its BOX sits the same distance under its speaker's header as a
  paragraph's first line sits under its own, with no
  optical compensation for the padding it carries. Inside, it breathes on the
  prose rhythm — container-to-text is the same distance as text-to-text
  (`.thread-markdown > * + *`) rather than a tighter one of its own. Pulling the
  card up to align its first LINE with a paragraph's instead was tried and
  rejected (PM 2026-08-15): it made the two headers sit differently over their
  content, and a negative first-child margin also shifted measured heights
  during a streaming scroll replay. One grammar, so a report reads as somebody speaking rather than as one
  more row of what the Turn did. A pill-shaped fold-to-nothing row was tried
  first and drowned among the tool rows (PM 2026-08-15). Its speaker is the
  CHILD, not this transcript's own agent, so a delivery Turn shows two speakers
  in order: the child reporting, then the agent that read it answering. It never
  wears the READER's bubble: Agent output is
  untrusted content, and a surface that let it pass for the reader's own words
  would be the first step in the laundering the protocol refuses. A `Details ›`
  control beside it pushes the Agent's own view, so reviewing a finished Agent
  never requires scrolling back to the spawn point. The Turn's trigger names the
  call the notification answers, so the conversation's anchors are the index
  that resolves it across Turns. Only the Turn's FIRST user-role Item is that
  notification: a steering message typed while the continuation is still running
  is admitted into the same Turn and belongs to the reader. The delivery receipt
  names the exact generation and canonical child Turn, so a missing or
  non-materialized notification cannot shift an older card onto another run.
  History is fetched once per Agent when the first report renders, since a
  message with nothing in it is not a message;
- a **stopped note** in place of the completion narration for an Agent the user
  stopped, naming the resume path.

Terminal activity Items render nothing. Every spawn and resume chip carries the
generation identified by child Turn provenance. While that generation is live,
the chip reads stable-Agent liveness; after it settles, the chip reads its
immutable receipt. A historical failed or interrupted chip therefore stays
factual while the same Agent works in a later generation. A second terminal row
would duplicate the receipt in a place the reader never asked about.

A chip carries the delegated form's glyph, the Agent's name, a worktree mark
when it is isolated, and one trailing status segment; it shares the type ramp
and resting colour of the tool rows around it, because a delegation is one more
thing the Turn did. The Agent TYPE is not on that line (PM 2026-08-15, replacing
the ratified `truncating name, muted type`): it is `general-purpose` for almost
every Agent, so it spent the name's room on a fact the reader rarely needs and
truncated both to `統計 renderer TSX …` `general-purp…`. It rides the chip's
title and accessible name instead, where a specialized `explore` or `plan` is
still reachable. It is a way IN, not a disclosure: nothing about it claims an
expandable region, and it carries the trailing `›` that ordinarily means "opens
somewhere" rather than the leading disclosure chevron the tool rows beside it
rotate open in place. A live background chip carries a Stop that reaches that Agent alone; a
foreground chip says the parent is waiting on it, because a foreground child
shares the invoking Turn's cancellation lifetime by contract. Like every
delegation surface a chip speaks time and status only: no token quantity reaches
its text, its title, or its accessible labels, and a failure carries the same
bounded, code-classified copy the tool rows use, on its own wrapping line — a
failure the chip had to truncate is a failure the reader cannot act on.
Terminal chips and report cards state the run-scoped outcome, notification
progress, and partial-output availability from the receipt. Report speaker
metadata owns duration, so the card does not repeat it. Stable-Agent status such
as `Working` remains ambient liveness in the work strip and never recolors or
renames a historical outcome.

The WORK STRIP is the only ambient status: one pill in the deck header, present
only while this conversation has live or just-finished BACKGROUND Agents, that
opens a full-width dropdown under the header (the deck is too narrow for a
side-hung popover, so this is the one Liquid-Glass material in the transcript's
file, with the shared opaque fallback). Rows sort running > stopped >
just-finished, by what the reader can still act on. A finished row lingers
briefly and leaves; when the last row leaves, the pill leaves with it, so the
idle deck and the everything-finished deck are the same deck. A conversation
whose Agents finished before it was opened shows nothing at all — old work is
not news. Foreground work never appears here: it belongs to the Turn it blocks,
and saying it twice would make the conversation look busier than it is. A parent
with live descendants appends a child-task count to its own row rather than
flattening the tree into the strip. The strip never becomes an archive; the
conversation is the archive, and every Agent has an anchor there.

There is no dock-level agents panel across conversations; cross-thread awareness
is the Thread list's activity indicator.

Superseded (PM 2026-08-07): the earlier shape pinned a live card above the
timeline and stood the per-child rows down while it was up. It gave one
delegation two presentations in two positions and two visual languages, and put
the card above the reasoning that produced the delegation. "No dock-level agents
panel" stands unchanged; "the card replaces the rows" does not.

A completed Turn with a final answer and known duration folds its process Items
under the established `Worked for ...` disclosure while leaving the answer
outside the fold — unless a child it delegated is still running. The fold
defaults to closed, and a live Agent's chip, elapsed time, and per-Agent Stop
live inside it, so a Turn that settled while its child kept working (the
fire-and-forget shape whose result lands in a later Turn) stays unfolded until
that child settles. Work still happening and still stoppable is
not history yet. Live and resultless process timelines remain visible; a live
timeline uses the established `Working` / `Working for ...` status row even
before its first process Item arrives. A foreground `agent` call remains an
ordinary in-progress chip while it blocks, saying that the Turn is waiting on
it; background Agents remain visible after the parent Turn settles until their
direct-parent notification is consumed. There is no wait-specific status or count. Rendering builds one
Turn-level process projection from every reasoning, non-empty commentary,
image-view, Subagent, and tool Item. That block is placed before the first final
response regardless of the Items' persisted arrival order, so a late reasoning
Item cannot appear below the answer. A provider-retry partial carries the
`interrupted` message phase: it remains visible before the process block but is
not treated as the final response and receives no response tail. The process
disclosure contains the independent reasoning,
activity-group, and tool detail disclosures rather than replacing them.
An empty process does not render an empty timeline container. The status line,
separator, visible timeline, and following answer use the same tokenized
vertical interval on either side of the separator. Within the timeline, the
direct reasoning summary, expanded reasoning body, and adjacent compact process
rows use one shared tokenized interval; reasoning between separate tool runs
therefore has the same visible interval above and below, and expansion does not
introduce a tighter internal step. Empty commentary Items are removed at this
projection boundary rather than only hidden by the leaf renderer, so an
inspection-only provider boundary cannot create an empty process block, split a
consecutive tool group, count against lone reasoning, or add an invisible flex
interval between visible rows.

The live status row uses `WorkingText` only while no more-specific mounted live
tool, empty `Thinking` placeholder, Subagent status, or readable streaming Item
owns or statically suppresses that cue. Once a specific process representation
exists, the Turn summary stays static. One synchronous `turnMotionOwner`
classification assigns the live cue to the summary, a mapped leaf, or neither;
the summary and response shape consume the same result without mount-time
registration or a post-commit handoff. Completed collapsible summaries and
terminal summaries are always static. A live status title occupies its full
divider width and uses tabular numerals, so its once-per-second elapsed update
does not resize the visible title slot.

The status line never claims more than the run is doing. A settled Turn is
described in the past — it never falls through to the live `Working` label —
and when a Turn is **blocked on the user** (`waitingOnUserInput`) the line says
so and contains no `WorkingText`, because motion would claim progress. This
applies to every mapped leaf in that Turn, including the still-in-progress
`request_user_input` tool row, Subagent status, and closed Plan summary; each
keeps the same static phrase and geometry. The
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
finished. Live reasoning disclosures start folded even while their Item is the
streaming tail. An explicit expansion is recorded and remains open when a newer
Item arrives. Reasoning first observed while its Turn is live stays folded when
that Turn settles, so completion cannot insert the body under the reader. A
lone multi-line terminal reasoning Item first observed only after settlement
still opens for readability; that terminal default and the live-observation
latch are Thread-session state, not persisted overrides. The empty placeholder
carries the same classes as the populated one so the first token does not
restyle the element. Provider recovery belongs to the matching Turn's response
footer and replaces its rose generating indicator; request recovery reads
`Retrying {current}/{max}`, stream recovery reads
`Reconnecting {current}/{max}`, and neither appends a second row below that
indicator. While recovery is visible, that Turn renders every
mapped working phrase through its ordinary static text branch, including a
closed Plan outside the transcript, so the retry spinner is its sole motion
owner. This arbitration is passed explicitly within one `ThreadView`; it never
uses descendant selectors that could cross into an Agent's pushed nested
`ThreadView`, and a child retry cannot suppress its parent's working phrases.
The visible footer retry is hidden from accessibility APIs. A separate
visually-hidden `role="status"` announcer stays mounted outside the virtualized
Turn list, so retry changes remain announced even when scrolling unmounts the
live Turn. Its spinner honors
`prefers-reduced-motion` and the state is cleared when a new Turn starts or the
Thread list reloads, so it cannot outlive the attempt it describes.

An active Turn ends with one rose shape indicator after all currently visible
process and response content. It is the stable generating affordance for both
empty and streaming responses; Markdown does not add a second caret. The
indicator occupies the same persistent response-footer slot as the terminal
Copy, Continue in new chat, and Open Trajectory controls, and swaps to those
controls without moving the response. User-message actions likewise fill a
persistent slot that remains empty and non-interactive while the Turn is live. The indicator
stays present but static while that Turn has a `WorkingText` owner, and reconnect
recovery replaces it in the same footer slot; one Turn therefore never presents
two concurrent motion owners. Increased contrast removes the text sweep and
therefore restores this shape's animation as the live motion cue for an eligible
live Turn; a blocked or recovering Turn keeps the shape static in every contrast
mode because it cannot claim progress. Reduced motion still stops both shape
animations. The shape suppression query is the exact complement of
`prefers-contrast: more`, so `less` and `custom` contrast modes retain the same
single text-motion owner as the default mode. A failed or interrupted Turn
with partial response prose keeps its process presentation neutral because the
response tail already owns the terminal error or stopped state.

A latest failed persistent root user Turn asks main for recovery capabilities with
`turn/recovery/read`; renderer does not infer eligibility from visible Items. When both
are available, its response actions begin with **Continue from failure**, then
**Rerun turn**, before Copy, Continue in new chat, and Open Trajectory. A failed
capability read hides both recovery controls without breaking the transcript.

Continue is available only when main revalidates an idle, latest failed Turn and the
real model's canonical projection contains at least one complete settled assistant/tool
unit beyond accepted input. It sends only `{threadId, turnId}` through `turn/continue`.
Success preserves the failed evidence row and appends a new Turn whose typed
`continuation` trigger points to the source. Its content-free host input stays hidden,
while canonical application context tells the model to treat settled history as evidence
rather than redispatching tools. An interrupted assistant tail, incomplete protocol unit,
stale source, or projection failure offers no Continue and performs no write.

Rerun is the explicit whole-Turn replay path. Main reconstructs the replacement from the
sealed Turn's structured input batches, stable client IDs, accepted timestamps, admission
evidence, exact authors, and original trigger. The initial input and every accepted
steering input retain canonical order and evidence/user-message boundaries; failed-attempt
assistant/tool output is excluded. A host-authored subagent delivery therefore remains
host-authored, and renderer never reuses Edit's rollback-and-send path or visible prose.

Rerun is offered only where replay can run and could end differently: the latest Turn,
an enabled composer on a persistent root user Thread, and a qualifying failure or
host-restart interruption. A structural depth limit does not qualify, and user Stop
remains a decision rather than a failure to replay. If the source contains any settled
tool, the action first opens a broad confirmation that replay may repeat actions. Cancel
sends no mutation; Confirm sends `confirmToolReplay: true`. A source without settled
tools sends `false` directly.

Main serializes Rerun with renderer submission and root host admission, then prepares
every fallible step while the failed Turn remains canonical. One internal
`history/rerun` event removes the suffix Turn from current projection and inserts the
replacement `turn/started` in one SQLite transaction; rollout evidence remains
append-only. Admission or append failure leaves the old Turn intact, and restart sees
only the complete old or complete replacement state. Both recovery commands latch while
their round trip is in flight and report refusal in place rather than swallowing it.

Unknown Item kinds are protocol errors, not generic fallback cards. Item status
comes from the Item itself; the renderer never infers completion from missing
events.

Agent Markdown reuses the shared read-only code surface and dual-theme Shiki
highlighter. Streaming text commits are throttled to 80 ms. For a pure append,
the complete source is repaired so inline-marker context can cross block
boundaries, then lexing restarts at a safe blank-line boundary. Complete-source
repair is an output-equivalent split of `remend@1.3.0`'s handler order:
structural handlers, a renderer-local one-pass emphasis stage, then inline-code,
strikethrough, and KaTeX handlers. The local stage carries code, math, link-URL,
HTML-tag, escape, and delimiter context once instead of rescanning the preceding
math context for every emphasis marker. An incomplete-link early return and a
single trailing space exposed by incomplete-image removal retain `remend`'s
original stage semantics. The adapter remains byte-equivalent to canonical
`remend` after every append; it is a cost change, not a repair-policy fork.
The differential suite compares against the installed dependency, making an
upstream behavior change fail before the renderer-local `remend@1.3.0` behavior
can drift silently. Text without emphasis markers delegates directly to
canonical repair. Inputs containing `*` or `_` take the linear path even without
math because upstream marker searches query preceding math context before they
reject many literal markers. The linear path builds one context map and reuses
its frozen end state for synthetic closing markers, so ordinary prose does not
regress and an unfinished emphasis marker does not rebuild the full context per
handler.

The reparsed tail retains the last two substantive tokens and trailing
whitespace; a repaired prefix that differs from source or contains an unmatched
reference-label opener is not frozen. A non-append edit, lexer failure,
definition-set change, or token stream that cannot account for every source
byte falls back to a full repaired lex; the definition fallback is required
because definitions are attached to every visible block. Repairing the complete
source is a correctness requirement, not an optimization: it is what lets the
bounded tail lex match a full repaired lex byte for byte. On the gate-shaped
dollar-plus-emphasis fixture and identifier-heavy Markdown without dollars,
canonical repair remains superlinear while the split repair is linear. The
dollar-plus fixture is about 18x cheaper at 40 KB (5.1 ms versus 92 ms in the
latest isolated probe); the no-dollar `snake_case` and `w*h` fixture is about
22x cheaper (5.5 ms versus 121 ms). A 40 KB commit ending in unfinished emphasis
also stays on the linear path. Stable completed blocks are memoized, and every
block keeps the same memoized React component identity as the final streaming
block seals.
Canonical Node (`[[node://UUID]]`) and absolute local-file
(`[[file:///absolute/path]]`) reference markers render through the same inline
reference and preview surfaces
as the outliner; Cmd/Ctrl-click preserves new-pane navigation, and HTTP links use
the app preview route. User messages retain Copy and, for the latest terminal
Turn only, Edit; final agent messages retain Copy, Continue in new chat, and
Details, preceded by any main-authorized Continue/Rerun actions. User messages that exceed five reading lines retain the established
measured Show more / Show less disclosure instead of
growing the transcript without bound.

Canonical Thread markers use `[[thread://UUIDv7]]`. Structured user references and
model-authored markers resolve the current canonical title at render time, so rename
changes presentation without rewriting stored content or identity. An available target
opens the referenced Thread; current, missing, deleted, corrupt, or denied targets remain
visible typed non-actionable references with a shortened UUID fallback when metadata is
unavailable. Escaped markers, code spans/blocks, markers already owned by a Markdown
link, malformed IDs, and unknown schemes remain ordinary text.

A terminal Agent answer remains the model-authored Markdown byte sequence; Host
binding never rewrites its file markers. At finalization, main parses only unescaped
`[[file:///...]]` markers and records ordinal-aligned `finalCitations` on the final
`agentMessage`. A regular file normally binds both the current source locator and an
exact captured revision. A directory binds source navigation only. Pending,
unavailable, and denied bindings remain typed data states and never turn a useful final
answer into a failed Turn.

The renderer uses the marker text only for its label and source-facing action. When a
binding carries an opaque resource reference, Preview/Open resolves that exact delivered
revision through the owning Thread; it does not trust the URI path or interpret the
opaque ID as a filesystem location. Reveal/Edit Source resolves the current source
locator independently and never substitutes the exact scratch observation. A source-
only directory exposes navigation but no delivered-revision preview. If either
representation is unavailable, the inline reference remains readable and only the
affected action is unavailable. Pending, unavailable, and denied bindings remain bound,
non-actionable inline references; renderer projection never falls back to ambient access
through the marker's raw path. An available binding without its owning Thread identity
degrades the same way. These read-only references use neutral secondary text and the
native arrow cursor, with no link underline, fill, or shadow on hover. Composer history
and session registries compare opaque
reference fields; they never derive equality or access from a digest-shaped ID.

User-message rendering is a presentation projection over canonical
`ThreadUserContent[]`; it does not claim to show provider part order. Every image
attachment in one message is collected in canonical image order into one leading
gallery. Every attachment, including each gallery image, also retains its inline
file reference in the following narrative at its canonical position. The reference
is not duplicate decoration: it exposes the same attachment identity and readable
path represented by the provider-facing canonical file-URI marker, while the gallery is
only a visual preview. Text, Node references, Thread references, directories, and file references form
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
Trajectory consume the
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
and Node or Thread references contribute their current display names. The visible narrative
uses the same adjacent-attachment separator, without changing canonical content. Copy
does not include the presentation-only gallery or claim to reproduce the provider
request. Execution-lifetime managed-resource paths are never invented in renderer
copy; the Model Call export remains the authority for the recorded provider payload.

Transcript document reads are scoped to the Node ids a Turn actually presents:
structured user references, Node markers in assistant/reasoning Markdown, and
Node subjects in tool activity. A relevant rename or derived tag-color change
refreshes the reference chip, tool subject, and process header; unrelated
document deltas do not render the Turn. Copy resolves Node names from the current
document index at click time rather than from the last rendered snapshot.
Serialized markers carry identity only: Node titles and file basenames are
presentation, never URI fields. Escaped markers, markers inside code, and markers
already owned by a Markdown link remain literal/non-interactive. Unknown schemes
are not promoted, and a syntactically valid marker never bypasses document or
filesystem authority checks.

A terminal response owns one action row directly below its visible content.
Every terminal response exposes Copy, Continue in new chat, and Open Trajectory as
applicable. Continue in new chat is the only user-visible history fork action
and uses the `afterTurn` boundary. There is no separate Turn footer or second
action surface. A
failed response keeps any partial answer first, then shows a bounded, parsed
error summary, then the same action row. JSON and HTML provider payloads never
render as unbounded transcript prose. An interrupted response uses the
established quiet stopped row and the same three actions. Hover and keyboard
focus reveal the row without changing geometry.

Agent request limits are system internals. Stable admission- and mid-Turn-budget
errors carry `subagent_budget_exhausted`; renderer surfaces classify that code rather
than model-facing copy. They translate it before transcript display or copy into
localized resource-limit copy that says produced results were preserved. The same
translation applies in structured Automation run errors. Token counts never
render on these user-facing error surfaces; Trajectory is the separate technical
surface for retained usage and evidence.

Copy on a response copies the complete assistant side of that Turn in order:
commentary, tool arguments, full tool results when available, and
the final response. Tool arguments use the canonical envelope and never reverse-map
command, file-change, MCP/dynamic display, Agent-task, or result fields. A partial
failed response remains the copy authority; its
error summary is used only when the Turn has no copyable assistant content.
Right-clicking the terminal response opens the native message menu with the same
Copy, Continue in new chat, and Open Trajectory commands.

The Open Trajectory icon preserves the established two-level interaction without
duplicating information surfaces. Hover or keyboard focus shows one
non-interactive card whose primary text says that the action opens Trajectory,
followed only by compact total token and cost facts when those values were
recorded. It does not show explanatory inspection copy, timestamp, provider,
model, reasoning effort, tool count, duration, or cache details; those belong in
Trajectory. The card is content-sized, anchored in a portal, and cannot be
clipped by transcript scrolling. Clicking the icon, or choosing Open Trajectory
from the native message menu, opens Trajectory in the active workspace pane,
focused to that Turn.

Trajectory is the Thread-wide technical workspace. It is a main-owned,
inspection-only projection over canonical Turns, retained diagnostics, context
payload references, and tool output references; it is not a second execution
ledger and it is not derived from renderer transcript pagination.

DeepSeek Harness `TrajectoryView`, `TrajectoryToolbar`, `TrajectoryTimeline`,
and `TrajectoryTable` are the product-interface authority for this workspace's
composition, density, information hierarchy, synchronized selection, range
navigation, folding, and adaptive inspection. Tenon retains its own breadcrumb,
workspace navigation, process boundary, security rules, and design tokens. The
result is a compact sequence of full-width bands: the Tenon breadcrumb, one
34-pixel toolbar, a three-lane Input / Assistant / Tools overview, then a dense
ledger with a conditional inspector. It is not a generic reading page, a stack
of summary cards, or a copy of the DeepSeek Harness application shell.

The toolbar owns the Duration / Sequence mode, whole-Turn fold, whole-Assistant
call fold, and loaded-window search. Search filters the loaded ledger and dims
unmatched overview spans; it does not claim to search unloaded history. The
toolbar does not expose summary totals, refresh, tail-follow, or export actions;
those controls add visual weight without improving the primary debugging scan.
Loading an earlier page prepends records while anchoring the reader's visible
content.

The overview uses recorded geometry rather than decorative equal-width blocks.
Duration mode places spans against wall-clock time, preserving gaps and overlap;
Sequence mode allocates ordered reading space without claiming elapsed time.
Input, Assistant, and Tools occupy fixed lanes. A span clears the timeline focus
and selects the same record in the ledger. Clicking overview whitespace creates
a minimum-width focus window and scrolls the nearest ledger record into view
without opening the inspector. Primary-button range drag creates a timeline
focus: the ledger stays complete, rows inside the focus stay normal, rows outside
the focus are visually de-emphasized, and the ledger scrolls to the focused
region. `Escape` on the overview clears the focus without resetting the zoomed
viewport. Wheel input zooms around the pointer, secondary-button drag pans the
visible domain, and a secondary click clears the focus. Assistant spans
distinguish time-to-first-token when that fact exists; running or untimed work
uses a marker and never fabricates duration. Live record updates may extend the
full domain but do not erase an explicit viewport or range.

The ledger is message-first: every record occupies one fixed 30-pixel table row,
with a compact localized role tag followed immediately by its content preview.
Typed labels, IDs, evidence references, lifecycle metadata, timing, and usage remain
secondary scanning aids and cannot displace the content column. Records preserve
recorded activity order and group by Turn. Turn folds and Assistant-call folds
leave one stable content row plus a stable summary row rather than removing all
context. System-like rows (`System` and provider-visible `Tools`) are outside
Turn folding, so collapsing a Turn never hides the request header evidence. The selected row
stays reachable through folding, filtering, paging, and virtualization. More
than 100 visible candidates use a fixed-row virtual window with bounded
overscan; search indexes, record maps, grouping, and timeline geometry are
derived once per relevant input instead of recomputing at pointer frequency.
Type chips use identity/status tokens for scan color while hover, selection, and
focus remain neutral functional state.

The initial Thread-header entry has no selected record and therefore shows the
ledger at full width with no empty inspector. A Details deep link selects its
exact record and opens detail immediately. Selecting any row suspends tail
follow; scrolling away from the tail, choosing a range, or inspecting old
evidence also prevents live updates from pulling the reader back. Loading newer
history is an explicit ledger action, not an automatic side effect of selection.

Selection lazily mounts the record-specific inspector. Above the narrow-layout
breakpoint it is a resizable companion beside the ledger; at or below that
breakpoint it replaces the ledger and exposes Back, so neither surface is
compressed below its readable width. Closing the wide inspector returns to the
full-width ledger without navigating away from Trajectory. Inspector tabs remain
content-first: Input uses Summary / Preview / Request / Raw; Context uses
Summary / Preview / Raw, with System Prompt for stable-prompt evidence and Tools
for provider-visible tool catalog evidence; Assistant uses Summary / Preview /
Request / Raw; Tool uses Summary / Input / Output / Schema / Raw; Retry,
Compaction, and Delegation use Summary /
Preview / Raw, and Delegation can open the child Thread's own Trajectory. Raw
means Tenon's typed, bounded, credential-redacted evidence with captured
filesystem paths preserved, not an unfiltered transport body. For Input and
Assistant details, Raw renders ordered typed model parts first and then the
complete typed detail envelope; the part view never replaces canonical message,
diagnostics, provider request/response, runtime, call-index, or related-item
evidence. The Request tab
is the consumed provider call's materialized post-adapter payload after
credential redaction and binary omission; it is never folded into the USER
preview. System Prompt, full model-context Preview, structured Request, Tool
Input, Tool Output, Schema, and textual Raw parts use the same bounded read-only
evidence container with an explicit copy action. Copy returns the exact retained
string shown for raw text; typed structured values are pretty-printed once and
copy returns that exact visible serialization. Valid JSON raw text may receive
syntax highlighting but is never reparsed and reserialized for display. Long
lines wrap inside the container without changing copied content. A full Input
Preview uses the same container independently for each text part, while its
compact Summary keeps plain inline evidence and image evidence remains a typed
metadata block. An Input image block replaces its placeholder icon with a real
thumbnail only when the captured image digest exactly matches a retained
canonical attachment's observation digest. The attachment name labels that
block; a missing match or failed artifact read keeps the icon and captured MIME
type, byte length, and digest metadata. Trajectory detail remains binary-free;
matched thumbnails load separately through the bounded preview IPC.
Final Assistant prose, compaction summaries, and delegation results remain
reading surfaces; their exact typed parts stay available in Raw. Input Preview
uses the ordered provider-neutral prepared-message parts
captured before that adapter for the exact canonical `userMessage` Item.
Diagnostics tag every `userInput` content part with its Item ID, so initial input
and later steering can share a provider call without repeating or borrowing one
another's parts. Text parts retain their credential-redacted text, including
exact filesystem paths; image parts retain
their position plus MIME type, byte length, and digest. The Preview therefore
includes the real serialized attachment reference and inspection instructions,
Node reference marker, image metadata, and explicit image-part marker while
excluding image bytes and system-context parts. Canonical `ThreadUserContent` is
Input Preview renders each ordered part as an independent block. Text parts use
plain preformatted text and do not run Markdown or reference-marker rendering;
image and unknown parts keep their own blocks at their captured positions. Each
matched image part reads its own retained artifact, so multiple images remain
visually distinct without changing their captured order or treating thumbnail
bytes as model-input evidence.
Canonical `ThreadUserContent` is
the Raw accepted-input evidence and never substitutes for missing prepared
provider evidence in either the ledger or inspector Preview. Context Preview uses
captured model-visible context text from the prepared canonical provider context
whenever diagnostics retained it. That text
is the `<system-reminder>` / `<context-evidence ...>` projection supplied at the
provider-context boundary after projection, budgeting, compaction, and
diagnostic credential redaction. Non-stable CONTEXT rows are keyed by
prepared-context-part diagnostics evidence, not by retained `contextEvidence`
Items. A prepared provider content part is the ledger unit: if one
`<system-reminder>` part contains multiple `<context-evidence>` blocks, it
appears as one CONTEXT row and the inspector shows the whole part text. If a
retained `contextEvidence` Item emitted no model-visible text, it is
not a Trajectory message row. Provider-visible tool catalogs are CONTEXT rows
grounded on a provider call's prepared `toolNames` plus retained canonical
schemas; they are not message text. The first non-empty catalog appears once,
and later provider calls add another row only when the prepared schemas change.
Tool catalog rows are system-like request-header rows: they sit with stable
prompt changes before the Turn's ordinary USER / CONTEXT / ASSISTANT body rows,
and Turn folding never hides them. Frozen tool-output projection Items are storage
evidence for replaying tool results and do not appear as CONTEXT rows unless
their text is explicitly emitted inside prepared provider context. The retained
context payload remains Raw storage evidence when selected through another
authority: it is not the Preview and not the exact post-adapter provider
request.

The ledger record taxonomy is fixed: `input`, `context`, `assistant`, `tool`,
`retry`, `compaction`, and `delegation`. Assistant records are grounded on the
provider-call evidence `(threadId, turnId, providerCall.index)`, not on a
transcript Item. Prepared context rows are grounded on
`(threadId, turnId, providerCall.index, messageIndex, partIndex)`. Tool catalog
rows are grounded on `(threadId, turnId, providerCall.index)`.
Tool, retry, compaction, and delegation records use retained
diagnostic activities when available and degrade to canonical Item evidence when
diagnostics are unavailable. Delegation records link to the child Thread's own
Trajectory; descendants are not flattened into the parent ledger. Every
diagnostic-backed tool or delegation row has its own `toolExecution` primary
evidence `(threadId, turnId, activityIndex, callId)`. A shared tool-batch activity
is not unique evidence for each child call, and record IDs are never parsed to
recover call identity.

Input records are grounded on one canonical `userMessage` Item. The related
accepted-input activity records the admission envelope, and the related provider
call records the first request that consumed it. The Item remains the stable
identity and accepted-input authority; provider-call diagnostics are the
model-visible Preview authority. Context Items admitted alongside the user
message become Context rows only when retained prepared-context provenance proves
their model-visible text was emitted. Referenced Node snapshots therefore remain
CONTEXT while the corresponding Node marker remains USER.

The renderer first performs `thread/trajectory/read`. Main returns `threadId`,
Thread-level summary facts, an ordered record window, `olderCursor` /
`newerCursor`, `hasOlder` / `hasNewer`, an authoritative `replacementRange`, and
the selected record. Summary facts are whole-Thread facts derived from canonical
Turn/timing/usage metadata; they do not force diagnostics payload reads outside
the requested window and deliberately omit record-kind totals that require
diagnostics. Records describe the loaded window rather than a whole-Thread
count. The response
deliberately does not return a full `Thread` because that object contains host
details such as `cwd` that are not part of the Trajectory UI contract. A read
without `recordId` or `turnId` focus returns no selection; focus is a deep link,
not an implicit tail-row choice. Renderer entry consumes `recordId` / `turnId`
focus once when opening the panel; live refreshes preserve the user's current
ledger/inspector state and must not reopen a closed inspector from the original
focus. Search and range filtering are scoped to the loaded window, but the
selected record and its ancestor rows remain visible even when they do not match
the current search, range, or fold state. The user can load older and newer
record windows from stable identity cursors. Every record carries an opaque
`orderKey`, a canonical zero-based `turnIndex`, and a zero-based `stepIndex`
within that Turn. The order key encodes stable Turn/activity/call/item
coordinates and never depends on how many other records currently project, so a
changed tool catalog or another live insertion cannot renumber an existing
record. For a bounded window, main materializes at most one predecessor Turn
solely to restore stable-prompt and tool-catalog fingerprints; that predecessor
contributes no returned records. If its diagnostics are unavailable, the
boundary state is unknown and the first visible structural snapshot is not
mislabeled as initial. A missing diagnostics payload anywhere in a materialized
window also resets both structural fingerprints to unknown before the next Turn,
so full, focus-by-Turn, focus-by-record, and detail reads cannot disagree about a
stable-prompt or tool-catalog record. Structural page expansion walks only from
covered records to their required ancestors; it never adds a parent's other
children, and `replacementRange` continues to describe covered records before
ancestor expansion. Older/newer cursors use those same covered-record boundaries;
an inserted ancestor never consumes pagination coverage or makes a sibling
unreachable. A live refresh without a cursor uses the inclusive
`startOrderKey` / `endOrderKey` in `replacementRange`. A running fallback outside
that range is removed only when incoming primary or related evidence identifies
the same canonical Thread Item; another record from the same Turn is insufficient.
Each canonical zero-based Turn position has exactly one Turn ID. When Rerun or
rollback replaces the Turn at a position, a live refresh removes every loaded
record from the retired Turn ID, including Rerun activities beyond the incoming
order-key range, so two different Turns can never render with the same Turn label.
The same cursorless refresh treats whole-Thread `summary.turnCount` as the
canonical suffix boundary and removes loaded records whose `turnIndex` is no
longer within that boundary after a multi-Turn rollback.
Record labels are a typed semantic union and are localized only in renderer; main
never emits interface prose.

Record details are lazy. `thread/trajectory/detail/read` returns the selected
record plus sanitized detail evidence only. Main locates the owning Turn first
and reads only that Turn's diagnostics for detail materialization. Returned
evidence is bounded Turn evidence, bounded Item evidence, sanitized runtime
facts, sanitized activity/provider-call request and response values, sanitized
context payloads, and sanitized/truncated tool output. Every variable evidence
field in that typed detail shares one 40,000-byte budget, including JSON keys,
nodes, and string leaves; individual strings retain a 20,000-character ceiling,
collections are capped, and the complete serialized detail has a 64,000-byte
hard ceiling. Typed discriminators and required envelope fields are never
rewritten to satisfy the budget. Truncation adds `partialCoverage` to the detail
response's record; if the hard ceiling is reached, the response keeps the valid
typed envelope and omits its variable evidence. A typed diagnostics activity is
either retained with its original `type` discriminator or omitted as a whole;
budget exhaustion never produces a partial activity that the response codec
rejects. The complete detail-read response is checked against the hard ceiling
after fallback construction. It never returns raw
`Thread`, raw `Turn`, raw `ThreadItem`, a diagnostics payload path, digest-only
payload authority, raw secrets, credentials, arbitrary response headers, image
bytes, or unbounded content. Captured filesystem paths remain exact when they are
part of accepted input, prepared context, provider request/response evidence, or
model-issued tool arguments. Missing or corrupt diagnostics, payloads, and
output remain explicit local availability facts rather than killing the whole
workspace. Availability discovered during the lazy read is appended to the
record returned by that detail response, and the inspector uses that returned
record rather than the earlier list summary. Tool Input resolves only the
canonical Item `modelCall` envelope: exact inline arguments, redacted replay
arguments, payload-backed arguments read on demand, or bounded evidence-only
arguments. It never reconstructs model arguments from host execution or display
fields. Assistant Preview uses ordered typed parts extracted from that exact
provider call's retained terminal provider-neutral response. Text, thinking,
tool calls, image metadata, and bounded unknown blocks retain their original
order; a tool call retains its call ID, name, and bounded credential-redacted
model-issued arguments, including exact filesystem paths. Normal provider
tool-call IDs remain exact; an anomalous ID above the renderer identity ceiling
uses one full SHA-256 identity in the Tool record, record ID, Assistant part, and
detail lookup. This keeps the identity stable without allowing one provider
string to bypass response bounds. Compaction Preview reads the retained compaction-summary payload on
demand. A ledger row's bounded preview remains a locating aid and never fills an
empty Inspector Preview, Tool Input, Tool Output, or Context field.
The System Prompt tab and row preview use the captured provider-context prompt
fragment; stable-prompt source blocks remain Raw provenance only. Tool and
Delegation row previews use retained canonical model-call arguments when those
arguments are inline, and remain empty when their payload-backed arguments are
not part of the lightweight read. Host-only command, path, result, and
presentation fields never substitute for model-input evidence.

The lower-level `thread/trajectory/export` operation remains a main-owned
diagnostic operation, but it is not a Trajectory toolbar surface. If a caller uses
it, the renderer receives only status, file name, and byte length; it never
receives the absolute save path. The saved bundle uses bounded,
credential-redacted Thread metadata and retained diagnostics alongside the same
record projection, including captured filesystem-path evidence, so it is a
portable evidence bundle rather than a renderer-visible host-state dump. If the
write fails, main records the complete error in diagnostics and returns only a
fixed path-free failure message to the renderer.

The lower-level `thread/turn/details/read` audited reader remains available for
internal evidence validation. It still resolves one reachable full Turn and its
Thread-owned diagnostics reference fail-closed, but it is not a product workspace
route and the Trajectory UI must not depend on its raw response shape.

Opening Trajectory pushes the current view onto the pane's Back stack and never
creates a split. Opening another record or Turn while Trajectory is current
replaces only the focus target, without adding history noise; Back or close
returns to the prior view. If layout sanitization leaves no prior view and
another pane remains, Close removes the Trajectory pane instead of invoking an
empty Back stack.

Normal Thread UI may visually group Items by Turn without printing every Turn
ID. Trajectory must show the same Thread, Turn, Item, provider-call, and activity
identities as the transport, while keeping renderer evidence sanitized.

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
Thread. A child Agent Role without its own model or reasoning override continues
to inherit the effective model and effort of its parent root Thread, including a
selection applied from this memory.

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
collapsed, the dock and any expanded Subagent detail unsubscribe from Thread and
document stores and retain a frozen snapshot. Reopening subscribes again and
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

Root user Threads and collaboration Agent children expose the composer. A child
Agent submission uses the persisted Agent identity and resume admission path;
it does not turn the child into a root conversation. Isolated Skills,
Automation, Memory, and other feature Threads remain fully inspectable but are
driven through their own canonical admission paths instead of accepting
renderer-authored Turns. A user can fork terminal root history into a new root
user Thread before continuing it.

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

The message is anchored at the transcript top inset on the layout pass it first
renders, and follow is re-derived from the resulting position. The anchor names
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
short conversations that are still within the bottom threshold continue
following. The anchor identifies and mounts its target before measuring it, and
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

The pill also renders on a Thread that has **no composer** — a watched child or
automation Thread — because `update_plan` is `anyThread`-scoped and such a
Thread has a Plan to show. It is equally interactive there; only the focus
destination differs, since there is no composer to return to.

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
a delta delivery runs, so concurrent parent and expanded-child streams do not force a
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
Item, Goal, Role, and Subagent.
