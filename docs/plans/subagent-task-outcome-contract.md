# Subagent Task Outcome Contract

Shape: **(a) ONE complete feature in one PR.** The execution vocabulary,
generation budget, persistence, output envelope, renderer, tests, and current
specs land together. A partial slice would leave another surface calling a
stopped run a completed assignment.

## Goal

### Purpose

Stop claiming that delegated work is complete merely because one Agent run
ended normally. Preserve useful output and the exact stop cause across failure,
kill, budget interruption, resume, delivery, and cold reopen, while replacing
the shared request-tree budget with an isolated breaker per execution
generation.

The host records **execution facts only**. The parent still judges whether the
output satisfies the assignment.

## Non-goals

- No task-completion status or tool, Goal, generated success criteria, or host
  inference from prose.
- No payload tier based on inferred task outcome. All useful content uses the
  same neutral `output` contract.
- No forced post-interruption summary and no automatic resume.
- No aggregate request ceiling, new aggregate live-execution gate, currency
  budget, or product token-control UI.
- No model-facing transcript/output reader. Full omitted output remains a
  user/host inspection artifact; a later parent generation receives no automatic
  full read and must resume a named child or report the limitation.
- No changes to root Goals, context compaction, permissions, worktrees,
  isolated-Skill result ownership, user-stop authority, depth, or concurrency.
- No compatibility reader for retired pre-release budget/execution rows or the
  old notification envelope.

## Design

### Decision

Three changes form one contract:

1. Rename delegated terminal `completed` to `finished`. It states that the run
   reached an ordinary stop, not that the assignment is done.
2. Give every child execution generation its own token breaker. Siblings and
   descendants never debit one another.
3. Deliver one neutral `output` payload with execution status and stop
   provenance. On a normal stop, the delegated prompt asks for a concise
   self-reported handoff: concrete work produced, checks and evidence, remaining
   or uncertain work, and the next useful action. Parent guidance says
   explicitly that output is where the run stopped, not necessarily where the
   assignment stands.

No state in this design resumes a stopped child or manufactures its missing
handoff. Resume remains an explicit parent or user action on the same Agent ID
and transcript. The existing host-authored background notification may still
continue a direct parent so it can consume a bounded, omission-aware view of
child output and settle its own run. Complete child output remains durable; the
host never implies that omitted evidence was inspected.

### Evidence, constraints, and rejected alternatives

The triggering development session used one `1,500,000`-token tree pool. Four
initial children consumed `601,836`, `295,740`, `372,895`, and `455,090`
tokens: `1,725,561` together, while no individual child approached the breaker.
Three were interrupted. Cache reads were approximately 64% of usage. Repair and
repeated synthesis later took the conversation to approximately `6.116M`
tokens and `$9.34`; the shared cutoff did not produce a cheaper completed task.

The inspected `Coding/.research-repos/cc-2.1` snapshot has no equivalent shared
delegation-tree token pool. It preserves transcript state across compaction and
resume and can retain partial output on kill. Tenon adopts those continuity
properties but avoids its ambiguous use of `completed` for both process and
work semantics.

Rejected alternatives:

- Raising the shared pool only moves the sibling-starvation threshold.
- Disabling every default cap leaves one vague or runaway generation unbounded.
- A machine-readable child completion declaration remains an unverified
  self-claim, adds an A4 protocol/tool surface, and can misread in UI as
  host-verified completion. A free-form evidence-and-gaps handoff remains useful
  as output because the parent can inspect rather than trust it.
- Reusing `ThreadGoal` adds objective and continuation semantics that open-ended
  exploration may not have; the archived `subagent-budget-propagation` plan
  already rejected Goal as the resource carrier.
- A forced summary is not evidence of completion and spends the resource whose
  exhaustion caused it. This rejects a new call in the stopped child; it does
  not reject the direct parent's existing notification continuation.
- Suppressing parent notification continuation strands durable output and can
  deadlock nested terminal settlement.
- Sending every complete child output in that continuation is not a context
  contract: twenty ordinary answers can exceed one provider window, and repeated
  generations are unbounded. The continuation therefore uses bounded excerpts
  plus durable full-output references and explicit omission coverage.
- Allowing ordinary steering or manual Turn Retry inside the exceptional
  continuation makes its overshoot and delivery identity open-ended. New input
  is rejected before target mutation and may be submitted again only after the
  continuation settles; the exceptional Turn is not manually retryable.
- Restoring a model-facing per-call cap adds protocol surface for a control the
  current product deliberately removed; one configured generation breaker is
  sufficient.
- A durable per-provider-call usage journal would narrow hard-crash accounting
  loss but adds write amplification and recovery identity beyond this fix.
- Extending the new-Agent concurrency gate to resume and isolated Skills would
  turn this resource-isolation change into a scheduler and alter existing
  continuity semantics. The PM instead accepted unbounded aggregate exposure.

### Execution state and output requirements

**FR-01: Honest terminal vocabulary.** Change `SubagentTerminalStatus` from
`completed | failed | interrupted | killed` to `finished | failed | interrupted
| killed`. The underlying Turn retains `completed | failed | interrupted`;
delegation settlement maps a normally completed Turn to `finished`.

`stopProvenance` remains `none | model | user | budget | hostRestart` and is the
second execution fact. No new task-status axis is added. Renderer and parent
copy derive useful distinctions from the pair, for example `finished + none`,
`interrupted + budget`, and `killed + model`.

**BR-01: One payload.** Foreground results and background notifications use one
neutral `output` element whenever the stopped Turn contains useful scanned
text. Failure, interrupt, kill, and budget stop preserve partial output. Empty
output omits the element; the host invents nothing. Typed error, usage,
worktree, output-file reference, and stop provenance remain separate. FR-04 may
place a bounded excerpt of that neutral output in provider input, but the source
`output` remains complete and its coverage is explicit.

**BR-02: Self-reported handoff, no completion claim.** On a normal stop, the
shared delegated-Thread prompt asks the Agent's final response to state:

- what it produced or concluded;
- which checks or evidence support that work and their actual results;
- what remains incomplete, uncertain, or unchecked, and why; and
- the next concrete check or action when work remains.

Progress is stated as concrete completed and remaining work. A numeric count is
appropriate only when the scope is objectively enumerable; the Agent does not
invent a percentage for open-ended work. The prompt requires all four facts but
does not prescribe a parseable template. If no check ran or no remaining issue
is known, the response states that explicitly rather than relying on omission.

This handoff remains untrusted model-authored content inside neutral `output`.
The host does not parse it into an enum, validate it as a terminal precondition,
persist a task status, or derive a renderer label from it. Missing or malformed
handoff content does not change `finished` or trigger another provider call in
that stopped child. If a failure, interrupt, or kill prevents a final response,
the host preserves only the output that already exists and does not manufacture
the handoff.

A normal stop, a polished conclusion, or an error-free run never changes the
execution fact into task completion. Every parent envelope carries one
instruction: this is where the run stopped, not necessarily where the
assignment stands; inspect the reported work, evidence, and gaps, then either
use it, resume with concrete missing work, ask the user, or report the
limitation.

**BR-03: Explicit resume.** Resume keeps Agent ID, Thread, transcript,
configuration, model, and worktree; increments execution generation; and
creates a fresh generation breaker. No terminal status, budget warning,
notification, delivery retry, or idle hook resumes the stopped child. The
canonical notification continuation of a direct parent is delivery within that
parent's current generation, not a child resume or a new generation. Once
FR-04 closes that generation's notification cutoff, a later child generation
remains addressable and resumable. Its later result becomes eligible for the
first explicit parent generation admitted after that notification is durable;
it never reopens the closed generation or targets a parent generation merely
because the child started. Unrelated work should normally spawn a new Agent, but
the host does not classify prompt intent.

### Run flow

```text
spawn or explicit resume
  -> running
  -> finished / failed / interrupted / killed
  -> optional neutral output + error/usage/provenance
  -> canonical direct-parent notification continuation
  -> parent judgment and parent settlement
  -> optional explicit resume as a new generation
```

### Per-generation budget

**FR-02: Budget authority.** `subagentTokenBudget` remains `1_500_000` by
default and now applies separately to every child execution generation;
`null` still disables it. Budget identity is `{agentId, generation}`. Each
generation owns persisted usage, one in-flight tally, one 80% warning latch,
and one frozen cap. Initial spawn, explicit resume, and isolated-Skill admission
read the current setting once; changing the setting affects only later
generation admissions. Sibling and descendant usage is invisible to that
breaker.

Isolated Skills use the same child-runtime breaker but retain Skill-owned output
delivery. Request ownership still records which delegating Turn may close and
cancel a descendant set; ownership no longer carries or resolves resource
allowance. Split or rename `SubagentRequestLedger` APIs and rows so an ownership
record cannot be mistaken for a budget pool.

**FR-03: One budget authority.** `subagentTokenBudget` is the only child breaker
input. Do not restore `max_total_tokens` to `agent` or add it to
`agent_message`. Delete the now-unreachable internal `maxTotalTokens` /
`childTokenCap` seam, `MIN_SUBAGENT_TOKEN_CAP`, member `tokenCap`, capped-child
pool identity and rows, validation, comments, and contract fixtures. Spawn,
resume, and isolated Skills all receive the configured generation default;
there is no per-call override or descendant inheritance rule.

**FR-04: Warning, hard stop, and parent settlement.** The 80% notice asks the
Agent not to imply completion merely because the limit is near and, if work
remains, to preserve the same handoff facts early: concrete progress, verified
evidence, unknown or unchecked work, and the next action. Hard exhaustion uses
the existing typed kernel interruption. Transcript, Items, partial text, tool
results, worktree, and settled usage persist before delivery. An already
accepted terminal answer keeps the existing last-call overshoot rule.

Hard exhaustion never starts another call in the stopped child. It does not,
however, suppress the canonical provider continuation through which a delegated
parent consumes background child notifications. Only two pre-epilogue outcomes
are eligible for the exceptional continuation:

- `budgetInterrupted`: the kernel hard-interrupted the parent between provider
  rounds because its breaker was exhausted; and
- `normalOvershoot`: the parent produced an accepted tool-free terminal answer,
  crossed its breaker on that last call, and remained reserved only because
  direct background children were outstanding.

Persist that origin from the actual pre-epilogue Turn. Do not infer it later
from `usage >= cap`. A provider failure, user/model stop, or host-restart
interruption does not become eligible merely because usage also crossed the
breaker. Before publishing either an eligible or noneligible stopped generation
as idle, persist the generation-closing latch defined below. Once its descendants
settle, a noneligible generation closes with its existing terminal fact and
reclassifies all unconsumed direct-child notifications as carry-forward in the
cutoff transaction. It neither deadlocks nor starts provider work that would
erase the stop boundary.

An eligible generation settles as follows:

1. Wait until every direct background child is terminal and its notification is
   durable, preserving the existing descendant-before-parent ordering.
2. Build a candidate bounded envelope from that immutable terminal snapshot.
   Under the parent-generation gate, recheck the full descendant and notification
   set. A changed snapshot releases the gate and restarts this step; a stable one
   closes the cutoff and prepares one batch in `goals.sqlite` with its origin,
   reserved Turn ID, and complete ordered `{agentId, generation, turnId}` member
   set.
3. Append one idempotent `turn/started` carrying the prepared batch identity and
   envelope digest to the parent rollout. That exact append is the cross-store
   commit point. Finalize every member's `deliveryTurnId` in the ledger before
   provider launch.
4. Run that Turn in persisted `exhaustedSettlement` mode. It bypasses only the
   exhausted-budget admission check, exposes no tools, accepts no steering, and
   permits at most one logical assistant round. Canonical automatic provider
   attempts remain bounded by the provider-retry policy; no second assistant
   round, tool loop, warning message, descendant wave, or manual Retry exists.
5. Debit and persist all normalized usage reported by the attempts to the same
   generation even though it may overshoot the breaker. Every terminal path
   releases the reservation and settles the batch; none schedules a second
   exhausted-settlement Turn.

**Bounded settlement envelope.** The entire serialized active-Turn input,
including wrapper, metadata, excerpts, escaping, and omission markers, must be
no larger than both `16_384` estimated tokens under the common provider
estimator and `65_536` UTF-8 bytes. Its actual ceiling is lower when necessary:
the provider-aware allowance subtracts the stable prompt, provider framing, and
reserved response budget from the selected model's input window; no tools are
present. The builder shrinks content before Turn execution; it never relies on a
provider overflow as its sizing mechanism. An unexpected provider-reported
overflow remains a typed epilogue context failure with provider-attempted but
zero child-judgment coverage, not permission for a second epilogue. The static
ceilings leave room for the parent's response while bounding multibyte and
escaping expansion; the 20-entry limit matches the default new-Agent fan-out,
while resumed overflow is disclosed rather than treated as impossible.

The durable batch may contain any number of members, but the provider envelope
contains excerpts for at most 20. Group members by Agent, order groups by each
Agent's earliest pending `(createdAt, agentId)`, order each group's generations
newest first, and select round-robin across groups. This represents each direct
Agent's latest pending generation before repeated generations from one Agent can
consume every slot. Take only the selection prefix whose fixed metadata and
aggregate marker fit both ceilings. Provider input identifies full output by the
fixed `{agentId, generation, turnId}` tuple. The host manifest stores only those
validated identities, execution status, provenance, usage numbers, typed-error
code, source byte/token counts, disposition, and nested coverage counts. It
never copies a description, error message, output text, worktree path, or
transcript path. The envelope resolves those variable fields from their
canonical source, then makes description, error message, and output text share
the variable allowance. Divide that allowance equally among selected members
and redistribute unused shares in the same stable order. Each excerpt keeps a
deterministic head and tail, favoring the tail where the requested handoff should
appear.

Every batch member receives a durable `full | excerpted | omitted` disposition.
An excerpted member carries its own marker with exact omitted UTF-8 bytes and
estimated tokens. Members outside the 20-entry or provider-fit boundary are
represented by one aggregate marker with exact counts and the batch manifest
identity. If any content is not full, the host instruction says that complete
judgment is impossible from this Turn, requires the parent to disclose that
limitation and the next inspection action, and forbids a claim that every child
result was checked. The host does not trust compliance: aggregate full,
excerpted, omitted, and provider-attempted facts also travel as separate
settlement coverage in the parent's eventual foreground result or background
notification and projection.

Full output remains authoritative in each child's canonical Turn Items and
transcript. The host resolves a manifest tuple through those existing records;
it does not persist a second path or content copy. The manifest never crosses the
process seam and this plan adds no manifest-list or manifest-member IPC. The
existing execution projection carries only bounded coverage derived from that
manifest: aggregate `full` / `excerpted` / `omitted` counts on the parent and one
disposition plus numeric omitted-byte/token counts on a projected child
generation. The user opens the existing child Thread to inspect its complete
transcript. The tool-free epilogue cannot read omitted content and never claims
otherwise; a later parent generation may explicitly resume a named child, but
no hidden chunk call or model-facing read tool is added.

**Single-round admission boundary.** Persist `exhaustedSettlement` before the
Turn becomes active. Renderer submission and `agent_message` must detect that
mode and refuse before appending an Item, consuming a client ID, or queuing
steering. Renderer keeps the unsent draft and shows a non-auto-retrying settling
result; the Agent tool returns a structured retry-after-settlement result. The
host does not silently defer input, because a queued message could otherwise
resume work after a later user stop. Once the epilogue is terminal, only a newly
submitted user message or a fresh `agent_message` call may take the ordinary
explicit-resume path and create a new generation with a new breaker.

Batch activation and renderer/Agent input use the same parent-generation gate.
The batch prepares only while no accepted input or pending steering exists. If
explicit admission acquires the gate first, it reclassifies the old generation's
pending rows as carry-forward, prepares the fresh generation, and holds the gate
through its cross-store commit or rollback. A successful commit closes the old
generation without an epilogue and claims only the rows that fit the new
sidecar; rollback lets the closing pipeline retry. If the cutoff/batch prepares
first, the no-mutation rejection above applies. No race can attach input to the
single-round Turn without letting the model consume it.

Renderer Stop, `task_stop`, and host interruption still abort the live provider
attempt. The `turn/retry` command rejects an `exhaustedSettlement` Turn and the
renderer shows no Retry action for it, including after provider failure or host
restart. Automatic attempts inside its one logical assistant round remain the
only retry path.

Final status comes from the persisted origin plus the actual epilogue outcome:

| Pre-epilogue outcome | Epilogue terminal event | Generation terminal fact |
|---|---|---|
| `budgetInterrupted` | assistant round finishes | `interrupted + budget` |
| `normalOvershoot` | assistant round finishes | `finished + none` |
| either eligible origin | provider, context, or non-restart host failure | `failed + none`, with the typed epilogue error |
| either eligible origin | Renderer Stop | `interrupted + user` |
| either eligible origin | `task_stop` | `killed + model` |
| either eligible origin | restart after provider attempt may have begun | `interrupted + hostRestart` |

Partial epilogue output and settlement coverage survive every row. A successful
epilogue preserves the pre-epilogue execution meaning; a failed or explicitly
stopped epilogue reports what actually ended the generation. Crossing the cap
alone never rewrites a normal answer into a budget interruption.

**Generation-closing cutoff.** Every eligible and noneligible exhausted parent
uses one `open -> closing -> closed` generation record. The actual pre-epilogue
terminal event writes `closing` before the idle hook can claim ordinary delivery;
startup resumes that closing work without provider I/O. The closing pipeline
waits for descendants outside the lock, then takes one parent-generation gate
shared by direct-child generation admission, terminal-notification commit,
ordinary notification claim/Turn admission, and explicit parent admission. It
never waits for a child while holding that gate. The parent-generation gate is
always acquired before a child resume lock or the parent's existing Turn-
admission lock; no callback may acquire them in the reverse order.

At the cutoff linearization point, recheck that no direct child generation is
live, prepared, or in terminal settlement and that no pre-cutoff notification is
already delivering. One `goals.sqlite` transaction then records `closed` and:

- for an eligible origin, freezes every pending pre-cutoff row into the prepared
  epilogue batch; or
- for a noneligible origin, leaves no Turn to run and atomically reclassifies
  every pending pre-cutoff row as carry-forward with
  `eligibleAfterGeneration = G`.

An explicit parent admission that wins the gate before an eligible epilogue
prepare uses the same closing transaction with an `explicitAdmission`
disposition: all pending pre-cutoff rows first become carry-forward eligible
after `G`, and only the residual-capacity subset is claimed into prepared
generation `G+1`. Rows that do not fit remain pending; the generation rollback
restores the cutoff to `closing` and every row to its pre-prepare classification,
so the eligible epilogue may compete again. Only a rollout commit makes the
`explicitAdmission` cutoff and carry-forward classification final.

If direct-child resume linearizes first, its newly prepared generation makes the
cutoff recheck fail and the closing pipeline waits for that generation's durable
terminal notification. If the cutoff linearizes first, resume may proceed but
records that child generation as carry-forward-only; it cannot reopen `G`.
Ordinary delivery that linearizes first must finish or roll back its Turn
admission before cutoff can close; after `closing` is durable, no new ordinary
delivery claim may begin. A closed cutoff makes idle/startup delivery skip its
carry-forward rows. Those rows remain liveness and inspection facts, but no
longer count as outstanding descendant work that can keep generation `G` open.

**Prepared cross-store admission.** Neither an epilogue nor a fresh-generation
sidecar claims crash atomicity across stores. Its `goals.sqlite` prepare record
is written first and contains the admission kind, reserved Turn ID, stable batch
ID, immutable member set and dispositions, serialized-envelope digest, and, for
an explicit generation, the complete previous-generation, cutoff, and member-
classification snapshot. The exact rollout `turn/started` containing the same
bounded batch ID and digest is the commit point; `thread_history.sqlite` is a
rebuildable projection, not an authority. Turn execution and provider I/O remain
blocked until the ledger finalizes the committed generation and every active
member link.

Startup reconciles prepared records against the rollout before notification
delivery, child terminal recovery, or new admission:

- when no `turn/started` exists for the reserved Turn ID, an explicit generation
  atomically restores its previous generation, previous cutoff state, and pre-
  prepare notification classifications; a prepared epilogue keeps its closed
  cutoff but cancels that admission and returns its members to pending, after
  which settlement recovery may prepare a new Turn/batch without provider I/O;
- when that reserved Turn carries the exact prepared batch ID and envelope
  digest, startup finalizes the generation and its links to the one durable Turn
  and never rolls back or appends a replacement; and
- when the reserved Turn ID exists but its admission identity or digest differs,
  startup still commits the generation identity, marks the batch
  `admissionFailed`, starts no provider work, terminalizes that Turn with the
  typed admission error, and links no member. Explicit-sidecar rows regain their
  pre-prepare eligibility; failed-epilogue rows become pending carry-forward
  eligible after `G`.

The parent-generation gate stays held from ledger prepare through Turn append
and ledger finalize during live admission. Therefore a terminal notification
never observes a merely prepared generation as current. A crash drops the
in-process gate, but startup reconciliation restores the same ordering before
any competing pipeline runs. After live admission or startup reconciliation
settles, every notification is consequently either pending with its defined
eligibility or linked to exactly one durable initial Turn.

For an epilogue, persist an attempt marker immediately before provider I/O.
Startup may execute a committed Turn whose marker proves no attempt began; if an
attempt may have begun, it terminalizes that same Turn as `interrupted +
hostRestart` and never replays it. A deterministic preflight capacity failure
settles the committed Turn as failed with zero provider attempts and explicit
zero-consumption coverage. This at-most-one-round choice prefers an honest
incomplete handoff over a duplicate overshoot.

**Carry-forward eligibility.** Child resume does not preassign a numeric parent
target. A carry-forward-only child generation's terminal transaction reads the
parent's last committed generation after prepared-admission reconciliation and
stores that number as `eligibleAfterGeneration`. Explicit parent generation `H`
may claim only pending rows with `eligibleAfterGeneration < H` whose notification
commit linearizes before the prepare for `H`.

Notification commit and explicit parent prepare use the same parent-generation
gate, and their committed order is the eligibility order. If the notification
commits while parent generation `G` is committed, `G+1` may claim it. If `G+1`
commits first, even if provider I/O has already begun when the child settles, the
notification records `G+1` and `G+2` is its earliest eligible generation. It is
never injected into running `G+1`, ordinary idle/startup delivery skips it, and
it never starts a hidden continuation. Capacity deferral leaves the row pending
with the same eligibility rather than pinning or retargeting it. With no later
explicit parent generation, the durable pending count remains visible and no
provider work occurs.

**Fresh-generation capacity priority.** Carry-forward is an optional non-user
sidecar, not part of the mandatory explicit input. Before claiming eligible
rows, admission resolves the ordinary stable prompt and tool schemas, preserves
the complete explicit user/Agent input plus its context evidence and attachments,
reserves the model response allowance, and proves that base request fits without
carry-forward. A base request that does not fit follows the existing capacity
failure path and moves no notification state.

Only the remaining estimated-token allowance may hold carry-forward, additionally
capped at `16_384` estimated tokens and `65_536` UTF-8 bytes. The fixed pending
marker itself is capped at 128 estimated tokens and 512 UTF-8 bytes. If that
marker does not fit, admission starts the otherwise-valid explicit generation
unchanged, claims no rows, and exposes their pending count only through the host
projection. If it fits, admission applies the same deterministic selection,
fair-share excerpt, and omission rules to all then-eligible rows within the
residual allowance. Under the parent-generation gate, the final encoded-fit
check shrinks or drops the sidecar before the ledger prepares generation `H`,
its reserved Turn, and the immutable claim set. A dropped sidecar claims no
rows. The cross-store protocol above, rather than a fictitious shared
transaction, then commits or rolls back that preparation. Carry-forward can
never reject or truncate a base request that fit on its own during admission.

**Pre-output overflow fallback.** The common estimator remains intentionally
approximate. If the provider rejects the first fresh-generation request for
context overflow before any assistant content or tool admission, and that Turn
has a carry-forward sidecar, one dedicated sidecar fallback detaches that
optional evidence before the canonical overflow-compaction counter runs. It is
available at most once per Turn and does not consume #567's ordinary compaction
retry. Under the parent-generation gate, one ledger transaction marks the batch
`detachedForOverflow`, clears its active Turn links, and returns every member to
pending with unchanged eligibility. The durable detached state makes all later
projections of that generation omit the sidecar even though its batch reference
remains in the canonical Turn for audit.

The same logical assistant round then retries exactly the stable prompt, tools,
explicit input, evidence, attachments, and response reserve that the no-backlog
generation would have sent. It adds no compaction or replacement Turn. If the
durable detach write itself fails, fail closed as an independent persistence
error; if any output/tool admission already occurred, no sidecar-free retry is
allowed and the actual provider failure settles normally with the existing links
authoritative. If the base-only retry also overflows, it enters the unchanged
ordinary overflow path with the full canonical compaction retry still available.
This fallback protects explicit work from estimator error without claiming that
provider tokenization is locally exact.

Non-exhausted delegated parents and root Threads keep the ordinary notification
path. The unified cutoff applies only when an exhausted delegated generation has
already reached its pre-epilogue terminal boundary: eligible origins receive the
one bounded continuation, while noneligible origins close without provider work.

### Retirement of tree conservation

This change explicitly retires the tree-conservation subsystem shipped by PR C
of `subagent-budget-propagation`; it is not a reinterpretation of that pool.
Against that plan's normative rulings:

- Rulings 1-4 die as tree rules: no ancestor-pool walk, pool-covered predicate,
  single pool per tree, child-anchored pool, sibling debit, or pool-wide live
  tally remains.
- Ruling 10 survives generation-scoped: the kernel port still returns one
  authoritative live `remaining` value for the configured breaker, with the
  one exhausted-settlement admission exception above; member-cap and
  shared-pool constraints no longer exist.
- Ruling 11 survives generation-scoped: usage still comes from the runtime
  normalizer, never diagnostics; its observer feeds only that generation.
- Rulings 13 and 15 survive generation-scoped: accrual and live-tally clearance
  remain one synchronous settlement so persisted and in-flight usage cannot be
  double-counted.
- Ruling 16's every-descendant observer installation survives because every
  descendant generation may have a breaker; live ancestor coverage resolution
  and re-binding die.
- Typed errors, fail-soft runtime reads, transactional admission/rollback,
  user-trigger bright lines, and user-facing token-number suppression survive
  unchanged where they do not depend on a shared pool.

The accepted exposure is explicit. New collaboration-Agent admission retains
`DEFAULT_MAX_CONCURRENT_SUBAGENTS = 20` and `MAX_SUBAGENT_DEPTH = 3`, so twenty
newly admitted default generations alone represent roughly `30M` live breaker
capacity, about 20 times today's `1.5M` shared ceiling. That is a baseline
scenario, not a maximum. Existing-Agent resume intentionally bypasses the new-
spawn count, and isolated Skills do not participate in it. A long-lived Thread
can therefore resume historical Agents concurrently on top of twenty new
collaboration children while other Threads run isolated Skills. Aggregate live
token exposure has **no finite upper bound**, and sequential explicit resumes
are likewise unbounded in aggregate because each generation receives a fresh
breaker.

The PM ratified that trade on 2026-08-20. This plan preserves current resume,
Skill, depth, and concurrency behavior rather than expanding a token-isolation
fix into a global scheduler. The trade favors failure isolation: the shared
ceiling was terminating healthy fan-outs and forcing work to restart from zero
at greater total cost.

### Persistence, recovery, and delivery

**FR-05:** Persist the frozen cap, settled usage, warning latch, pre-epilogue
origin, `open | closing | closed` notification state, exhausted-settlement mode,
prepared admission and previous-generation snapshot, fixed batch identity and
digest, immutable member manifest, batch link state (`prepared | linked |
detachedForOverflow | admissionFailed`), member coverage,
child-generation carry-forward class, `eligibleAfterGeneration`, provider-
attempt marker, and continuation identity beside the execution generation.
Carry that state through initial admission, explicit resume, rollback, each Turn
settlement, terminal settlement, and startup recovery with compare-and-set
guards. An older terminal pipeline cannot debit, rebind, or overwrite a resumed
generation.

Recovery treats rollout `turn/started` as the only cross-store commit fact and
runs prepared-admission reconciliation before generic crashed-Turn settlement,
notification delivery, or child terminal replay. The read projection may be
rebuilt after that decision but cannot cause a generation rollback or finalize a
batch by itself. Batch detachment after recognized pre-output overflow is a
durable ledger transition, so restart cannot reinsert the omitted sidecar or
lose the rows returned to pending.

Usage becomes durable at ordinary or failure Turn settlement, as it does today.
A hard process crash may lose usage observed only in the in-flight model call;
startup preserves the last settled value and marks the crashed Turn
`interrupted + hostRestart`, but does not reconstruct provider usage or add a
per-call journal. The next explicit generation still receives a fresh breaker.

Extend `SubagentExecutionProjection` with the typed terminal error, exact parent
`deliveryTurnId`, and bounded settlement-coverage summary, including its origin.
The new error projection carries its bounded code plus a UTF-8-safe message
preview capped at 4,096 bytes and the exact omitted-byte count. Every other field
added by this plan is a bounded enum, validated ID, safe integer, or aggregate
count; the fixed-identity manifest never crosses the process seam. Full variable
content stays in its canonical child Turn and existing transcript surface. This
absorbs `subagent-projection-error-surface`: cold reopen keeps the failure
reason, and a settled-but-undelivered child Turn cannot shift report cards
through the current count-from-the-end join. Missing inspection-only projection
data degrades under A12; it does not fail a user Turn or settlement.

### Parent and renderer behavior

**FR-06:** Replace the notification's ambiguous single status with explicit
execution status and stop provenance while retaining the non-user boundary,
IDs, neutral output, error, usage, worktree, output-file reference, escaping,
and scanner. Launch and resume copy promises notification when the **run
settles**, never when the task completes.

`threadBecameIdle` and `deliverPendingNotifications` remain the canonical
delivery route for open, ordinary rows and may start the direct parent's
notification Turn. They must take the parent-generation gate and skip a closing
or closed generation's carry-forward rows. Their provider work lets the parent
judge already-recorded child output; it never rewrites the child output or
resumes the child. Exhausted delegated parents use FR-04's single bounded
settlement continuation. When that continuation did not receive every full
member output, its foreground result or next parent notification and Agent
detail show the host-recorded included/excerpted/omitted counts and whether
provider I/O began. Carry-forward rows deferred for timing, capacity, or
pre-output overflow show as a separate pending count until claimed; model prose
cannot hide either gap.

`subagentPresentation` uses the single execution axis plus provenance. A normal
run says `Finished`, not `Complete`; a budget stop may say `Interrupted - Budget
limited`; failure and user/model stop retain their existing meanings. No task
status or combined completion label is added. `deletableFinishedRoots` remains
liveness/queued-work based. Product UI does not show token counts.

## Open Questions

None before implementation. An aggregate request ceiling may return only as a
separate opt-in policy if post-ship telemetry shows broad fan-out or repeated
explicit resumes, rather than one-generation runaway, dominates cost. It must
not silently restore sibling coupling. A finite live bound would require a
separate product decision for admission, queuing, resume, and isolated-Skill
semantics rather than a hidden reuse of the new-Agent counter.

## Files And Ownership

- `src/core/agent/protocol.ts` and `src/core/agent/codec.ts` - honest terminal
  vocabulary, error/delivery projection, and clean-cut codecs.
- `SubagentExecutionLedger`, `SubagentRequestLedger`, `TurnLifecycle`,
  `SubagentCollaboration`, `subagentOutput`, and
  `subagentExecutionProjection` - generation budget, ownership split, durable
  fixed-identity batch manifest, durable-after-admission carry-forward,
  bounded envelope, resume, recovery, and delivery.
- `ThreadService`, `PiTurnExecutor`, `ContextBudgetPlanner`, and native kernel
  and provider-retry fixtures - pre-mutation steering rejection,
  base-request-first capacity planning, sidecar-aware overflow recovery,
  ordinary generation enforcement, and the tool-free single-round settlement
  mode.
- `ContextProjector` - omit a durably detached carry-forward sidecar from every
  later provider projection of that generation without deleting its canonical
  audit reference.
- `stablePrompt.identityBlock` and its prompt fixtures - one canonical
  delegated-Thread handoff instruction for built-in and custom Roles, without
  a parser or settlement dependency.
- `agentSettings` - unchanged numeric default, revised per-generation meaning.
- `subagentPresentation`, `threadStore`, `ThreadView`, and Agent anchor/work-
  strip/detail components - execution-only labels, settlement coverage, no
  manual Retry, and durable errors/delivery joins.
- Focused Core, renderer, E2E, codec, restart, budget, and parity fixtures.
- `docs/spec/agent-subagent-threads.md` - replace the shared request-pool and
  `subagent_request_pools` / `subagent_request_members` persistence contract.
- `docs/spec/agent-model-runtime.md` - replace ancestor-pool walk, live
  pool tally, binding `remaining`, and explicitly capped covered-member rules
  with generation-local runtime ports.
- `docs/spec/agent-thread-rendering.md` and `docs/spec/agent-tool-design.md` -
  notification vocabulary, parent instruction, and presentation.

The Core protocol is a shared surface and needs coordinated ownership. Dev
agents do not edit `docs/TASKS.md` or `CHANGELOG.md`; main owns the absorbed
board item, retired-premise sweep, and changelog at merge.

## Risks

- Aggregate live exposure has no finite upper bound. Twenty new collaboration
  Agents provide a `30M` baseline before concurrently resumed historical Agents
  and isolated Skills are added; sequential resumes are also unbounded. This is
  the ratified isolation trade. Telemetry must distinguish new breadth,
  concurrent resume, isolated Skills, repeated resume, and one-generation
  runaway.
- One exhausted delegated generation may overshoot for exactly one tool-free
  parent settlement round. Its request envelope has fixed token and byte caps,
  provider attempts remain bounded, usage is recorded, and every terminal path
  closes the generation.
- The bounded epilogue may not contain every full child output. Deterministic
  fair selection, per-member dispositions, aggregate omission coverage, and
  durable source Turns make that limitation visible and recoverable; the direct
  parent must report rather than conceal incomplete inspection.
- At-most-one-round settlement rejects steering and manual Retry and will not
  replay a logical round after an ambiguous crash. This can leave a weaker
  parent handoff, but preserves user-stop authority, stable delivery identity,
  and a finite overshoot. Fresh explicit input remains the recovery path.
- Child generations that finish after a parent cutoff can accumulate durable
  carry-forward notifications. A row becomes eligible only after its own durable
  commit and waits for the first later explicit parent generation with marker
  capacity. It is never injected into a generation already admitted, never
  overrides explicit-input capacity, and never creates a hidden continuation.
- A direct child resumed before cutoff keeps the parent generation open until
  that child settles; a resume after cutoff is carry-forward-only. Repeated
  explicit resumes can therefore delay closure, but cannot let a parent report
  terminal ahead of live descendant work or reopen a closed generation.
- Generation/notification state and canonical Turns cannot share a storage
  transaction. Durable prepare records, rollout `turn/started` as commit point,
  provider-launch gating, and startup reconciliation replace crash atomicity.
  A mismatch fails admission rather than guessing which store won.
- A provider can reject an estimated-to-fit fresh request before output. The
  sidecar-detach fallback may spend one extra rejected provider attempt, but the
  retry is the unchanged base request, every row returns to pending, #567's
  canonical compaction allowance remains intact, and no second logical assistant
  round or replacement Turn is created.
- The coordination manifest is unbounded in member count but contains only fixed
  identities and scalar facts and never crosses IPC. Aggregate coverage and
  per-generation dispositions cross as bounded projection fields; full text
  remains in the existing child transcript surface.
- A normal `Finished` run may or may not satisfy the assignment. That ambiguity
  is honest and intentional; the parent receives the Agent's evidence-and-gaps
  handoff as untrusted output and makes the judgment.
- An Agent may omit, misunderstand, or overstate part of the requested handoff.
  Settlement remains fail-soft: the omission is visible to the parent, never
  promoted into host status, and never repaired with a hidden provider call.
- A hard crash can lose in-flight usage that never reached Turn settlement.
  Persisted usage remains authoritative; eliminating this residual would
  require a separate per-call journal and performance trade.
- Partial output can be wrong. Neutral `output` states provenance, not quality;
  scanning and the untrusted-output boundary remain.
- Retiring a three-pass conservation subsystem has broad blast radius. Build
  foundation before consumers, use clean-cut persistence, and gate the retired
  reference surface as well as runtime behavior.

## Collision Result

- This branch is rebased onto `main` at `42409996`, including merged PR #567
  (`provider-retry-state-machine`) and #570 (`agent-config-turn-path-degrades`).
  Their Retry, typed-error, prepared-generation, `ThreadService`, and fail-soft
  config contracts are baseline. `exhaustedSettlement` remains the explicit
  no-manual-Retry exception to #567.
- Open Draft PR #571 (`thread-transcript-paint-continuity`) plans changes to
  `ThreadView.tsx`, `tests/e2e/agent-thread.spec.ts`, and
  `docs/spec/agent-thread-rendering.md`, which this plan also names. #571 should
  implement and land first because its renderer-only paint ownership is
  independent and smaller; this implementation then rebases and preserves that
  baseline while changing Agent execution presentation. The overlap is a file
  radar signal and does not serialize plan review.
- `subagent-projection-error-surface` is absorbed, not parallel work.
- The significant review queue is at its cap of two: #569 and #571.

## Acceptance Criteria

- **AC-01:** Every normally settled delegated generation is `finished`, never
  `completed`, in notification, projection, renderer, and cold-reopen fixtures.
- **AC-02:** Normal, failed, interrupted, killed, and budget-stopped generations
  preserve useful scanned partial output under one neutral payload name without
  a provider call that rewrites the stopped Turn or a task-completion claim;
  direct-parent delivery follows FR-04 and AC-06/AC-17 as applicable.
- **AC-03:** Exhausting one generation neither debits nor stops a sibling or
  descendant; each measured incident child fits independently under the
  default.
- **AC-04:** Explicit resume preserves identity, transcript, and worktree,
  increments generation, reads and freezes the current configured breaker, and
  preserves prior output.
- **AC-05:** The model and host collaboration seams contain no
  `max_total_tokens`, `maxTotalTokens`, `childTokenCap`, member `tokenCap`, or
  capped-child pool; `subagentTokenBudget` is the only breaker input.
- **AC-06:** An eligible exhausted delegated parent claims one immutable batch
  and admits one `exhaustedSettlement` Turn with no tools, steering, warning
  injection, descendant work, or manual Retry. It makes at most one logical
  assistant round under the bounded automatic provider-attempt policy, records
  overshoot usage, and reaches terminal on every outcome without rebinding any
  member's active `deliveryTurnId`. Its unified notification cutoff prevents a
  later child generation from admitting a second epilogue.
- **AC-07:** Crash recovery preserves terminal status, provenance, typed error,
  neutral output, exact delivery Turn, pre-epilogue origin, member coverage,
  notification cutoff/closing state, `eligibleAfterGeneration`, prepared batch
  identity/digest, provider-attempt fact, and usage committed before the crash.
  A prepared epilogue with no rollout commit returns its rows to pending while
  retaining the closed cutoff; settlement recovery may prepare again without
  prior provider I/O. Post-attempt recovery cannot replay it. Tests retain the
  ordinary in-flight usage-loss residual.
- **AC-08:** No stop, warning, output, delivery retry, idle hook, rejected
  steering, or Turn Retry resumes a stopped child or manufactures its handoff.
  Renderer and Agent input racing an active epilogue mutates no target state;
  Stop remains available, and only input newly submitted after settlement may
  start an explicit fresh generation.
- **AC-09:** The runtime has no ancestor budget walk, shared-pool gate/debit,
  sibling tally, capped-child pool, or shared-pool persistence row after the
  clean cut.
- **AC-10:** Root Goals, Skill-owned delivery, permissions, worktrees, user-stop
  boundaries, cancellation ownership, depth, cleanup, and current concurrency
  semantics regress none: new collaboration Agents retain the count gate,
  while resume and isolated Skills remain outside it and aggregate live breaker
  exposure remains unbounded.
- **AC-11:** Every delegated normal-stop prompt requests produced work, actual
  checks/evidence, incomplete or uncertain work, and a next action; prompt tests
  pin the contract, while missing compliance creates no task status, failed
  settlement, parser fallback, or extra provider call.
- **AC-12:** The complete serialized epilogue input stays within `16_384`
  estimated tokens, `65_536` UTF-8 bytes, and the provider-specific protected-
  input allowance. Fixtures cover 20 maximum-fan-out Agents, more than 20
  concurrently resumed Agents, repeated generations from one Agent, oversized
  output/error/path text, deterministic fair selection, excerpt markers,
  whole-member omission, and a pre-provider capacity failure.
- **AC-13:** Status fixtures pin every FR-04 matrix row. In particular, a
  successful hard-interruption epilogue is `interrupted + budget`, a successful
  normal last-call overshoot is `finished + none`, and epilogue failure, user
  stop, model stop, and ambiguous host restart report their own terminal facts
  rather than deriving status from `usage >= cap`.
- **AC-14:** Carry-forward ordering fixtures serialize notification durability
  against parent admission. If `G+1` provider I/O begins before the child
  notification settles, the row records `eligibleAfterGeneration = G+1`, is not
  injected or idle-delivered, and is first eligible for `G+2`. If the row
  commits first, `G+1` may claim it. A row deferred for capacity stays pending
  and eligible without a hidden continuation or numeric retarget.
- **AC-15:** A fresh explicit generation plans its stable prompt, ordinary
  tools, complete explicit input/evidence/attachments, and response reserve
  before carry-forward. A fixture with a near-capacity attachment, large tool
  schemas, and a large backlog starts exactly as it would without that backlog;
  the sidecar shrinks or disappears, claims remain pending when even its
  128-token / 512-byte marker cannot fit, and bounded host coverage stays
  visible. A second fixture makes the common estimator admit a high-tokenization
  sidecar while the provider reports overflow and no prior Turn is compactable:
  before output, the batch durably detaches, its rows return to pending, and the
  same logical round retries the byte-identical no-sidecar base request without
  consuming the ordinary compaction retry counter.
- **AC-16:** The batch manifest stores no free-form text or paths and has no
  renderer IPC. Projection fixtures cap the new error preview at 4,096 UTF-8
  bytes with an exact omission count and prove that all other new cross-process
  fields are bounded identities, enums, safe integers, or aggregate counts even
  when one source member is oversized.
- **AC-17:** Cutoff race fixtures put a direct-child resume between the terminal
  observation and cutoff. Resume-first makes the parent recheck fail and wait;
  cutoff-first admits only a carry-forward child generation. For provider
  failure, user stop, model stop, and host restart whose settled usage is also at
  or above the breaker, fixtures place a notification both before and after
  cutoff and prove that the parent closes with its original terminal fact,
  ordinary delivery starts no provider work, and every row stays visible and
  eligible for a later explicit generation.
- **AC-18:** Cross-store admission fixtures crash an explicit carry-forward
  generation after ledger prepare but before rollout append, after the exact
  `turn/started` append but before ledger finalization, and after ledger
  finalization but before provider launch. The first rolls back the precise
  generation and restores the prior cutoff state and notification
  classifications; the latter two retain the same committed generation, cutoff
  disposition, and Turn without replacement. Fixtures cover both a later
  admission from an already-closed cutoff and an explicit admission that
  preempts `closing`. A reserved Turn whose batch identity or digest mismatches
  starts no provider work. After every recovery, each notification is either
  pending with its pre-prepare eligibility or linked once to that durable initial
  Turn, and history projection rebuild cannot change the decision.

## Build Checklist

- [ ] Rename terminal `completed` to `finished`; update codec, envelope,
  projection, renderer, and fixtures without adding a task-status axis.
- [ ] Split request cancellation ownership from generation-local budgets;
  remove ancestor pools, sibling debits, capped-child pools, and stale rules.
- [ ] Delete the unreachable per-child cap seam and make the configured setting
  the sole breaker authority at every generation admission.
- [ ] Preserve ordinary parent notification continuation; add the idempotent
  batched, bounded, tool-free single-round settlement path for an eligible
  exhausted parent, including rejection of steering and manual Retry.
- [ ] Add one persisted generation-closing cutoff for eligible and noneligible
  origins; serialize child resume, notification commit, ordinary delivery, and
  explicit parent admission through the parent-generation gate.
- [ ] Preserve output on every stop path; persist typed error and delivery Turn
  plus batch origin, coverage, and attempt identity across resume/rollback/
  restart races, while retaining hard-crash in-flight usage loss explicitly.
- [ ] Pin the provider-aware envelope builder, fair member selection, durable
  fixed-identity manifest, omission disclosure, and pre-provider capacity
  failure without adding manifest IPC.
- [ ] Extend prepared-generation admission across the sidecar/batch identity,
  use rollout `turn/started` as commit point, and pin rollback/finalization for
  every cross-store crash window.
- [ ] Protect the complete base request before allocating residual sidecar
  capacity; on recognized pre-output overflow, durably detach the sidecar and
  retry the unchanged base while returning its rows to pending.
- [ ] Add the canonical final-handoff instruction to every delegated Thread and
  pin that it remains model-authored output rather than settlement state.
- [ ] Rewrite the named spec sections and sweep active plans/board premises at
  main's retirement gate.
- [ ] Run `bun run typecheck`, `bun run test:core`, `bun run test:renderer`,
  targeted Agent E2E, `bun run docs:check`, and light/dark visual verification
  before marking the implementation PR ready.
