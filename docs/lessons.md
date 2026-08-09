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
