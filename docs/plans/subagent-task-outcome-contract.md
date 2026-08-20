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
continue a direct parent so it can consume child output and settle its own run.

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
worktree, output-file reference, and stop provenance remain separate.

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
parent's current generation, not a child resume or a new generation. Unrelated
work should normally spawn a new Agent, but the host does not classify prompt
intent.

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
parent consumes background child notifications. A parent generation that is at
or above its breaker and still owes direct-child judgment settles as follows:

1. Wait until every direct background child is terminal and its notification is
   durable, preserving the existing descendant-before-parent ordering.
2. Claim every pending direct-child notification in stable order and admit one
   idempotent notification Turn in the same parent generation. Every claimed
   notification records that Turn as its `deliveryTurnId`.
3. Mark the Turn as the generation's sole exhausted-settlement continuation.
   It bypasses only the exhausted-budget admission check, exposes no tools, and
   therefore makes exactly one logical provider call. Canonical provider retries
   remain bounded by their own retry policy; the model cannot spawn, resume,
   invoke an isolated Skill, or create another descendant wave.
4. Debit and persist the call's usage to the same generation even though it may
   overshoot the breaker. Success, provider failure, interruption, or host
   restart all release the parent reservation and allow terminal settlement;
   none schedules a second exhausted-settlement continuation.

The settlement epilogue does not launder the original stop into ordinary
completion. After a successful epilogue the generation remains `interrupted +
budget`; an epilogue failure or host restart additionally preserves that Turn's
typed error. The epilogue output is the parent's best available handoff, not a
claim that the interrupted assignment became complete.

Before the notification Turn commits, claim/admission failure releases the
batch and the existing idle/startup delivery retry may try again without a
provider call. After commit, the stable client input and persisted continuation
Turn make recovery idempotent. Non-exhausted parents and root Threads keep the
ordinary notification path; this exception exists only to close an exhausted
delegated generation without discarding child output or deadlocking its parent.

The batch itself is durable state, not an inference from whichever notification
remains first after a crash. Its parent generation, continuation Turn, and
ordered `{agentId, generation}` members are reserved together. Claim/release and
the transition that binds every member to the committed `deliveryTurnId` use one
transaction or equivalent compare-and-set protocol. Startup either retries the
uncommitted batch with the same identity or recognizes the committed Turn and
finishes every member without a second provider call; it never creates a
smaller successor batch from a partially delivered prefix.

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

**FR-05:** Persist the frozen cap, settled usage, warning latch, and exhausted-
settlement continuation identity beside the execution generation. Carry that
state through initial admission, explicit resume, rollback, each Turn
settlement, terminal settlement, and startup recovery with compare-and-set
guards. An older terminal pipeline cannot debit or overwrite a resumed
generation.

Usage becomes durable at ordinary or failure Turn settlement, as it does today.
A hard process crash may lose usage observed only in the in-flight model call;
startup preserves the last settled value and marks the crashed Turn
`interrupted + hostRestart`, but does not reconstruct provider usage or add a
per-call journal. The next explicit generation still receives a fresh breaker.

Extend `SubagentExecutionProjection` with the typed terminal error and the exact
parent `deliveryTurnId`. This absorbs `subagent-projection-error-surface`: cold
reopen keeps the failure reason, and a settled-but-undelivered child Turn cannot
shift report cards through the current count-from-the-end join. Missing
inspection-only projection data degrades under A12; it does not fail a user
Turn or settlement.

### Parent and renderer behavior

**FR-06:** Replace the notification's ambiguous single status with explicit
execution status and stop provenance while retaining the non-user boundary,
IDs, neutral output, error, usage, worktree, output-file reference, escaping,
and scanner. Launch and resume copy promises notification when the **run
settles**, never when the task completes.

`threadBecameIdle` and `deliverPendingNotifications` remain the canonical
delivery route and may start the direct parent's notification Turn. Their
provider work lets the parent judge already-recorded child output; it never
rewrites the child output or resumes the child. Exhausted delegated parents use
FR-04's single batched settlement continuation.

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
  `subagentExecutionProjection` - generation budget, ownership split,
  exhausted-parent continuation, batched delivery, resume, recovery, and
  delivery.
- Native runtime budget ports and kernel fixtures - ordinary generation
  enforcement plus the host-admitted, tool-free single-call settlement mode.
- `stablePrompt.identityBlock` and its prompt fixtures - one canonical
  delegated-Thread handoff instruction for built-in and custom Roles, without
  a parser or settlement dependency.
- `agentSettings` - unchanged numeric default, revised per-generation meaning.
- `subagentPresentation` and Agent anchor/work-strip/detail components -
  execution-only labels and durable errors/delivery joins.
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
  parent settlement call. Its model request and canonical provider retries are
  bounded, usage is recorded, and every terminal path closes the generation.
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

- PR #568 (`long-message-disclosure-anchor`) has merged. Its
  `agent-thread-rendering` and adjacent renderer changes are baseline; this
  branch rebases onto that baseline before implementation.
- Non-Draft PR #567 (`provider-retry-state-machine`) plans terminal-error,
  `ThreadService`, `threadStore`, and runtime/rendering-spec changes. It is
  significant; whichever implementation lands second adopts the first protocol
  shape.
- Non-Draft PR #570 (`agent-config-turn-path-degrades`) directly overlaps
  `ThreadService` and `agent-subagent-threads`. It should land before this
  implementation, then this branch rebases.
- `subagent-projection-error-surface` is absorbed, not parallel work.
- The significant queue remains at its cap of two: #567 and this plan. Under
  the repository's lane rules, #570 does not consume a significant review-queue
  slot.

## Acceptance Criteria

- **AC-01:** Every normally settled delegated generation is `finished`, never
  `completed`, in notification, projection, renderer, and cold-reopen fixtures.
- **AC-02:** Normal, failed, interrupted, killed, and budget-stopped generations
  preserve useful scanned partial output under one neutral payload name without
  a provider call that rewrites the stopped Turn or a task-completion claim;
  direct-parent delivery follows AC-06.
- **AC-03:** Exhausting one generation neither debits nor stops a sibling or
  descendant; each measured incident child fits independently under the
  default.
- **AC-04:** Explicit resume preserves identity, transcript, and worktree,
  increments generation, reads and freezes the current configured breaker, and
  preserves prior output.
- **AC-05:** The model and host collaboration seams contain no
  `max_total_tokens`, `maxTotalTokens`, `childTokenCap`, member `tokenCap`, or
  capped-child pool; `subagentTokenBudget` is the only breaker input.
- **AC-06:** An exhausted delegated parent with pending descendants consumes all
  durable direct-child notifications in one idempotent, tool-free notification
  Turn, makes at most one logical provider call under the bounded retry policy,
  records its overshoot usage, remains `interrupted + budget`, and reaches
  terminal on every outcome. Crash points before reservation, after partial
  claim, after Turn commit, and during batch delivery never duplicate the call
  or strand a notification.
- **AC-07:** Crash recovery preserves terminal status, provenance, typed error,
  neutral output, exact delivery Turn, and usage committed before the crash;
  tests explicitly retain the in-flight usage-loss residual.
- **AC-08:** No stop, warning, output, delivery retry, or idle hook resumes a
  stopped child or manufactures its handoff. Canonical idle/startup retry may
  admit the direct parent's notification Turn, with pre-commit retries making
  no provider call.
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

## Build Checklist

- [ ] Rename terminal `completed` to `finished`; update codec, envelope,
  projection, renderer, and fixtures without adding a task-status axis.
- [ ] Split request cancellation ownership from generation-local budgets;
  remove ancestor pools, sibling debits, capped-child pools, and stale rules.
- [ ] Delete the unreachable per-child cap seam and make the configured setting
  the sole breaker authority at every generation admission.
- [ ] Preserve ordinary parent notification continuation; add the idempotent
  batched, tool-free single-call settlement path for an exhausted parent.
- [ ] Preserve output on every stop path; persist typed error and delivery Turn
  across resume/rollback/restart races, while retaining hard-crash in-flight
  usage loss explicitly.
- [ ] Add the canonical final-handoff instruction to every delegated Thread and
  pin that it remains model-authored output rather than settlement state.
- [ ] Rewrite the named spec sections and sweep active plans/board premises at
  main's retirement gate.
- [ ] Run `bun run typecheck`, `bun run test:core`, `bun run test:renderer`,
  targeted Agent E2E, `bun run docs:check`, and light/dark visual verification
  before marking the implementation PR ready.
