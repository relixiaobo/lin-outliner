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
