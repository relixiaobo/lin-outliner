# Lessons

Engineering mistakes this project has already paid for, distilled into reusable
rules. Each entry is a rule first and a story second; the full retrospective
lives in the source PR and its CHANGELOG entry. The integration gate appends an
entry when a merge surfaces a carry-forward lesson; when a rule becomes
load-bearing enough, promote it into the `AGENTS.md` principles and note the
promotion here instead of duplicating it.

Promoted so far: **A7** (foundation before consumers — the failed first
UI-refactor round), **A11** (batch work resumable by construction), **A12**
(invariants by blast radius — the 2026-07-29 incident), and the gate's
append-into-the-existing-category changelog rule (the 21-duplicate-section
untangle of 2026-08-03).

## Inspection projections need separate structure, coverage, and payload bounds

PR #575 exposed the same category error at several layers of a large inspection
projection. Redacting a complete typed diagnostics object under a text budget
could destroy its discriminator; structural ancestor expansion could move a
pagination cursor; a live page could not prove which older records had retired;
and an unbounded identity could bypass a bounded detail payload. Each local
operation was reasonable, but each was allowed to redefine a different kind of
authority.

**Keep structural validity, canonical coverage, and evidence payloads as
independent contracts.** Preserve typed envelopes and discriminators while
redacting or truncating only evidence leaves. Derive cursors and replacement
ranges from canonical covered records before adding presentation-only ancestors.
Include identity fields in hard response ceilings, and make live refresh state
which window, revision, or canonical suffix it replaces. A bounded projection
is not correct until its smallest degraded response still passes its own codec.

Regression tests should cross the boundaries, not just populate one page: force
oversized evidence through codec round-trip, split one parent across pagination,
replace a live fallback with retained older records loaded, and roll back
multiple Turns before adding one replacement. These cases distinguish content
loss from structural invalidity and stale projection state.

## Composition-bound behavior needs a shared production seam

PR #580 found that individually green import API, CLI, shell-parser, capability,
and causation tests still did not prove the host had composed them into the root
Agent's real Bash path. A wiring omission at that layer could leave every lower
test green while preview or commit failed in the application.

**When behavior exists only because a host composes several subsystems, extract
the smallest production composition mechanism and drive it through the real
entry point.** Inject its external authorities, but share the mechanism itself
between production and the integration test. The judge should cross the actual
tool and wrapper boundaries and assert both negative and positive authority:
preview receives no mutation credential; commit receives the exact capability
and Item-bound causation it needs; the final durable effect occurs once.

## One authority decision needs one parser

PR #578 granted import commit causation tokens from one shell parser while
capability policy used another. The mismatch let `tenon-import commit ... npm
install` receive the write token but classify only as `shell.dependency_install`,
so worktree and `Action(outline.edit)` blocks never saw the live-outline write.
Any command-shaped security boundary needs a single parsed result consumed by
every authority decision, or a shared lower-level helper that returns every
decision fact at once. Duplicating "recognition" and "classification" almost
guarantees the first future wrapper, separator, or extra argument will split the
boundary.

## When an upgrade removes an input, ask what it was discriminating

`pi-ai 0.80.6 → 0.83.0` (#487) traded per-request inputs for registration-time
closures and collection-wide calls, and **every place that lost a discriminator
became a bug** — four of the ten gate findings shared this one shape. A closure
that no longer receives `model` keyed the `local-endpoint` sentinel off whatever
base URL last registered the id; a collection-wide `refresh({force:true})`
reached for one provider force-fetched them all and swallowed their errors. A
closure or whole-collection call that "reads the same" as the old per-request
code is where a discriminator silently goes missing.

## The general rule almost always belongs one layer up

A special case in a shared handler is the smell. `/new` (#486) special-cased one
command id inside the shared composer keydown handler and generated three
separate defects (ignored menu selection, case mismatch, billed literal `/New`
Turns); raising the rule into the trigger layer — close the menu for any
command whose `label === insertText` — dissolved all three at once and covered
`/clear` for free.

## Electron drag regions: carve-outs need DOM descent, and gaps count

`-webkit-app-region: no-drag` only reliably carves a control out of a drag
region when the control is a DOM **descendant** of that region — a sibling
subtree whose box overlaps eats the click as title-bar drag before React sees
it (#481). And it is not enough for the buttons to opt out: the **gaps between
them** stay live drag strips unless the group's own container opts out too
(#484).

## Fix the thing under test, not the assertion's reference frame

The CI-red macOS pass (#479) found one mistake made three times: each "fix"
moved the assertion's reference frame or media state instead of the defect —
re-measuring in a frame where the offset disappears, leaving emulated
`prefers-reduced-transparency` on so the opaque branch was measured while the
translucent one was asserted, and probing a fallback that inherits the same
value the defect produces. This is the B11 trade in test form. Fix at the
source, then **mutation-verify the guard**: break the token/rule on purpose and
confirm the test goes red.

## One run cannot tell a red baseline from a flake

A test that failed four consecutive times was called deterministic — then
passed twice in a row. The e2e signal on `main` therefore runs **five
independent whole-suite samples in parallel** (not `--shard`, not
`--repeat-each`, which suppress order- and cross-test-dependent failures), and
a verdict is pooled across samples. Any future "is this red real?" question
gets answered with samples, not a single rerun.

## Label, clamp, and validate against the resolved target

The model-picker's un-pin row (#478) clamped reasoning effort and drew its
label from the model being **un-pinned**, not the model `inherit` **resolves
to** — making un-pin itself unreachable for real catalog pairs. When an action
transfers state to a computed target, every derived property (label, clamp,
availability) must read the resolved target. Corollary for tests: pick fixture
names that are not substrings of each other (`'GPT-5.4'` matched
`'GPT-5.4 Mini'` and hid the bug).

## A guard that greenlights what it never checked is worse than no guard

`docs:check`'s orphan-plan rule matched plan slugs as raw substrings of the
whole board, so `settings-redesign` counted as boarded because
`native-settings-redesign` appeared in a historical entry (#488) — and fixing
the match to real `<slug>.md` references immediately exposed three more plans
that had never actually been boarded. A green guard is a claim; make the claim
match what was actually verified, and mutation-test guards the same way as
product code.

## Two descriptions of one artifact drift; derive the second from the first

Release notes are lifted from `CHANGELOG.md` at publish time rather than
written into the release (#480) — the copy nobody edits is the one users read.
The same rule produced the What's New pane parsing the changelog (#488) and the
board's one-line completion records pointing at CHANGELOG entries instead of
restating them. When two documents must describe the same thing, make one of
them generated or make one of them a pointer.

## Hiding a node at the leaf is not removing it from the projection

Empty provider commentary Items were hidden by returning `null` from the leaf
renderer (#493). The Items stayed in the canonical list, so everything that
reasons over the list instead of the DOM kept counting them: `items.length > 0`
opened a process disclosure whose timeline rendered nothing, a non-tool Item
between two tool runs split one aggregated activity row into two the reader
could not explain, and the lone-resultless-reasoning default stopped firing.
Three unrelated-looking symptoms, one root cause, all invisible on screen. When
something must not exist for the user, remove it where the shape is decided —
the projection — not where it is painted. The symptom to watch for: a `return
null` whose siblings are `.filter()`, `.length`, or adjacency checks upstream.

## A blanket `git add` ships whatever is lying in the clone

A 26KB agent-generated test deck sat in the main clone's root on 2026-06-15;
a same-day bookkeeping commit used a blanket add and published it to the
public repo, where it survived seven weeks and entered the `v0.1.0` tag tree
(caught by the PM, removed from HEAD in `[Unreleased]`). Two rules fall out:
main's record commits **add named files only** — board, changelog, the files
the record is about — never the whole tree; and anything an agent produces
belongs under the contained scratch root, never the clone root (the
containment shipped later as `agent-local-root-boundary`; this file predates
it). History rewrite was judged not worth the eight-clone coordination cost —
removal from HEAD is the fix, the lesson is the guard.

## An optional integration contributes to a universal path; it never gates one

Six of the ten gate findings on #492 were one shape: a product-specific host
provider was placed **on** the env-build path of every agent shell command
instead of **alongside** it. Because it was awaited unconditionally, any of its
setup failures — a scratch path that is a symlink, an EACCES on `mkdir`, an
unsafe turn id — returned a Browser Pilot error for `ls`, and the agent had no
shell at all; because it was attached whether or not the Skill was installed, it
ran for users who had opted out; because its `$PATH` segment led the list, it
outranked the user's own `LIN_AGENT_EXTRA_TOOL_PATH`; and because nothing cached
per Turn, every spawn redid ~14 syscalls. A memoized `this.x ??= load()` then
made one transient read failure permanent, since `??=` caches a *rejected*
promise as happily as a resolved one — cache the resolved value, not the promise.
The shape to reach for is a registry keyed by what is actually active, where each
contributor is additive, failure-isolated, and ordered behind the user's own
overrides. A12 says invariants on the user path must degrade rather than throw;
this is its constructive half — the arrangement that makes degrading possible.

## An e2e failure is not evidence until the harness is isolated per clone

Chasing three "regressions" on #497 cost an hour and none of them existed.
`playwright.config.ts` serves the renderer on a fixed port (5174) with
`reuseExistingServer: !CI`, and eight clones share that port — so the run
attached to a dev server already listening from **another clone**, and every
comparison was measuring that clone's renderer, which its own agent was
editing and hot-reloading underneath. A second false failure came from a
`git worktree add` whose `node_modules` was stale: same source as `main`, and
a PDF-preview assertion failed reproducibly until `bun install` ran in the
worktree. Both produced *reproducible* failures, which is what made them
convincing — flakiness is not the only thing that survives a re-run.

So before attributing any e2e failure to a diff: run with a per-clone
`PLAYWRIGHT_PORT`, `bun install` in the worktree, and reproduce the failure on
the base commit **under identical batch composition** — the same specs, the
same parallelism. A test that fails in a 570-test run and passes alone has told
you about load, not about the change. The suite is deliberately `retries: 0` so
instability stays visible; that visibility is only worth something if the
harness underneath it is not shared.

## An invariant enforced by placement moves with the content, or it vanishes

The delegation card guaranteed that a live subagent child was always visible —
not through any condition, but by *where it rendered*: outside the process
timeline's fold gate. When #500 moved the card's content into the timeline,
the guarantee silently moved out of existence: a settled Turn's fold defaults
closed, and it closed over a running child's status and the only Stop that
reached it. Nothing in the diff deleted a check, because there was no check —
the position was the check. The gate caught it; the fix restated the invariant
as an explicit condition (`a Turn with a live child is not collapsible`) plus
an e2e that drives the exact fire-and-forget shape.

So when moving content across a structural boundary — a fold, a portal, a
list virtualization window, an early return — enumerate what the old position
enforced implicitly (visibility, ordering, lifetime, reachability) and restate
each as an explicit condition or test at the new location. A relocation diff
that only moves markup is the suspicious kind: the code it deletes includes
every guarantee the old coordinates were carrying.

## Brevity is a guard; lengthening a lifetime disarms it

The Thread scroll restore ran exactly once, at mount, and cleared itself before
writing. That one fact was load-bearing for code that never mentioned it: the
restore needed no `hasPendingAnchor()` check because no disclosure could be open
that early; the send path could clear four other pieces of scroll state and skip
the restore because it was already dead; routing the write through the shared
`synchronizeScrollPosition` was safe because there was no *later* position for an
intermediate write to overwrite. #499 made the restore converge across layout
passes instead — a strictly better behaviour — and all three assumptions became
defects at once, in code the diff never touched. Half the findings at the gate
were that one change wearing different clothes.

So when you extend how long something lives — a one-shot into a retry loop, a
mount-time effect into a recurring one, a request into a subscription — enumerate
what its brevity was standing in for. Every sibling that skipped a guard, relied
on an ordering, or shared a write path chose that against the old lifetime, and
none of them appear in the diff that changed it.

## "The hypothesis is disproved" requires proving the change was live

Diagnosing the launcher's missing IME candidate window cost three wrong
conclusions in a row, and the same flaw produced all three. Lowering the window
level was the first fix tried; the app was hot-reloaded rather than restarted,
the main-process change never took effect, the test came back negative, and the
hypothesis was recorded as **disproved**. Reasoning then moved on to an
architectural story — Electron's `nonactivatingPanel` on a plain `NSWindow`, a
trade-off against the launcher's whole reason for being — and that story was
written onto the board as work needing a PM decision. It was fiction. The
original hypothesis had been right, and a clean restart plus one line closed it.

Two rules. **Before treating a negative result as evidence, prove the change was
running** — a fresh process, a version marker, something observable; a
hot-reloaded main process is not a restarted one. And **when a diagnosis starts
requiring architecture to explain a symptom, suspect the diagnosis**: the tell
here was a sliver of the highlighted first candidate escaping past the panel's
left edge, which said "drawn, positioned correctly, behind" and ruled out every
input-context theory at a glance. Cheap observation beats expensive theory.

## A derived list must carry its query, and the query's scope is part of the claim

A plan step said "delete the in-app command palette". Re-anchoring it turned that
sentence into a table of consumers, on the correct reasoning that deleting the
component alone would not compile — and the table was introduced as derived from
`rg 'command_palette|CommandPalette'`, citing A11. It was still missing the
handler that actually opens the palette, the two renderer tests guarding the
behaviour, the shortcut union member that makes every stale caller fail to
typecheck, and both locale entries. The query had been run over one directory,
`src/renderer/ui/`; the misses lived in `useWorkspaceKeyboard.ts`, `tests/`, and
`src/core/i18n/`. A second pass, after those were added, still carried "the three
`enabledSlashCommandIds` lists" — a remembered count, where the tree has two.

The failure is not sloppiness, and re-deriving "at implementation start" does not
cover it: by then the list has been read as authoritative for weeks, and the
reader has no way to tell a transcription from a recollection. What separates the
two is recoverable only if the artifact says which command produced it, at what
scope. A9 asks for measurement before a trade; this is the same discipline for
enumeration.

So when a document claims a list is derived: **write the command into the
document, scope it to the whole tree rather than the directory you happened to be
reading, and transcribe all of its output — including the hits that need no
action.** A hit deliberately marked "no change" is evidence the query was read; a
hit that is simply absent is indistinguishable from one that was never seen. And
never carry a bare count in prose — name the sites, so the number cannot drift
away from them.

## A second caller inherits the function, not the call site's guards

A failed Turn got a Retry button, implemented — correctly, and deliberately —
through `rollbackAndSend`, the same path the existing Edit affordance uses. The
call was right. Everything around the call was missing. Edit latches itself while
the round trip is in flight; Retry did not, and because `rollbackAndSend` awaits
an IPC before it touches any state, the failed Turn and its button stayed mounted
for the whole window — so a second click rolled back the *preceding, successful*
Turn, permanently, and then sent the same request twice. Edit is offered only
where the composer is enabled, which is the condition `rollbackThread` actually
enforces; Retry was gated on the Turn alone, so it rendered on Subagent Threads
and did nothing at all when clicked. Edit surfaces a rejection; Retry passed the
promise to a bare `void`, which turned two separate refusals into a dead button.

Three defects, one shape: the reasoning stopped at "this is the right function to
call". But the safety of an action is almost never in the function — it is in the
enablement condition, the in-flight latch, and the error path, and none of those
travel with an import. The existing call site is the specification for all three,
and it is sitting right there, already reviewed.

So when you add a second caller to an existing mutation path: **diff your call
site against the existing one — enablement condition, in-flight guard, error
handling — and justify each difference explicitly.** "I reused the same path" is
a statement about one line. Reuse the guards or say why they do not apply.

## A parity oracle proves parity only over the states it enters

Moving the node context menu onto a core action registry (#504) was done about as
carefully as a reimplementation can be: the shipped menu stayed in the tree as a
live oracle, and a differential test rendered both paths over six real document
states and demanded equality outside an explicitly approved delta list. The
oracle was real, it ran, and it was deleted only after its verdict had been
frozen into goldens. The review gate then found ten defects under it — including
one that could offer, and on confirmation execute, *permanent deletion* on a node
the user had not right-clicked.

Not one of them was a case the oracle got wrong. Every one lived in a state the
oracle never entered. It compared two menus that opened successfully, so a
refused opening — which rendered nothing and never called `onClose`, leaving the
surface dead — was outside it. It compared *presentations*, so a plan that came
back `failed` or `stale` and closed the menu with no banner was outside it. It
rendered a selection, but never one whose first member was not the anchored row,
so reading "the anchor" off `rowIds[0]` looked identical. It never typed into an
async picker fast enough for a debounced list to lag the query. The old code
reached these states through machinery — a `catch` in the shared command runner,
a synchronous `useMemo`, an unconditional render — that the new code was not
obliged to reproduce, because nothing in the ordinary states depended on it.

The seductive part is that a differential oracle *feels* exhaustive in a way a
hand-written assertion does not: it compares everything, so surely it compares
enough. It does not. It compares everything about the inputs you hand it, and the
inputs you naturally hand it are the ones where both implementations work.

So when you replace an implementation behind an oracle: **enumerate the states
the OLD code only reached on failure — rejection, staleness, a vanished subject,
an in-flight async answer, a collection whose order is incidental — and write a
case for each before deleting the oracle.** The parity you can demonstrate is the
easy half; the half that bites is the guarantees the old code made without ever
being asked to demonstrate them.

## Raising a bound you cannot honour is not a floor — drop it instead

`max_total_tokens` is a per-child token cap the model may name, and models guess
low: a cap of 2,500 starved children mid-answer and handed the parent a refusal
instead of the delegated work. The fix looked obvious — clamp the model's number
UP to a floor it can actually survive — and it was strictly worse than doing
nothing. A cap is not just a number here; **naming one changes where the child is
accounted**. Any honoured cap detaches the child from the turn's shared request
pool into a private pool of its own, sized at the cap. So raising 5,000 to
1,000,000 did not make one child safer; it handed each of up to sixteen children
a private million, outside the `subagentTokenBudget` the user may have set to
100,000. The setting that existed to bound spend was silently bypassed by the
change meant to make bounding safer, and the clamp also ran *before* validation,
so `0`, `1.5` and `"5000"` all became a legal million instead of teaching the
model what it had sent.

The general shape: when a caller's constraint arrives too small to honour, you
can refuse it, or you can ignore it — but **do not silently widen it, because a
constraint's value and its enforcement scope are often the same decision**. Widen
the number and you may have quietly changed which ceiling applies. Dropping the
cap returns the child to the pool the user configured, which is both the safer
default and the honest one: the system enforces the bound the user set, not one
the model guessed at and we then overruled.

## Do not record a per-attempt failure in the field that gates the next attempt

`failActiveTurn` wrote `systemError` on the THREAD when a TURN died. It reads as
diligence — the failure is real, so say so at both levels — and it was a
permanent lockout, because Thread status is not a label there, it is the gate:
rollback and Turn admission both accept only `idle`. Nothing ever cleared the
status, and it persisted, so one crash ended that conversation for good — retry
refused, a new message refused, across restarts, with no way out but abandoning
it. The information was never missing: the Turn was already `failed` and already
carried its `TurnError`.

The tell is not "this status is wrong" — it was accurate. The tell is that **the
field is load-bearing for the next action, and the code that writes the failure
is not the code that would clear it.** A state a failure path can enter and no
success path can leave is a trapdoor. Whoever adds the write owes an answer to
"what clears this, and does that still run after the thing that just failed?" —
and if there is none, record the failure where its lifetime already matches the
failure: on the attempt, not on the container.

The same change carried a second rule worth keeping: **ownership of a shared
field ends before the owner's code does.** Turn completion releases the Thread —
drops the active Turn, sets the status — and *then* runs an awaited tail of
naming, usage accounting and extension hooks. A new Turn can be admitted during
that window, so a throw from the tail was writing status for a Thread it no
longer owned. A component that has handed off a lock must stop naming that
lock's state, even on its own error path: check ownership and return, rather than
"restoring" what someone else now controls.

## Deferring a cleanup is safe only if nothing between here and the restart counts what you left

The rollback in `ThreadCatalogOps` deleted an attachment its own caller was about
to re-send, and the first fix was to stop reclaiming resources there entirely:
startup already sweeps every Thread, so nothing leaks — the bytes just wait. That
reasoning is right about *leaking* and wrong about *cost*, because it checked only
whether the garbage would eventually be freed, not who reads the space in the
meantime. The Thread's resource quota counts every byte on disk, while its reclaim
candidates can only ever come from surviving history — so bytes with no live
reference are simultaneously charged and unreclaimable. Enough of them and the
quota tiers away full-resolution originals of *live* history chasing a target the
garbage made unreachable, or refuses the next attachment outright, until the app
restarts.

The general shape: **"a later sweep will get it" answers the leak question, not
the accounting question.** Before withholding a cleanup, find every consumer of
the resource being left behind and ask what each of them does while it sits there
— a quota, a capacity check, a count, a scan cost. When one of them charges for
garbage it cannot collect, the deferral is not free; it has converted a leak into
pressure on live data.

The fix that survived is also the reusable one: instead of retaining everything
or reclaiming against the survivors, reclaim against **the survivors plus the
thing being removed**. What the removed content referenced is exactly what a
re-send can resurrect; what neither set references is garbage nothing can reach.
When an operation exists to be undone or replayed, its cleanup's reference set is
the union of both sides of the transition, not just the side that remains.

## A stub on a shared global outlives the test that installed it

A new test replaced `window.setTimeout` so it could assert how many timers a
component set and with what delay — a stub, not a fake clock, because the
assertions were about the *calls*, not about advancing time. Run alone, and run
next to a neighbouring file, it passed. Run as part of the suite, 55 tests failed
in files that had nothing to do with the change, and the suite went from 4
seconds to 278.

The renderer suite shares one process, and `globalThis.window` is assigned per
file and simply left there. So the stub did not end with the test: every later
test that waited on a timer waited on a clock that had stopped. The failures
surfaced far from the cause, in unrelated files, which is exactly the shape that
invites blaming flakiness or the neighbouring change.

Two things generalise. **Anything installed onto a shared global needs its undo
wired to the same lifecycle that installed it** — return a restore function from
the installer and run it in cleanup, rather than trusting the next file to
overwrite what you left. And **a suite's wall-clock time is a diagnostic
signal**: a run that grows by two orders of magnitude while failing is not a
suite that got harder, it is something waiting on a thing that will never
happen. Read the duration before reading the failures.

The narrower trap worth naming: passing when run alone and passing beside one
neighbour proves nothing about global hygiene. Cross-file pollution only appears
at suite scale, so a test that touches a global is not verified until the whole
suite has run with it in place.

## Consolidating local channels into one shared slot makes harmless writes destructive

Four surfaces each had their own error string; they were merged into one app-wide
notice. Each old caller opened its action with a pre-emptive clear, and the
command runner cleared on success — both correct while the slot was local,
because the only thing being erased was that surface's own last message. Against
a shared slot the identical lines delete *another* surface's still-unread report:
starting a dock action wiped an outliner failure, and because commands run on
ordinary keystrokes, typing one character erased a message the user was mid-read.
Nothing in the diff looked wrong; the lines had not changed at all.

The same consolidation broke the sequence that restarts the auto-dismiss
countdown, which derived its number from the slot it was about to overwrite. That
is equivalent only if the slot is usually occupied — and a slot that every clear
empties is usually empty, so nearly every notice was numbered 1 and a repeat was
indistinguishable from the notice already on screen, which is the one case the
sequence existed to catch.

Two rules generalise. **When N private channels become one shared channel, every
existing write is a new decision** — audit the writes the merge did not touch, not
just the ones it did, because scope is what changed underneath them. And in a
shared slot **reporting is not clearing, and succeeding is not clearing**: a
caller states what happened to it and never speculatively empties the slot first;
dismissal, expiry, and supersession own the lifecycle. **Derive nothing from the
state you are about to overwrite** — carry the monotonic counter on the caller's
side, where it does not vanish with the value.

The gate's other half: a notice re-anchored over the content it reports about
becomes an obstruction, and the fix that makes it click-through silently costs the
hover affordance that pauses it, since `:hover` requires taking the pointer that
was just given up. Both halves are only reachable together — the card stays
click-through and the hold becomes a rect hit test — and the first shape shipped
would have satisfied "hover holds" while leaving the reader a 22px target to aim
for. When a fix removes an element's ability to receive events, check what else
was riding on it.

## The build is a test surface the unit suites do not cover

`unified-command-surface` PR 2 (#505) shipped two defects that `typecheck`,
`test:core`, `test:renderer` and the **entire** Playwright suite all reported
green on, and that a single `electron-vite build` caught immediately.

The first was the worse one. Splitting the preload into two rollup entries makes
rollup emit a shared chunk that both bundles `require()`, and a sandboxed
preload's `require` is a polyfill limited to electron/events/timers/url. The
result was `window.lin` undefined in **every** window — no document, no IPC, no
agent, a completely dead app in both `dev:*` and the packaged build. Nothing in
the test tree loads an Electron preload: the renderer specs drive the vite dev
server in a browser, so the artifact that was broken is the one artifact no
suite instantiates. The second arrived at rebase time: a textual conflict
resolution spliced a new CSS block into the middle of another rule, leaving an
unclosed block. Valid-looking CSS, green everywhere, and postcss said "Unclosed
block" the first time anything actually compiled it.

Both share a shape. Our fast checks read *source*; some failures only exist in
the *artifact*. Type checking cannot see a bundler's chunking decision, and no
amount of DOM testing compiles a stylesheet. The suites are not weak here — they
are simply pointed at a different object than the one that ships.

So: **when a change touches build configuration or any bundled asset — preload,
CSS, entry points, chunking, packaging — run a real build before calling it
green, and prefer a guard that asserts on the emitted artifact rather than on
the source that produced it.** `tests/core/preloadBundle.test.ts` is the shape to
copy: it pins the config *and*, when a build is present, reads the built bundle
and fails on any `require()` a sandboxed preload could not resolve.

## A probe that cannot fail is not evidence

`agent-tool-reliability` (#509) shipped a real Electron probe whose stated goal
was to catch `web_fetch` request-construction failures. It reported **7 passed,
0 failed** on a branch where every redirecting URL was broken, because its local
fixture answered 200 to every request and its only public target does not
redirect. The green run was not a weak signal — it was a false one, and it was
attached to precisely the bug it existed to catch.

The same run had two other ways to look like success. Fixture setup and teardown
sat outside the wrapper that converts a throw into a recorded FAIL, so a failed
loopback listen aborted everything with a bare stack trace and no verdicts. And
the script inherited Electron's default `window-all-closed`, so a tool-owned
BrowserWindow closing mid-run quit the process with **exit code 0** before the
summary printed — masked only by the one window-using probe happening to be
last. Three independent paths, one shape: the harness ending in a state a reader
scores as pass.

So: **build the failure first.** A fixture must serve the failure the probe
exists to catch (here: one 302 route, and a 409 on a contradictory Fetch
Metadata triple) and you must watch the probe go red on it before trusting it
green. Every step belongs inside the failure-recording wrapper, including setup
and teardown. And a run must not be able to end in a way that resembles success:
own the process lifetime, flush before exiting, and close with a completeness
check — an expected-name list that turns a missing, duplicated or unplanned
probe into an explicit FAIL — so "it printed passes" can never be confused with
"it ran".

## Own a protocol-defined header set entirely, or not at all

The same PR's first repair removed exactly the field the platform rejected —
`Sec-Fetch-Mode: navigate`, which Chromium 148 refuses on the `Session.fetch`
path — and kept the rest of the hand-built navigation set. Chromium then filled
the gap it had just been handed with its own `sec-fetch-mode: no-cors`, leaving
`dest=document` + `mode=no-cors` + `user=?1` on the wire: a triple no real
browser emits, and one bot-protection layers read as automation. The request now
failed *more* legibly than before.

`Sec-Fetch-*` is a coherent set whose values constrain each other, and the
platform is a co-author of it. Removing one member does not shrink the set; it
hands that member to Chromium and creates a contradiction with the members you
kept. So: **when a set of headers is defined jointly and the platform generates
some of them, take all of it or none of it.** Deleting the one field that
errored is a fix shaped by the error message, not by the contract.

## Plans reference code by symbol, and big rewrites sweep the active plans

The 2026-08-09 staleness audit of all 25 active items found one failure pattern
everywhere: plan files and board entries do not evolve with the code, and the
board records "shipped" while the plan file does not. Two whole items described
subjects that no longer existed (`past-chats-output-polish`,
`agent-dream-secret-redaction`), one P1 plan was superseded by a channel that
now ships in spec (`agent-computer-control`), one "deferred tail" had in fact
been built (`needs-input`, `TurnLifecycle.ts:465`), and in the flaky-test
entries every line-number reference had drifted while every title/symbol
reference survived. Two rules follow. **Reference code by symbol and test
title, never by line number** — lines rot in weeks, names rot in quarters.
**A large rewrite's gate checklist includes sweeping the active plans' reference
surface** — the retirement PR is the only moment someone provably knows which
premises just died; nothing else links a backlog item to the code it describes.

## Moving a call to a new site moves it onto a new path — take its guard with it

#511's transcript writer moved subject resolution out of the guarded append and
up to the `enqueueTurn` call site. The lookup itself was untouched and read
exactly the same, but it now ran synchronously on the turn-completion tail with
its `try`/`catch` left behind, so a spawn-edge store read that threw would
abandon the rest of the tail — the parent-visible activity row and the idle
notification — and park a parent waiting on `wait_agent` until its own deadline.
Nobody edited a guard; the code simply moved out from under one. A12 names the
boundary, and this is how a change crosses it invisibly: the diff shows a
relocation, not a removed guard. So: **when a refactor relocates a call, re-ask
which path it now runs on and whether the guard that covered it came along.** A
moved read is a fresh invariant question even when its body is identical.

## "No migration" licenses wiping dev userData, not deleting what a released build wrote

The same PR renamed the transcript directory and reclaimed the old one with a
recursive delete, citing the pre-release no-migration rule. The rule does say
that — but what sat inside was real conversation content a *released* build had
written, and a completed Thread never appends again, so nothing would ever
rebuild it, while parents' already-persisted `transcriptPath` strings pointed
into it. The reclamation was still necessary (after the rename nothing computes
the old path, so neither the deletion cascade nor the orphan sweep can reach
inside it), but relocating — `rename` each artifact under the current root, then
`rmdir` only once the directory is empty — satisfies that requirement without
spending the user's data, and the sweep that runs next reclaims exactly the ones
whose Thread is gone: the outcome deleting only appeared to produce. So: **the
no-migration rule licenses wiping `~/.lin-outliner-*` dev userData; it does not
license deleting a subset of prod userData a shipped build wrote.** Once a build
has been released, a rename relocates.

## Verify a regression test by reverting each guard the fix added, separately

The #511 gate confirmed every correctness fix the same way: revert it, watch the
new test fail. Three did. The fourth — a deleted Thread's transcript recreated
by a merely-slow append — still **passed** after the append-path `discarded`
re-check was reverted, which reads as "that half is redundant, drop it". It was
not: `delete()` clears the cursor, so the parked append resumes down the
*rebuild* branch, and it was the second re-check catching it. Reverting both
made the test fail with three resurrected files. So: **a test that still passes
after you revert half a fix means your model of which path it takes is wrong,
not that the half is dead** — revert each guard a fix adds on its own, or the
"verified" claim is about a path the test never took.

## A once-only guarantee needs a durable record, not a scan of history

The #512 gate found ten defects, and five were the same decision: "this Goal has
already had its one budget-limited wrap-up" was answered by scanning persisted
Turn provenance for a matching `ref`. Derived state looks free — no new table, no
write path, nothing to keep in sync — but it inherits every property of the log
it reads. History that predates the feature has no marker, so *every* pre-existing
budget-limited Goal read as "not yet wrapped up" and would have fired a paid Turn
at the first launch after upgrade. A fork copies Turns verbatim while its new Goal
restarts at generation 1, so inherited refs read as this Goal's own. A history
rollback deletes the very row that was the evidence, so the guarantee silently
re-armed. And answering the question at all cost a full paged decode of the Thread's
Turn history on every idle boundary — O(n²) across a long autonomous run. The fix
was one table with a reserve → commit/release protocol, and it closed all five at
once. So: **when a fact must hold exactly once, own it — a row you write, keyed to
the thing it constrains.** Provenance is a log of what happened, not a ledger of
what may still happen; the moment you ask a log a question about the future, you
have coupled your invariant to every edit, copy, and truncation the log allows.

## A guard written from the fixed code inherits the bug's blind spots

The #515 gate found three defects, all in the runtime guard the PR added to keep
the popover row contract from being deleted again — and two of them made the
guard unable to catch the very regression it existed for. It skipped any bullet
that was not visible, but a bullet that loses its sizing class renders as an
empty `display: inline` span with a 0×0 rect, so the failure mode *was* the skip
condition. It compared `Number.parseFloat(getComputedStyle(el, '::before').width)`
against a threshold, but deleting the `::before` rule — precisely what had
happened — resolves that width to `"auto"`, and `NaN < 5` is `false`, so the
check passed on the broken build. Both were written by reading the repaired code
and asserting what it produces; against the repaired code they were green and
looked complete. The third had the same root: the check grouped rows by
`[role="listbox"]`, silently dropping every `role="menu"` popover, because the
surfaces the author had open all happened to be listboxes. So: **a guard is not
verified by passing on the fixed code — re-inject the original breakage and watch
it fail.** Anything that reaches the guard through a skip, a `continue`, or a
`NaN` comparison is indistinguishable from health, and a regression test that has
never once been red is a claim, not evidence.

## Admitting a unit means validating the unit, not the file in your hand

The #513 gate found that a governance check keyed to the file being written let
an agent author a Skill's support files *first* and its `SKILL.md` second. Each
write was judged alone and each judgement was locally right: `run.sh` under a
directory no Skill had loaded from was ordinary user content, and the `SKILL.md`
that arrived next was a valid definition. Only the pair was the attack —
admission turned the already-written executable into part of an invocable Skill,
and the branch's own guards (`executable_skill_support_file`,
`rejectSecretLookingContent`) never ran on it, because they had run on the wrong
question. The fix moved the gate to the moment of admission and walked the whole
prospective bundle. So: **when a write admits something into a trusted set,
validate everything the admission pulls in, not the bytes the caller passed you.**
Order-of-writes is attacker-chosen; the admission boundary is the only point that
sees the finished unit.

## A snapshot published asynchronously and read synchronously is a stale read

The same PR resolved Skill path ownership through a synchronous resolver reading
a `loadedBoundSkillRoots` snapshot that only an async registry load ever
republished. Every window between "the world changed" and "the load finished" —
a settings change mid-turn, a definition write, a reload that threw and was
caught — resolved against the old world and silently *downgraded* to ungoverned,
because "no owner found" and "owner not published yet" are the same `null`. Three
separate confirmed defects were that one shape. The fix was not to plug each
window: invalidation became synchronous, the read became `async` and awaits the
reload, and a load that fails now propagates. So: **if a cache must be fresh to
be correct, make the reader await the refresh and fail closed — never let a
not-yet-loaded answer be spelled the same as a negative one.**

## A fallback that reads what an earlier boundary never writes is dead code

The #516 gate found a media classifier whose two most interesting branches could
not run. One rescued attachments with a generic MIME by consulting their stored
duration — but ingest records a duration *only after* deciding the MIME is
`audio/*` or `video/*`, so a generic-MIME attachment provably has none. The other
classified `image/*` attachments, which the write boundary rejects outright. Both
read plausible-looking fields that a boundary upstream guarantees are absent, and
both had passing tests: the tests forged the states by writing into `state.nodes`
directly, so the suite reported coverage for behavior no user action could reach,
and the spec documented it as shipped. The fix was not to keep the branches
honest but to move the work to where the gap actually was — teaching ingest more
media signatures and extensions, so the files carry a real family before search
ever sees them. So: **before writing a fallback, name the producer of the data it
reads; if no shipped path writes that field in that state, you are not adding
resilience, you are adding a branch that will never run.** And a test that has to
bypass the command surface to reach a branch is telling you the branch is
unreachable, not that it needs a fixture.

## A privacy switch's unit is the conversation the user sees, not the record it names

The #519 gate found "exclude this Thread from the records" doing exactly what it
said: it deleted that Thread's artifact. But a root's Subagents write their own
artifacts, so the delegated half of the excluded conversation stayed on disk —
and, worse, kept its rows in the index the same PR had just taught every later
Thread to grep. The user asked for one thing and got a strictly weaker one, with
the UI reporting success. The deletion path next door already knew better: it
cascades over the subtree. Two more findings in the same PR were the same
mismatch in miniature — re-inclusion cleared a writer's flag and waited for a
next Turn that a finished conversation never has, so the undo restored nothing
while the menu claimed the record was back; and a removal that failed left the
artifact listed forever, because nothing ever came back for it. So: **for any
switch that removes or hides user content, write down the unit the user believes
they are acting on, then check that every artifact in that unit is covered, that
the inverse operation actually restores, and that a failed step is reconciled
rather than assumed.** A privacy control that is merely mostly effective is a
correctness bug with a confident label on it.

## A byte ceiling is chosen against the thing it bounds, not against a round number

The #514 gate found `MAX_CHANGELOG_BYTES = 750_000` guarding a fetch of this
repo's own `CHANGELOG.md` — a file that was 562,626 bytes that day, is
append-only, and grows with every merge. The constant was not wrong yet; it was
75% spent at the moment it was written, with weeks of runway. And the behavior on
the far side of it was the worst possible one: the reader throws, the caller
catches, the check still reports success, and every release note silently becomes
empty forever, with nothing but a `warn` in the log. Nobody would have connected
"About shows no release notes anymore" to a constant chosen months earlier.

The mistake is picking a limit by how large the number feels instead of measuring
what it bounds. So: **when you write a size, count, or time ceiling, state the
current value of the thing it limits and which direction it moves, and pick the
ceiling as a multiple of that** — a bound over a monotonically growing artifact
needs an order of magnitude, not a comfortable margin. Then check what happens
when it is crossed: if the failure is caught by a caller that keeps reporting
success, the ceiling is not a guard, it is a scheduled silent outage. Either make
crossing it visible or make it non-fatal on purpose.

## When a value has more than one producer, the test enumerates the producers

The #522 gate found a drift check whose comparison could never match on any path.
The belief a node tool handed back was `editableOutlineRevision`
(`id:updatedAt:hash`); the check recomputed `revisionOf` (`id:updatedAt`). Every
node the model read was reported as someone else's edit on the very next turn,
complete with an instruction not to revert changes nobody had made. The tests
passed because their fixtures hand-wrote `` `${id}:1` `` — the shape the
implementation assumed. **A fixture written from an assumption can only ever
agree with it.**

The first fix verified the token `node_read` really emits and generalized from
it — and the same defect survived one field over. `node_edit` writes a single
`revisions` map from fifteen code paths in two different shapes: only the outline
path emits the three-part form, the other thirteen emit `revisionOf`. Labelling
the map by its field name reproduced the original bug for the majority of edits,
one commit after fixing it, and the round of new tests written to prevent exactly
this did not touch a `revisions` payload at all.

So, two turns of the same screw. **Build every fixture by calling the function
that really emits the value — never hand-write the shape you believe it has.**
And because one field can be fed by many writers: **when a value can come from
more than one producer, enumerate the producers in the test, not the field.**
Verifying one instance and generalizing to the class is how the second instance
survives — grep the writers and count them before you decide one example is
representative.

## A guard that runs "if the artifact happens to exist" guards nothing

v0.3.0 shipped dead — `window.lin` undefined in every window — because the
update checker's import chain pulled `semver` into the sandboxed preload, whose
`require` polyfill resolves only electron/events/timers/url. The #505 preload
guard existed and encoded exactly this failure, but its artifact half ran only
"when a build is present", no CI test run builds, and the whole Playwright
suite drives Chrome against a vite dev server with `window.lin` mocked — so no
test in this repo ever loads the real preload, and the one context that mattered
was checked by no one. Two rules. **Put the check where the artifact is
produced**: `app:build` now runs `scripts/check-preload-bundle.ts` between
electron-vite build and electron-builder, so an unloadable preload fails the
build, not the first user. **Know which realities your test pyramid never
touches** — packaged Electron is one of them here; that gap is a standing fact
to design guards around, not an oversight to fix once.

## A remembered failure may end one operation; it must never speak for the next

PR #525 optimized streaming by moving delta writes off the caller's await. To
keep a broken Thread from retrying forever it stored the error in a per-Thread
map — and that one map produced the round's two worst defects. Later deltas
checked the map and returned early, so a single transient `EIO` silently
discarded the rest of the response with no log line; then the *next required*
lifecycle write checked the map and threw the stale error **instead of running
its own operation**, so `item/completed` was never appended and the next launch
found an Item that never finished. A remembered failure had been promoted from
"this write failed" to "this Thread is broken", and then spent on operations
that had not been tried. The rule: an error belongs to the operation that
produced it. Report it, and let the next operation attempt its own work and
fail on its own evidence. If you truly need a circuit breaker, it needs an
explicit close condition and must never substitute itself for an action the
caller requires — silently skipping a required write is worse than the failure
it was avoiding. Corollary from the same diff: **maintenance work must not
change its caller's result.** LRU eviction ran in `append`'s `finally` and
could reject an append whose bytes were already durably on disk; cleanup and
bookkeeping around a successful operation get caught and reported, never
propagated.

## Absent evidence is not evidence of disagreement

The same PR's reconciler compared a projection watermark against the rollout's
byte boundary and rebuilt the projection on mismatch. With the rollout file
missing or empty there were no entries at all, so the boundary resolved to
`null`, `null !== watermark.byteOffset` read as a mismatch, and "rebuild" —
`DELETE` every turn, item and marker for that Thread, then replay zero entries
— erased a full conversation the projection still held intact. Nothing was
inconsistent; one side of the comparison simply had nothing to say. Before a
reconciler destroys the side it does not trust, make it distinguish *contradicts*
from *has no data*, and then ask which side actually holds the surviving copy:
the fix rebuilds the missing rollout from the projection, the reverse of the
original direction. Any reconcile whose repair is a delete deserves this check
by construction.

## Degrading instead of throwing must be scoped to the source you distrust

A12 says a bad extension or MCP contribution should be omitted and diagnosed
rather than kill an unrelated user Turn, so #527 replaced a `throw` with a
skip — and recorded each skipped contract in a set keyed by *canonical tool
name*. Two things then leaked past the intended blast radius. The skip applied
to every runtime tool, so a first-party capability schema that failed to compile
also vanished behind one `console.warn`; and because the eviction key was a name
rather than the contribution, an extension declaring `bash` deleted the **real**
`bash` from that thread — the untrusted input had gained the power to disable a
trusted neighbour, which the previous fail-closed version denied it. When you
convert a structural failure into a degradation, scope it twice: to the exact
set of entries whose author you distrust, and to a key space that author cannot
reach into. Everything else stays a structural failure.

## Relocating a drain relocates every decision it feeds

#530 moved Memory work off the typing path and, to keep the incremental index
fed, drained `core.drainTransactionProjectionChanges()` in a `finally` after
every command instead of once per transaction. The drain looks like a read. It
is not: it patches the committed state snapshot each command's changes are
compared against, which is exactly the comparison Core used to decide whether a
transaction changed anything at all. Per-transaction, an agent tool that tagged
and untagged the same Node netted to zero and produced no commit, no revision
bump and no undo entry; per-command, both halves reported "changed", so the
transaction committed and left the user a phantom ⌘Z step that does nothing.
Before you move a call that drains, accumulates, or resets state, enumerate what
reads that state downstream — the fix here was not to special-case the drain but
to give Core its own before/after record so the net-change verdict stopped
depending on drain cadence at all. A decision must not be a side effect of how
often something is polled.

## An observer added to a committed mutation must be non-authoritative

The same PR gave `DocumentService` a mutation observer and wired the Memory
extension into it — reasonably, since the index has to see sparse changes as
they happen. But it was inserted ahead of the renderer's projection listeners
and its commit failure was rethrown *after* the document had committed, saved
and broadcast. Both inversions hand a bookkeeping component a veto over work
that already succeeded: a SQLite error in Memory silently suppressed the
renderer update for an edit that was durably persisted, and a failed
reconciliation reported `error` for Nodes the agent had in fact created, so the
model retried and made duplicates. When you add an observer to a path that has
already committed, it goes last, every phase is contained and reported, and its
failure degrades to the slower correct path — here, emitting `transactionIndexed:
false` so the ordinary projection delivery resyncs the index. Cf. A12: the
observer is not the write boundary, so it never gets to fail the write.

## Whatever still moves after everything else stops has become the claim

`semantic-working-state` PR1 (#531) made a Turn's phrases static in every state
where nothing is advancing: blocked on the user, recovering from a provider
retry. Each surface was suppressed correctly and every assertion passed. But the
response tail's rose generating shape had its own animation, keyed on a flag that
was *false* precisely while blocked — so the glyph sat still while the agent
worked and spun while it waited for a human. Nobody wrote that rule; it fell out
of suppressing four surfaces and not the fifth. The spec even stated the
principle ("motion would claim progress") and still missed it, because the
principle was written about `WorkingText` and the shape was not a `WorkingText`.
When a change makes a signal exclusive — one mover, one sound, one badge —
enumerate every producer of that signal in the *quiet* states, not just the loud
ones. The defect is never the surface you suppressed; it is the one you never
listed. Note also that a screenshot cannot show this: the evidence was reading
`animation-name` off computed style in each state, and a static image of the
correct and the broken build is byte-identical.

## `:has()` cannot express "the nearest one"; self-nesting components need an explicit gate

The same PR arbitrated a Turn's single mover with `.thread-turn:has(.working-text)
.thread-streaming-shape { animation: none }`. `SubagentRunDetail` mounts a whole
nested `ThreadView` — with its own `.thread-turn` sections — inside the parent's,
so a parent phrase froze the *child's* live indicator and a child's retry
flattened the parent's phrases. Descendant selectors reach through every
boundary; CSS has no way to stop at the nearest instance of the same component.
Any component that can contain another copy of itself must pass its arbitration
down as data — a prop or a context whose provider re-establishes at each
boundary — and the guard that keeps it that way is a negative
(`expect(css).not.toContain('.thread-turn:has(')`), because the CSS version reads
as correct forever.

## When you delete a surface, sweep what it was the only reporter of

`table-field-column-semantics` (#534) replaced `SearchQuerySummaryBar` with a
query builder panel. The bar carried one output nothing else did: a
`search.summary.truncated` chip announcing that a query exceeded the editor's
complexity limit. The builder kept computing `truncated` and dropped it on the
floor — so an over-limit query rendered as if complete, and Save wrote the
truncated text back, permanently deleting the omitted rules with no warning. The
replacement had been reviewed against what the *new* surface should show; nobody
asked what the *old* one was the sole reporter of. Two review rounds missed it.
When a surface is deleted, enumerate its outputs and give each one a new home or
an explicit obituary — a deleted warning is indistinguishable from a state that
never occurs, and the code that computes it keeps compiling.

## A fix is new code; re-gate the fix, not just the bug

Across #534's three review rounds the heaviest findings were produced by the
*previous round's fixes*, not by the original feature. Round 1's "materialize the
saved search before switching to Table" fix introduced both a fail-closed `throw`
on the user path (A12 — the Table toggle silently did nothing for an unrunnable
search) and a wrong persisted result set, because that call path was the only one
not threading the `TextSearchIndex`. Round 2's fix for the latter then rebuilt the
whole text index on every `set_view_mode`, including for ordinary non-search
nodes. Each fix was small, targeted, and correct about the bug it named. A fix
ships code written under the narrowest possible framing of the problem and
reviewed by no one — re-review after fixes is not a formality, and "the findings
are addressed" is not the same claim as "the diff is sound".

## A hung test run is invisible in pass/fail counts

Sampling #535's suite for flakiness, the loop sat at "8 runs, 0 failures" for 40
minutes — because run 9 had *wedged*, not passed. Runs 1-8 took 20-30s each; run
9 was alive at 41:42 with no output and had to be killed. Its tail was the whole
diagnosis: a Turn from an already-torn-down fixture still executing and accruing
subagent budget against a database whose file had been unlinked, because
teardown deleted the temp roots without ever closing the `ThreadService` and the
launch chain is detached (`void launchActiveTurn(...)`, reachable only through
`active.completion`). That discovery inverted the verdict — under `retries: 0`
with no per-test timeout, a suite that can hang is a stuck CI job, not a red one,
which blocks where mere flakiness might have been a follow-up. Count-based
stability metrics omit the worst outcome by construction: a hung run emits no
failure line and never reaches a summary, so the batch just looks slow. Compare
per-run wall time and check `ps -Ao pid,etime` while sampling, and capture the
tail of a wedged run before killing it.

## A passing fuzz proves nothing until it has failed on the broken version

#539's incremental Markdown lexer arrived with its own differential fuzz — 250
seeds, 25,000 appends, all green. Both merge blockers were nonetheless real, and
the branch's *other* guard test ("matches a full repaired lex after every
append") passed on the buggy code too, because none of its ten sequences left an
inline marker open across a blank line. A randomized harness only covers what its
alphabet can generate, and the author picks the alphabet after writing the code —
so it inherits the blind spot that produced the bug. At the gate the fix was
verified with a second harness built from a deliberately disjoint alphabet, then
— the step that made the result mean something — replayed against the pre-fix
commit, where it diverged within 932 appends. Only that control turns "240,000
appends, zero divergence" from an absence of evidence into evidence. Whenever a
randomized or differential harness is the argument that a fix works, run it
against the broken code first and record how fast it fails; a harness that has
never been seen to fail is not a test, it is a hope. (Same shape as *a guard
written from the fixed code inherits the bug's blind spots*, one level up: there
the guard, here the generator.)

## When correctness forces work back into a hot path, re-measure before you keep the claim

#539's streaming lexer was fast — 0.06 ms per commit, flat regardless of answer
length — because it repaired only the tail. That was precisely the defect: the
repair has to see the whole text to close markers opened before the frozen
boundary. Fixing it moved `remend` back onto the full text and the flat curve
became superlinear, ~43 ms per commit on a 50 KB answer, a ~700× regression
against the buggy version. The change was still a ~3× win over the baseline it
replaced, so it merged — but the plan had by then recorded "measurement confirms
full lexing is the dominant cost", which was true of the old path and false of
the shipped one, and would have sent the next optimizer after the 5% instead of
the 95%. A correctness fix in a hot path is a performance change: the benchmark
that justified the work has to be re-run afterwards, against the *pre-PR
baseline* rather than against the intermediate version, and any measurement claim
written into a plan or spec re-derived from the new numbers. Otherwise the
optimization's own documentation becomes the reason the remaining cost never gets
found (A9, A8).

## When a user-editable label is the identity key, collision handling compounds

`tag-merge-and-split-fixes` (#540) started as three collision fixes and ended as
an identity change, because the collisions were symptoms. Fields were identified
by their normalized display name, so two tags each defining a `Status` were
mutually exclusive with a crash. The first design patched the symptom: skip
colliding fields at the stamp boundary, and unify same-named definitions when
tags merge. Both patches spawned their own defects — the unify was document-wide,
so merging two tags silently rewrote the schema of a third tag the user never
named, and every "which name wins" question needed a normalization rule that then
had to agree with three other call sites keyed the same way. Switching identity
to the definition id deleted the unify entirely, dissolved the original crash and
the merge-poisoning defect at once, and left exactly one new question — how a
name-based write picks among several candidates — answered once by a precedence
rule rather than N times by collision handlers. When a fix has to answer "which of
these same-named things did the user mean", check whether the name should have
been the key at all; the reference product (Tana here) usually settled it long
ago, and checking took minutes against two review rounds of arguing.

## Deferring a synchronous cost is not removing it, and an idle debounce has no ceiling

`typing-hot-path` PR-C (#541) had to be sent back twice for the same mistake in
two shapes. The first round found an index build that was O(Σ label²) and ran
inside the keystroke commit; the fix moved it behind a 150 ms idle timer, which
made the probe look clean because the probe types continuously. It was still one
synchronous 160–700 ms block — it now landed on the pause instead of the
keystroke, which is where the user is most likely to notice a frozen window. The
same patch also re-armed that timer on every accepted delta, so any event stream
denser than the debounce (an Agent streaming edits is exactly that) deferred the
work forever and silently degraded the index back to the linear scan it replaced.
Both are closed the same way: slice the work cooperatively against a budget so no
single slice exceeds a frame, and pair every idle debounce with a **non-resetting**
maximum age (plus a pressure trigger) so a continuous producer cannot starve it.
The general rule for the gate: when a hot-path fix is "we moved it off the hot
path", ask *where it landed and how long it is there* — measure the longest
uninterrupted slice, not the total, and measure the deferral trigger against a
continuous stream, not a burst that stops (A9).

## A fast path's guard is part of the optimization — measure what it excludes

`streaming-markdown-repair-cost` (#547) made Markdown repair linear and then
guarded the new path with `!text.includes('$') || no emphasis marker → old path`.
The reasoning was local and sounded right: the expensive scan is math-context
lookup, so text without `$` cannot be paying for it. It was wrong about the
library it was replacing, which consults math context *before* it rejects a
literal `_` or `*` — so the guard sent every answer without a dollar sign back
onto the quadratic path, which is the common case for answers about code. The
benchmark on the branch used a fixture containing `$`, so it measured only the
side of the guard that worked, and reported a large speedup for a change that
left `snake_case` prose at 207 ms per 40 KB commit and over a second at 80 KB.
The tell was cheap to produce and unmissable: prepending one `$` to the identical
text made it 12–40× faster. Two rules for the gate. **Benchmark both sides of
every guard** — a fast-path fixture that satisfies the condition proves nothing
about the traffic the condition rejects, and the fixture set must include the
workload the feature actually sees (here: identifiers and arithmetic, not
formulas). **Justify a guard against the code it is bypassing, not against a
model of it** — the premise "no `$` means no math work" was never checked against
the upstream source, where it is false. When the guard turns out to be
unnecessary, deleting it is usually the whole fix, and its removal is verifiable
by the same differential harness that proved the fast path correct.

## A cache key must state its own invalidation condition, not inherit one

`agent-tool-call-path` PR 1 (#546) cached filtered projections per Turn behind
`cached.source === projection && cached.hiddenNodeIds === hiddenNodeIds`. The
first half can never fire: `DocumentReadModel.applyUpdate` splices the
projection's node array and mutates its id map **in place**, so both identities
stay stable for the life of the document. The cache was nevertheless correct —
because the *other* half, an upstream `Set`, happened to be freshly allocated
whenever the Memory revision moved. That is a working cache whose invariant
lives in another file, with no test and no comment naming it: make
`hiddenNodeIds` return a stable set for an unchanged graph — an obvious
optimization someone will eventually make — and stale filtered reads start
leaking silently. The fix keys the cache on the revisions themselves (document,
control-store, explicit-reference) and tests it by mutating the projection in
place. The gate rule: **when a cache key is an object identity, ask what mutates
that object.** If the answer is "it is mutated in place", the identity is
decoration and the real key is whichever counter moves — put that in the key.

## Fixing a leak by deleting a redundant path is a behavior change

Same PR, second round. Unbounded per-Turn filter state was closed by making the
Item-notification handler a pure update: no existing state, no entry. Correct
for the leak — but that handler was also the only path that captured the opening
user message's `@Node` references *without* a Turn read. The two paths were
redundant on the happy path and independent everywhere else, and the fix left
one. Deleting redundancy is how a fallback quietly becomes a single point of
failure. Either bound the state (evict on every terminal status, on thread
deletion, cap the map) or prove the survivor always covers the case — #546 took
the second and asserted the ordering it now rests on: recorded Items are
canonical before observer delivery. Either resolution is fine; assuming it is
not. **A "this path is redundant" fix has to name what it now depends on, and
test that.**

## A memo guard that feeds its own stable props guards nothing

PR #544, second review round. `threadTurnStreamingMemo.test.tsx` existed
precisely to keep streaming deltas from re-rendering settled Turns, and it
passed while the production `ThreadDock` defeated the memo on every frame — the
test mounted `ThreadTurnView` with speaker objects it allocated once, while the
real call site minted a fresh `selfSpeaker={{...}}` literal per render. The
memo, the test, and the regression were each locally correct; the test asserted
the callee's contract while the bug lived in the caller. **A render-identity
guard must exercise the production caller** — render the actual parent and
count child renders — or every new inline literal at the call site silently
un-fixes what the guard claims to protect.

## A virtual id in a NodeId channel silently un-types every consumer

tag-schema-projection PR 1 replaced eagerly-materialized field entries with
virtual `slot:` rows whose ids flow through the same `NodeId`-typed row
channel. Every consumer that assumed "row id names a node" kept typechecking
and silently degraded instead of erroring: `byId.get(row.id)` in
filter/sort/group dumped populated rows into the filtered bucket,
`siblings.indexOf(rowId)` made drop targets permanently inert, the clipboard's
ancestor walk duplicated values, Trash rendering lost field rows. Fifteen
confirmed gate findings, one cause-shape. When a change introduces a virtual
identity into an id-typed channel, the type system flags nothing — sweep every
consumer of that channel (A11-style: from `rg` hits, not memory) and decide
each one deliberately. The fix's `rowNodeForView` shows the durable form:
carry the backing node id (`slot.entryId`) alongside the row id and resolve
through it, rather than teaching each call site to parse virtual ids.

## A test that pins a browser-chosen buffer size asserts the platform, not your contract

PR #551. The pathless-upload e2e spec asserted the exact append sequence
`[1 MiB, 1 MiB, 123]` for a 2 MiB + 123-byte file. But the renderer does not
choose those boundaries — it reads `file.stream()` and only re-splits what
exceeds `ATTACHMENT_UPLOAD_CHUNK_BYTES`, so the sizes are Chromium's buffering
decision, free to change under a browser bump and unrelated to any behavior the
code promises. **Assert the invariant the code enforces, not the shape one
runtime happened to produce**: every append positive and within the limit, and
the appends summing to the source length. That still fails a single oversized
append or a truncated stream — the two regressions the test exists for — while
surviving a Chromium upgrade.

## A guard added to one branch leaves the sibling branch calling the same command

PR #548 stopped `cycle_done_state` from firing against an unmaterialized draft —
but only inside the `emptyDraft` branch it was written for. The `else` branch
reached the identical `cycle_done_state` call through `commitDraft`, which
discards the create's outcome, so a rejected create on a *non-empty* draft
reproduced the exact bug the PR closed, and #550 had to fix it again. The
condition that selects a branch is rarely the condition that makes the guard
necessary. **When a fix guards a call, find every path that reaches that call**
(`rg` the callee, not the branch) and guard at the join — here, by making the
materialization helper return its outcome so one check covers both arms.

## An approved optimization is a hypothesis; the profile decides whether it ships

`agent-tool-call-path` PR-2 (#552) carried two PM-approved items. The first —
memoizing tool-output reads per Turn — measured 9.5× and shipped. The second, a
diagnostics fingerprint/deep-copy cache, profiled at **~1%** of the per-call
cost, while ~73% sat in the bounded Secretlint scan the plan had filed under a
*later* PR. The dev built the first and dropped the second, which is A9 read
correctly: approval says an optimization is *permitted*, never that it is
*worth it*, and the plan's own "measure-first; if the win is marginal, drop it"
clause is the one that binds. Building it anyway would have added a cross-call
redaction cache and new budget accounting to buy 1%. **A dropped optimization
still owes its measurement**: the attribution is the deliverable, because it
re-orders what remains — here it promoted the secret-scan scheduling item from
"small tail" to the real remaining win. Record the profile in the PR and the
board, not just the code you kept.

## "Pre-release needs no migration" is a claim about dev data, not about the app you installed

The tool rename that collapsed `spawn_agent`/`wait_agent` into
`agent`/`agent_message`/`task_stop` (#535) shipped with no migration, which the
pre-release rule allows — its escape hatch is "wipe `~/.lin-outliner-*` dev
userData". But the **daily-use install** at
`~/Library/Application Support/Tenon/` is never wiped, and its history is
append-only, so the retired names sat there permanently. The next build could
not decode 14 rows, and the app **exited at launch, every launch**. Narrowing a
persisted enum is a data change against every store that survives the upgrade;
the dev-wipe hatch only covers the stores we throw away. Before removing a value
from a persisted enum, ask which store keeps it forever, and either migrate it
there or make the reader tolerate it.

The second half of the same incident is about where a degrade is allowed to cut.
The obvious fix — skip the Item that will not decode — was wrong twice over, and
the review caught both: a Turn with one Item skipped no longer matches the
terminal-Turn mutation check, and the projected rollout snapshot is not a read at
all (`restoreMissing` writes it back, then `rebuildThread` cascades the old rows
away), so "skipping" a row there **destroys its last surviving copy** where the
throw had preserved the bytes for a later protocol fix. **A degrade has to cut
along a boundary that is self-consistent.** An Item is not one — it is half of a
Turn's invariants. A Thread is: quarantine it for the session, report it, leave
its bytes alone.

Then check what *reads* the thing you just filtered. Hiding the quarantined Thread
from `persistentRootThreads()` protected the fan-out that was crashing — and
silently armed a different one: the memory orphan-admission sweep deletes every
row whose Turn it cannot enumerate, so the filtered list made that Thread's Turns
look deleted and wiped its extraction state for good. **A filter is invisible to
the consumer that treats absence as deletion**, which turns a session-scoped,
in-memory quarantine into a permanent write. When you narrow an enumeration, grep
its callers for the ones that delete, prune, or reconcile on absence, and give
them the incompleteness explicitly (`hasHiddenRootThreads()` here, which skips the
sweep for the session).

Ordering counts too: the readability probe ran one line *after* the Thread was
pushed onto the reconciled/resumable lists, so the launch still died on a
different unguarded fan-out over exactly those lists. **A guard placed after the
registration it is supposed to prevent is not a guard.**

The fix for the filter problem then grew the same bug a third time, in a new
place: a second quarantine path set only one of the two tracking sets, so the
enumeration was incomplete while the "enumeration is incomplete" flag read false.
**Two sets that must agree will not.** The durable fix was to delete the second
set — the flag now evaluates the very predicate the filter evaluates, so it cannot
disagree with itself — and to funnel every writer through one method. When a
correctness property is "these two things always match", encode it as one thing.

And find the caller before choosing the layer. The fatal path here was not the
one the stack trace showed: Node's default `Error.stackTraceLimit = 10` truncated
it exactly at `listTurns`, which made the projection decode look like the culprit.
Raising the limit to 80 and re-running showed the real shape — startup's
`MemoryExtension.prepareForTurnAdmission` fanning out over every root Thread with
no per-Thread guard. **A stack that ends suspiciously close to where you were
already looking is probably truncated**; check the frame count against the limit
before you conclude anything from where it stops.

## A typecheck that excludes tests will not tell you a test double has gone stale

`tsconfig.json` here is `"include": ["src", …]`, so `bun run typecheck` never
looks at `tests/`. During #555 an interface gained a required method and the only
other implementation — a hand-written fake in `agentMemory.test.ts` — was not
updated; typecheck stayed green over a structurally invalid object, and the same
gap swallowed a later rename, which surfaced as `x is not a function` at runtime
instead of as a type error. **When you add to or rename on an interface, `rg` the
test doubles by hand**; the compiler is not covering them for you. A green
typecheck says nothing about the fakes, and a fake that no current test exercises
will look fine until the day one does.

## An absolutely-positioned overlay is invisible to a diff and to the DOM query that renders it

During #553's gate the accept control and the inherited-default ghost were read
carefully in the diff, in the CSS, and in the E2E assertions, and all three
looked right. Rendering the row showed the ghost's `Inbox` painted directly on
top of the empty editor's `Empty` placeholder — same origin, both drawn — so the
feature's most common state was illegible. Nothing in the review could have
caught it: the two texts live in different elements, one is a `::before` on a
descendant, and the overlap only exists once both are laid out. The E2E test
already asserted the ghost's text, its `pointer-events`, and its computed color
against `--text-tertiary`, and every one of those passed over the defect.
**A `position: absolute` layer over content you did not author is a visual
question, so answer it visually** — screenshot the element, in both themes,
before calling the review done. Assertions on one layer's computed style say
nothing about what the other layer is painting underneath it. This is the whole
reason the gate table sends UI diffs to visual verification rather than to a
closer read.

## Deleting a "not supported here" warning is not the same as making it supported

`agent-view-surface` PR 1 (#556) generalized `%%view:<mode>%%` from saved
searches to every node. The diff did the obvious thing: renamed
`applySearchViewSpec` to `applyViewSpec`, widened its callers, and deleted the
`View directives are only persisted on search nodes today.` warning sites that
had become false. Two of the gate's four findings came out of that one move.
Adding a directive worked, but *removing* one now returned `ok: true` while the
document kept its table — the warning had been the only thing telling the model
its edit did nothing, and nothing took over the "no" it used to say. The
guidance rewritten in the same PR then promised a second path (`add columns as
fields`) that the widened mechanism still did not implement, so the Agent would
report success on a column the user never saw. **A refusal site is load-bearing:
when you widen a capability past one, each deleted warning must become either
the real behavior or a new warning — never just an absence.** The tell is a
`if (!x) return` early exit where a `warnings.push` used to be; that is a
silent success, and a silent success is worse than the refusal it replaced,
because the model believes it and moves on. Probe both directions of every
newly-general operation — set *and* unset, enter *and* leave — since the added
direction is the one the author tested.

## A coverage claim is verified by reverting the fix, not by reading the test

#558's second gate round deleted an assertion whose premise was genuinely wrong
and justified it by naming another test as the replacement cover. Reading both,
the claim was plausible. Reverting only the fixed source file and re-running,
the replacement **passed** — it never exercised the defect at all, so the
behavior would have shipped with no guard while the PR said otherwise. The
inverse check is just as cheap and just as necessary for a *new* guard: the
`/clear` test added in the same round did fail against the pre-fix tree, which
is the only thing that makes it a regression test rather than a description.
**A test's coverage is a claim about code that no longer exists; the only way to
read it is to put that code back.** `git checkout <pre-fix-sha> -- <file>`, run,
restore — a minute at the gate, against a guard everyone will trust for years.

## An optimistic row needs a way home from every answer, not only the one that echoes it

The transcript in #558 draws the sent message immediately and retires it when
the canonical Turn carrying the same `clientUserMessageId` arrives. That is
exactly right for the send that becomes a message — and `/clear` and `/compact`
are not those: they leave the composer as ordinary text, the host routes them
into a context command, and what comes back is a `contextReset` Item under a Turn
of its own. The id the row was waiting for is never written anywhere, so the
stand-in spun forever under the reset it had just performed; the deduplicated
repeat, answered with no Turn at all, was the same hole through a different
branch. **When a view draws a stand-in for a request, enumerate the host's answer
shapes, not the happy one: the answer that returns something else, and the answer
that returns nothing, each need their own way to retire the row.** The fix that
holds is a second, response-derived handle (the Turn the host reports accepting)
plus an explicit retire on "no Turn at all" — never a renderer-side whitelist of
the commands that behave differently, which re-derives the host's routing in the
one place that cannot see it.

## A test double must copy the boundary's coercion, not just its signature

`agent-view-surface` PR 2 (#559) reconciles view configuration by patching
display fields through `update_display_field`. The core tests drive that command
through a hand-written host shim, and the shim forwarded only the keys it was
handed: `width: args.width === undefined ? undefined : nullableNumber(...)`, with
no `placement` key at all. `documentService` — the real boundary — instead
coerces *every* absent key to `null`: `width: nullableNumber(args.width)`,
`placement: displayPlacement(args.placement)`. Core reads `undefined` as "leave
it alone" and `null` as "clear it". The two objects satisfy the same type and
mean opposite things. Under the real coercion an edit that changed only a
column's width silently deleted its placement, and the patch that finished
creating a new column wiped the order Core had just assigned it — while every new
test passed, because the shim never sent the `null`s that do the damage. **Where
a test double stands in for a boundary that normalizes its arguments, copy the
normalization verbatim; a double that only satisfies the type tests a contract
the app does not have.** The tell is a double that is more careful than
production — a `=== undefined ? undefined :` guard the real handler does not have
is not defensive, it is a different API. This is the semantic half of *A
typecheck that excludes tests will not tell you a test double has gone stale*:
that one is about doubles the compiler stopped checking, this one is about
doubles the compiler still accepts and that lie anyway. It also earns a review
habit — when a finding implies "the tests should have caught this", diff the
double against the real handler before believing the tests.

## Moving work off-thread makes a dormant error boundary load-bearing

`agent-tool-call-path` PR 3 (#557) moved the durable secret scan from a
cooperative main-thread scanner into a worker pool. The scan's caller already
had `try { … } catch { return { value, redactedPaths: [] } }` — a fail-open
boundary that had been in the file for months and read as deliberate policy. It
was, in practice, dead code: the only `throw`s reachable inside the durable path
were encoded-JSON helpers that were caught locally, so the outer `catch` had
never fired. The worker gave it three live routes at once — startup failure, a
crash, and the new watchdog — and on any of them a tool call's durable arguments
and results would have been persisted **unredacted**, silently, where the
main-thread path had always redacted at the cost of a UI hitch. The off-thread
move was measured, reviewed, and correct on its own terms; the regression was
entirely in a handler nobody had touched. **When an operation crosses a
process or thread boundary, re-audit every error boundary it passes through: the
failure modes are new, the handlers are old, and a handler written for a failure
that could not happen encodes no policy at all — it just picks whichever
direction was easy to type.** The question to ask at the seam is not "is this
`catch` correct?" but "what does this `catch` do now that it can actually fire,
and is that the trade I want?" The answer here was to fail *closed* on the
durable path (structure preserved, every pending string `[redacted]`, one fixed
content-free warning) while diagnostics kept its whole-payload omission marker —
and to move the watchdog from enqueue to dispatch, so queue pressure could not
trigger the new boundary on its own. This is A12 read in the other direction:
A12 says put fail-closed `throw`s at write boundaries and let the user path
degrade, and this is the case where a write boundary had been quietly degrading
because its `throw` was unreachable.

## The assistant channel is a few-shot demonstration, not a place to write notes

`subagent-marker-assistant-channel` (#561). `ContextProjector` had, for months,
pushed a `[Subagent started: <path> (<id>)]` line into the *assistant* content it
replays to the model — a status note, obviously informational, addressed to
nobody. In a `main` dev run a root Thread then streamed
`[Subagent message sent: …][Subagent finished: …]` to its user as ordinary prose.
Those were real `agentMessage` deltas: the model wrote them, and neither `kind`
exists in the protocol. It had not copied our text, it had learned the *shape*
from three genuine markers seconds earlier and continued the pattern — a
hallucinated delegation rendered to a human. **Anything the runtime authors into
the assistant channel is a worked example of what to write next, because that
channel is the model's own voice being shown back to it.** A fact the model needs
belongs in a channel it cannot mistake for its prose: the tool call and its
result, a tool-result message, a user-role observation. Ask of every authored
string not "is this accurate?" but "am I willing to see the model produce more
lines like it?" The one authored line we kept — the redacted-replay notice —
earns its place by having to stay atomic with the tool call it explains, and that
exception is named in the spec rather than left for the next reader to
rediscover.

The second-order rule, found at the gate: **an Item that contributes no content
must not act as a boundary either.** The first fix left the two Item types in the
projection switch, below the tool flush, so they emitted nothing but still closed
a provider assistant message — and `SubagentCollaboration` records a child's
`started` activity *between* the two `agent` calls of one batch, so a single
batch replayed as two assistant messages and lost that much cached prefix. "Emits
no content" and "has no effect" are different claims; in a projector that
batches, position relative to the flushes is the effect.

## One signal cannot mean both "it finished" and "we stopped tracking it"

`foreground-agent-settlement-wait` (#562, #563). A foreground `agent` call used
to wait on a hand-rolled edge-triggered predicate, which could spend every
wake-up before it parked and wedge the root Turn until the process was killed.
The right fix was to attach the wait to the settlement state machine that
already computed the answer — but the first round expressed that authority as a
bare `resolve()`, and *every* path that removed a settlement reservation
resolved it. Half of those paths mean "this generation settled"; the other half
mean "we abandoned tracking this generation" — a descendant notification Turn
advancing `currentTurnId`, a Thread deletion, app close. The caller could only
act on the first, so on the others it woke, read a still-running Turn, and wrote
a fabricated "finished" Agent result into the parent's rollout.

**When a wait is handed off to a state machine, the handoff must carry the
machine's outcome, not just its edge.** Model it as a value the caller must
branch on — here `settled | abandoned | failed` — so that adding a new removal
path forces the author to say which one it is. A `void`-shaped completion makes
"abandoned" indistinguishable from "done" at the type level, and the wrong branch
is silent: it produces a plausible result rather than an error.

The paired liveness lesson: **a wait whose only settle paths hang off one
mechanism inherits that mechanism's every precondition.** All reservation
creation was gated on `TurnLifecycle`'s `admissionCommitted`, so an
initial-admission failure created no reservation, and the new wait — unlike the
`ensureTerminalPipeline` call it replaced, which terminated on "no reservation,
no pipeline" — simply never woke. Removing a deadlock by rerouting its wait
reintroduces the deadlock through every door the new route does not cover; the
question to ask is not "does this settle on success?" but "enumerate the states
in which nothing will ever call this." Both PRs also confirm A12 from the
liveness side: an uncancellable await on the user path is a failure shape on its
own, which is why the Stop race in #563 was worth shipping even after #562
landed clean.

## A guard nobody can run before the PR is a guard that fires at the gate

`subagent-customization-and-identity` PR-A (#560). Two product-wide design
guards — no `scale()` in any `transform`, no bare `ms`/`s` literal in any
`transition` — live in `tests/e2e/typography-tokens.spec.ts`, yet both are pure
static scans of `src/renderer/styles/*.css` that never open a browser. The
standard pre-PR checklist is typecheck + `test:core` + `test:renderer` +
`docs:check`, so a CSS-driven blink (`transform: scaleY(.08)` on a
`150ms`/`55ms` transition) went green locally through three rounds of review and
was only caught when the gate ran `test:e2e`.

**Where a guard lives decides when it fires, and a guard that only fires after
the work is finished has already let the work be built wrong.** Two rules follow.
When you touch a surface a product-wide guard polices, mirror that guard into the
unit suite for your surface — #560's fix added the scale/duration assertions to
`threadSpeakerCss.test.ts`, where they fail in the loop the author is already
running. And when a guard needs no browser, question why it sits behind one at
all.

The same PR carries the retirement half of the lesson: it retired the letter-disc
avatar and swept the source cleanly, but **three e2e judges still asserted the
retired shape** (`toHaveText('M')`, `toHaveText('W')`), plus one that asserted a
layout rule the new header supersedes. A retirement sweep that greps only `src/`
is half a sweep; the judges are where a dead subsystem's last claims live, and
they are the claims that turn `main` red. Re-author them against what is now
true — never delete them and never loosen their numbers (B11): each of those four
was protecting a real rule (`main` keyed by name everywhere, the header's own
column) that outlived the shape it was written against.

## A provider's rule belongs in a guard, not in a comment — and "it compiles" is not "it sends"

`automation_update` shipped with a `{ oneOf: [...] }` schema root and took down
every root Turn with an HTTP 400 for two weeks (PR #564). The admission check it
passed on the way out compiled the schema and returned: a root union is perfectly
legal JSON Schema, so the only thing that could tell it was unsendable was the
provider, in front of the user. **A schema is admitted for two different reasons —
that we can validate arguments against it, and that a provider will accept it —
and a check for the first says nothing about the second.**

The rule was not even unknown here. `agentNodeToolSchemas.ts` had carried the
provider's own message in a comment since the node tools were written, and
`node_search` and `node_edit` both express their mutually exclusive argument
groups at runtime *because* of it. A rule that lives in one file's comment
protects that one file: the fix's first round re-derived the forbidden shape in a
different spelling — the gate proposed it and the local compiler was happy to
agree — and it took a second gate pass to notice the repo had already written it
down. **When a provider teaches you a constraint, spend the extra hour making it
executable** (`providerToolSchemaFailure` + the catalog guard + admission), or the
next author, and the reviewer checking their work, will pay for it again.

Two smaller rules from the same merge. **Fail-closed must key off ownership, not
off the channel that registered the tool** — the original admission branch spared
anything arriving through `dynamicTools`, which is precisely how the host's own
Automation tool is registered, so the one tool the incident was about would have
degraded to a `console.warn` instead of throwing. And **a word-boundary is not a
substring match**: the residue guard written to outlaw `codex_app` used
`/\bcodex_app\b/`, which cannot match `codex_app__automation_update` — `_` is a
word character — i.e. it could not match the exact string the provider's 400 had
named.

## A second source for an existing setting needs an invalidation rule, not just a fallback

Remembering the last composer model selection (PR #566) gave "which provider
starts a conversation" a second author. The design handled the case where the
remembered selection stopped being *valid* — an unavailable provider or a stale
model falls back to the active provider — but not the case where the user had
since said otherwise. Nothing cleared the memory, and it was consulted first, so
Settings → Providers → Set as Active would show its success toast and then be
silently ignored by every `/new` for the rest of the app's life. **When you add a
second source for a value that already has an authoritative one, the design
question is not "which one wins" but "what makes the new one stop being true".**
A fallback answers *the value went bad*; only an invalidation rule answers *the
user changed their mind*. The shipped rule is last-explicit-action-wins: every
explicit provider action clears the memory.

The failure mode to look for is specific — an explicit, confirmed user action
that becomes a no-op. That is worse than a wrong default, because the app
acknowledged the instruction.

Two smaller rules from the same merge. **Mutual exclusivity belongs in the type,
not in two `if`s.** The original code decided "did the host supply a remembered
selection?" in one place and "may I use it?" in another, with different
conditions; a request carrying only `cwd` therefore took the remembered provider
and the Profile's model — a pair the configuration codec rejects on the next
read, leaving a Thread whose model could never be shown or changed. Making the
return a discriminated union (`modelProvider` xor `executionSelection`) deleted
the possibility rather than the symptom. And **a hand-copied validator forks the
invariant it was copied from**: the preference decoder re-implemented the codec's
`ThreadConfigurationSummary` check minus the model/provider qualifier agreement,
so the persisted file could hold exactly the pair the protocol forbids. Export
the decoder and reuse it — a second spelling of a rule is a second rule.

## A value that gains a third state must be re-read at every call site, and two judges asserting the same payload for opposite intents prove nothing

The Agents editor (PR #565) wrote a capability narrowing as two states, so
"the user unchecked everything" and "the user changed nothing" both collapsed
into "inherit everything" — a read-only Role was written with its parent's
entire tool set. The fix gave the list its three real states: absent leaves what
is on disk, `null` removes the narrowing, an array is the exact set, and `[]` is
a ban. It also left `tools: draft.tools ?? []` standing at the Role save path,
which folded the new `null` back into `[]`. Every box checked is the default of
the create form, so **every newly created Role was written with zero tools and
zero Skills** — the inversion, now pointing the other way, on the likeliest path
anyone takes.

Two rules, both cheap.

**When you widen what a value can mean, the edit is not the definition — it is
every producer and consumer of it.** Grep the call sites and read what each one
does with the new state before writing the commit message that says the states
are now distinct. Here the intended edit to that call site had silently not
applied (a string replace whose anchor no longer matched) and the file was never
re-read, so a comment describing the *previous* semantics sat directly above the
line that contradicted them. After an edit whose anchor may have moved, re-read
the file rather than trusting that it landed.

**A pair of tests that assert the same value for opposite intents is not
coverage, it is a matched pair of wrong answers.** The suite held
`expect(role.tools).toEqual([])` for everything-checked, commented *inherit*, and
`expect(role.tools).toEqual([])` for nothing-checked, commented *ban*. Both
passed throughout. The property that was actually broken — that the two are
different — was asserted nowhere, and no individual judge can hold it. When two
states must differ, **assert the difference in one judge**, not each state in its
own.

The corollary is where the judge lives. Both of those tests asserted a *payload*,
which is the layer the bug was in, so the payload could be inverted and still
match. The judges that would have caught it run the real chain — writer, then
loader, then `resolveChildConfiguration` — and a browser round-trip that creates
an agent and reopens it. Assert the outcome the user gets, not the argument you
happened to pass.

## Synthetic layout range cannot prove that the reader follows real content

The fixed-edge expansion change (PR #568) needed to distinguish two states that
look identical at the bottom of a DOM scroller. A transcript riding a real tail
should hold the disclosure control while a long message opens, because holding
that control is what staying at the bottom means. A message held at the top by a
temporary send spacer should hold its own block instead, so its text opens
downward. Both states reported `follow = true` and a bottom distance of zero.

The first repair tried to recover the distinction by subtracting the send
spacer and disclosure runway from `scrollHeight`. It still failed while the
spacer was mounted: the scroll handler had already derived `follow` from the
rendered range, and the subtraction missed the flex gap that range introduced.
The predicate therefore selected the control anchor and moved the message shell
from `2px` to `-2154px` when it opened — the same failure under a narrower state.

**Renderer-owned geometry is a mode, not content with a few pixels to subtract.**
When a spacer, runway, placeholder, or virtualization pad owns the range being
measured, branch on that ownership before asking a content-state question. A
boolean derived from synthetic geometry does not become truthful because a
later calculation normalizes one of its contributors, and an inventory of
pixel deductions is brittle because CSS gaps and future layout terms are part
of the same range.

The regression judge must mount the machinery that creates the synthetic state.
A pure helper test can prove which anchor a boolean selects; only the real send
path can prove that the boolean means what its name claims while the spacer is
present. Re-run the exact counterexample as well as the new judge: after the fix,
both the shell-top delta and the `scrollTop` delta were zero while the disclosure
control moved downward with the revealed text.

## A replacement replays admission units, not the first matching message

Manual retry in PR #567 replaces one failed Turn with a new Turn. The first
implementation searched the old Turn for its first `userMessage`, copied that
message and nearby evidence, and rebound its client ID. That looked complete for
a Turn created by one submit, but a running Turn can accept steering: each steer
adds another evidence-plus-user-message batch, its own accepted timestamp, and
its own stable client identity. Selecting one presentation Item silently dropped
every later accepted request even though the provider had already consumed it.

The mistake was treating an event-sourced admission record as a bag of messages.
Its unit is the command boundary that was accepted: ordered evidence, structured
input, timestamp, identity, and provenance. A retry, fork, rollback, or other
replacement that preserves only visible text does not preserve the request, and
searching with `find()` cannot prove that the source cardinality is one.

**Rebuild replacements from every ordered admission unit and commit the swap only
after the complete replacement is durable.** Preserve batch boundaries and
stable identities, exclude output produced by the failed attempt, and rebind
external identities only after the atomic history event succeeds. If any
preparation or persistence step fails, the old canonical record must remain
unchanged and retryable.

The regression judge must cross the boundary that exposed the cardinality: start
a Turn, admit steering while it runs, fail the provider, retry, and assert both
the replacement history and the first replacement provider request. Also assert
that every client identity now resolves to the replacement. A single-message
fixture can prove the happy path while leaving the data-loss path untouched.

## A live fallback needs a replacement value, a refresh boundary, and an owner

PR #570 began with the right A12 decision: malformed Agent configuration should
not end the Turn that is trying to resolve a persona or Role catalog. The first
repair still returned `null` for a broken Role catalog. That looked like a safe
absence at the loader boundary, but the downstream journal already defined
`null` as "no update." A custom Role announced by the previous healthy Turn
therefore remained in model context after the file broke, even though the next
spawn could no longer resolve it.

**A fallback is not complete until it says what state replaces the failed
state.** For snapshot or projection data, "nothing" often means retain the old
value. Degradation needs a canonical replacement or an explicit tombstone: here,
a stable built-in-only snapshot makes normal catalog journaling remove stale
custom Roles. Test the transition, not just the isolated failure: healthy custom
state, broken source, then recovered source, with the removal and restoration
both asserted.

The renderer exposed the other two parts of the same contract. Returning a safe
catalog in `identities/get` did not help an already-open transcript because no
production event asked for it after an external file edit. Refreshing after Turn
admission fixed the root conversation, but the refresh implicitly used the
selected root while a child-detail composer submits to an unselected child. A
worktree child can have a different `.tenon/agent.json`, so the child prompt used
its own fallback while its visible speaker kept the root's persona.

**Every live fallback must name both the boundary that re-evaluates it and the
owner whose state is being replaced.** Configuration edited inside Settings can
use its broadcast; configuration edited outside the app is first guaranteed to
be observed at Turn admission, so admission refreshes the submitted Thread.
Catalog values and stale-response generations are keyed by that Thread, not by
ambient selection, and concurrent reads for two Threads cannot invalidate each
other. The same ownership rule applies to failure episodes: each user/project
layer clears its own diagnostic state when that layer recovers, even while the
other remains broken.

The regression shape is therefore a matrix rather than one happy-path judge:
valid, broken, and repaired across root and independently configured child, with
both the model-facing projection and renderer-facing identity asserted. A test
that calls the safe resolver directly proves only the replacement value; it does
not prove that production re-evaluates the right owner when the source changes.

## Commit guarantees are phase-bound

The first transcript paint-continuity plan (#571) routed event callbacks, rAF
writers, and `useLayoutEffect` writers through one commit-before-return helper.
That contract cannot hold inside a React lifecycle callback: React 19.2.6 warns
that `flushSync` cannot flush while React is already rendering, and the call can
return while the DOM still contains the previous state.

**Define a mutation contract at the execution phase that can satisfy it.** An
event or rAF callback may write, read the browser-clamped result, and synchronously
commit coverage before returning. A layout effect instead prepares state in one
pass and performs the dependent DOM write from a later layout pass that React
still completes before paint. Share the pure calculation, not an impossible
commit mechanism, and place acceptance samples at each phase's real guarantee.

## Async recovery must reacquire execution authority

The subagent task-outcome plan (#569) first treated a successful durable sidecar
detach as enough authority to construct the base-only provider retry. Stop can
settle the Turn while that detach is awaiting storage; the callback then returns
into an execution attempt that no longer owns the right to start provider work.

**A completed persistence step proves data state, not that its caller still owns
the runtime action.** An asynchronous recovery callback should return durable
state and stable operation identity only. After the await, synchronously recheck
the same Turn and attempt, unsettled state, and `AbortSignal` before constructing
or invoking the next source. If cancellation won, keep the durable recovery but
suppress the downstream action and preserve the winning terminal provenance.

Test the authority boundary by pausing the durable callback, winning every Stop
path, releasing the callback, and asserting both the final provenance and the
total external-attempt count. A normal recovery fixture cannot expose the stale-
continuation race.

## Pointerdown is not scroll intent until it moves the scroller

PR #572's transcript paint repair initially used transcript-level `pointerdown`
as proof that the reader had taken scroll ownership. That caught scrollbar drag,
but it also caught ordinary controls inside the transcript. Clicking Show more
on a sent long message fired the parent's `pointerdown` before the button's
`click`, cleared the send anchor spacer, and removed the very rendered range the
disclosure anchor needed to preserve.

**Do not classify an input primitive by its low-level event alone when nested
controls share the surface.** A pointerdown on an interactive descendant is not
scroll intent by itself; if the browser or control action really moves the
scroller, the later scroll event can arbitrate ownership. Tests for this class
must use real pointer/click paths, not DOM `element.click()`, because the latter
skips the event that decides ownership.

## A current entity record is not a history index

PR #573 made the stable Subagent execution record the renderer's authority for
delivery identity. That fixed ordinal matching for the current generation, but
the first implementation projected only `terminalNotification(agentId,
currentGeneration)`. After the same Agent resumed, generation 1's already
delivered parent Turn vanished from `deliveryByTurnId`, so the raw host notice
reappeared where the child report card belonged.

**When one stable entity spans multiple historical episodes, project the episodes
as first-class rows.** A current record may summarize lifecycle, but it cannot be
the only source for per-generation UI anchors, retry aliases, report cards, or
audit facts. If old screen content must remain attached after a resume, rollback,
or retry, the process-seam DTO needs a list keyed by the historical identity, and
renderer memo equality must compare that list. A test that advances the stable
record without asserting the earlier row is still visible is testing the
replacement, not the preservation contract.

## Structured failure results can be commit decisions

PR #577 fixed Agent Node tools that caught a late mutation exception, returned a
recoverable `ToolEnvelope`, and accidentally let the surrounding document
transaction commit the earlier commands. The host saw a successful JavaScript
return, while the model saw `ok:false`; both facts were true, and the document
kept the partial write.

**When a tool owns a structured success/failure envelope inside a transaction,
the envelope is part of the commit protocol.** Throwing is not the only rollback
signal. If `ok:false` means "this tool call did not apply", translate that result
into a rollback at the transaction boundary, then return the original envelope
after the rollback completes. Keep explicit world-state tools, such as undo/redo,
outside that wrapper when their failure semantics intentionally describe the
state operation itself.

Regression tests for this class need an in-transaction partial write followed by
a model-visible failure result, plus an assertion that revision, node set, and
operation history stayed unchanged. A preflight-only invalid argument case does
not prove the rollback boundary.

## Ephemeral paths are not durable replay contracts

PR #576's first artifact-resource plan made the canonical file durable but kept
the producing Turn's readable path in persisted tool output. The runtime deletes
that materialization when `resourceObservation.dispose()` closes the execution,
so the next Turn could replay a path that no longer existed even though the
Thread still owned valid bytes.

**Persist durable identity and derive access handles at the boundary that uses
them.** A path into disposable scratch is live execution state, not artifact
history. Persist the resource reference and stable metadata, then rematerialize a
current path during historical projection, Preview, export, or another path-based
consumer. A fork must resolve from the copied target-Thread resource, never from
the source Thread's old path.

Tests for durable artifacts must tear down the producing observation before they
assert readability. Cover the next Turn, restart, and fork; an immediate
same-Turn `file_read` proves only that the original scratch directory was still
alive.

## Display identity and storage identity are separate contracts

PR #581's plan gives every large paste a distinct, user-visible filename while
allowing identical pasted bytes. The existing attachment store includes that
filename in its resource key, so a matching content digest does not imply shared
managed storage.

**Specify presentation identity and byte identity independently.** When the user
needs separate logical attachments but storage should deduplicate their bytes,
the contract needs distinct logical names over a content-addressed storage key.
If the current key combines name and digest, state that identical content may
consume storage more than once instead of implying that hashing provides
deduplication.

Tests for this boundary need two equal payloads with different display names and
must assert both the logical attachment count and the physical storage outcome.

## Artifact ownership follows the execution through every terminal path

PR #582 initially scanned one Turn-scoped output root for concurrent Bash calls,
so a delayed background write could be claimed by an unrelated foreground Item.
The same implementation dropped already-admitted embedded-shell resources when
a later isolated-Skill phase failed. In both cases the bytes existed, but the
Item that actually produced them did not reliably own them.

**Give each execution its own attribution boundary and preserve admitted
ownership even when a later phase fails.** A shared before/after scan cannot
identify the producer under concurrency, and a failed outer operation does not
erase the resource side effects of an earlier successful phase. Allocate output
roots per tool execution, carry admitted references through every terminal
result, and let lifecycle reconciliation clean up only genuinely unreferenced
resources.

Regression coverage must interleave a delayed background write with an unrelated
foreground execution, and must persist one artifact before forcing a later phase
to fail. In both cases, assert that exactly the producing tool Item owns the
resource.

## Cooperative batching starts before the visible loop

PR #583 initially chunked imported node creation but synchronously resolved every
Daily Note target first. Each resolution materialized document state again, so
2,000 dates beside 12,000 existing nodes blocked the main process for about 5.27
seconds before the first advertised yield.

**Measure entry-to-first-yield latency, including target resolution, indexing,
and preflight work.** A yielded inner loop does not make the operation cooperative
when its setup is unbounded. Build one shared lookup for the batch, yield while
resolving targets as well as while creating content, and keep setup chunk commits
inside the same rollback frontier and Undo group as the consumer work.

Regression coverage needs both halves: a large pre-existing document that bounds
the first and subsequent slices, and an injected failure after a setup chunk has
committed that proves projection and operation history return to their original
state.

## Replacement admission is a projected transaction

PR #586 initially treated large-paste replacement as an insertion checked against
the current attachment count. That rejected a valid one-for-one replacement at
the 20-item limit. Its first rollback fix also snapshotted another pending marker,
then let slice removal cancel that marker's request; when the outer upload failed,
rollback restored an identifier whose controller, queue entry, and tray state no
longer existed.

**Validate replacement against the state that can actually commit or roll back.**
Capacity is `survivors + additions`, with an identity removed from `survivors`
only when the selection removes every one of its markers. A rollback snapshot may
contain asynchronous state only while the operation retains that state's
ownership and liveness; otherwise reject the replacement before allocating an
identifier or mutating the document. Restoring serialized shape without restoring
the live operation behind it creates plausible-looking dead state.

Regression coverage needs both boundaries: replace one fully selected identity at
the exact capacity while a partially selected multi-marker identity still counts,
and attempt a failing replacement over an unsettled operation while asserting no
new request starts and no orphaned marker can return.

## A persisted upgrade must cover every authority that can restore the other

PR #585's first authorship design made a new field strict everywhere and offered
only a clone-scoped dev-data wipe. That would have quarantined installed Threads
whose append-only rollout and SQLite projection both contained the valid previous
shape. Fixing only the ordinary read path would still fail when either store later
rebuilt the other.

**Keep new admission and writes strict, but apply one exact-schema upgrade at
every persisted read seam that can become recovery authority.** Materialize one
explicit conservative value such as `unknown`, then let canonical validation and
all downstream recovery operate on that value. Do not recursively rewrite raw
JSON, infer trust from surrounding records, or let the compatibility rule become
a default for new callers.

Regression coverage must exercise both recovery directions, every nested event
carrier, and a malformed near-match that still fails closed. A compatibility test
that covers only the primary store proves normal startup, not durable recovery.
