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
