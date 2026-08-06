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
