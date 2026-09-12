# Tool Recovery and Evidence Integrity

## Goal

Make tool failures actionable and execution conclusions attributable, so an
Agent can recover from invalid input or changed state without repeating mistakes,
borrowing unrelated evidence, or claiming an unsupported cause.

The user should receive an accurate account of what happened, whether the
requested outcome was achieved, and what remains unknown. Development startup
is one acceptance fixture, not the feature boundary.

Minimum outcome: action-specific input is advertised consistently with admission;
invalid calls identify the repair; state conflicts preserve their exact receipt;
and an observation of an existing object cannot be presented as proof that the
current execution created, changed, or controls it.

## Non-goals

- A development launcher, fixed ports, clone-name rules, or automatic restart.
- A new Task, evidence registry, health-check tool, global retry coordinator,
  process scanner, or general-purpose causal inference engine.
- Weakening single-instance protection, command admission, filesystem/network
  permissions, or the distinction between inspection and mutation authority.
- Automatically dropping invalid arguments, changing operation IDs, replaying
  writes, or interpreting every nonzero command exit as an infrastructure failure.
- Rewriting historical observations, adding legacy readers, or diagnosing the
  historical Runtime timeout without new causal evidence.
- A transcript redesign, new persistent business-success state, or a claim that
  prompts mechanically guarantee arbitrary application semantics.

## Design

### Evidence and existing foundations

The inspected session explicitly requested another project. Its target selection
was authorized; running in a different project from the Agent Host is not itself
an error. Two acknowledge calls included a forbidden revision field and failed;
the second changed only the operation ID. A later corrected call succeeded.
The current `TASK_CONTROL_INPUT_SCHEMA` advertises the union of all action fields
with only common fields required, while `decodeTaskControlInput` rejects fields
outside each action's set. This is a demonstrated input-language mismatch.

A handoff conflict followed a normally exited launch. An older process at another
port was then described as if it survived that launch. Shared path, a responding
endpoint and exit code zero do not establish that relationship. Duplicate launch
hitting the single-instance lock fits the observations, but the incident did not
retain an explicit lock-refusal event: preserve that as a hypothesis.

Consume the existing [tool contract](../../spec/agent-tool-design.md),
[Agent Core](../../spec/agent-core.md) and
[integration checklist](../../spec/agent-integration.md). Task responsibility,
immutable execution addresses, canonical Items, result envelopes, receipt replay
and provider-visible historical arguments already have owners. The shipped
[image and service design](agent-evidence-and-service-readiness.md)
removed cwd equality as readiness identity; this plan must not restore it.

### Delivery shape and sequence

**Shape: (b) A SET of three independent complete features, one PR per unit.**
Each unit includes its runtime or guidance consumers, tests and current specs;
none is scaffolding for a later release. Suggested implementation order is
A, B, C to reduce churn in shared tool projections. B and C remain independently
useful on current main. No requirement waits for all three to deliver value.

At each unit's start, refresh the open claims and regenerate the affected call
sites from symbol searches. Capture its baseline before edits. If inspection
shows the existing mechanism already supplies the required fact, fix its
projection or consumption rather than invent another owner.

### Unit A: action-specific contracts and diagnostic repair

Deliver a consistent accepted input language for `task_control`, with the same
mechanism applicable to other discriminated action tools when evidence warrants.

1. Put the Task action field sets, required fields, constraints and descriptions
   in one declarative definition beside the existing Task input contract. Derive
   the public schema and action-shape validation from it. Keep semantic checks
   such as ownership, revisions and evidence ordering with their existing owners.
   Do not hand-maintain a second field matrix in prompts or tests.
2. Advertise a closed discriminated alternative for every action: acknowledge
   requires an event reference and forbids revision/readiness; handoff requires
   revision and readiness; watch operations retain their exact existing inputs.
   Verify the actual schema after provider conversion, not only its source object.
3. Providers differ in schema support. Use supported nested alternatives or the
   existing provider conversion seam, without inventing new model tools or silently
   losing constraints. If a supported provider cannot represent the accepted
   language, stop that unit's implementation for a concrete contract amendment;
   descriptive text alone must not be labeled schema parity.
4. Admission refusal identifies action, offending field path, violation kind and
   required/allowed fields in bounded existing error message/instructions. Do not
   echo rejected values, secrets, paths or foreign object identities. Preserve
   `invalid_arguments` and the current result envelope; a new persisted error
   taxonomy is unnecessary for this feature.
5. The instruction tells the Agent what to change. Shape rejection executes no
   side effect and creates no accepted operation receipt. Do not silently remove
   the extra field and execute the user's mutation.

Files/owners: `src/core/agent/taskContinuation.ts`, Task registration and decoding
in `ToolRuntime`, existing schema-to-provider conversion only if required, focused
contract/provider tests, tool-design specification and relevant packaged guidance.
The sweep is bounded to Task control; enumerate other mismatches as follow-ups
from the same runnable audit, not an unbounded all-tool rewrite.

Acceptance: enumerate each action's valid minimal inputs, missing required fields,
extra action fields, malformed references and unsupported actions. Public-schema
validation and runtime shape validation agree for that corpus, including through
supported provider adapters. Invalid input reaches no executor/store mutation.
A live model receiving the recorded extra-field mistake can repair it without
repeating the same malformed call; report failures as well as successes.

### Unit B: outcome-aware recovery without replay ambiguity

Deliver useful recovery guidance at the current Task result boundary. Tool
transport success, operation acceptance, process exit and user-goal fulfillment
must remain distinct.

| Observed result | Required next step | Forbidden inference/action |
| --- | --- | --- |
| Rejected input | Correct the identified fields using the current contract | Repeating identical invalid input with another operation ID |
| Conflict receipt | Read the owned Task/current state; decide whether the requested action still applies | Treating `ok: true` as an accepted mutation or repeatedly incrementing IDs/revisions |
| Lost response / outcome unknown | Reconcile by exact operation ID; replay identical input only under its existing idempotency contract | Submitting a fresh write because the reply was lost |
| Temporary unavailability | Retry only when the owner permits it and a bounded retry is meaningful | Global retries or repeated unchanging probes |
| Completed command with exit zero | Evaluate the requested behavior using attributable output | Claiming a persistent service or application success from exit status alone |
| Expected negative observation | Report the observed absence/mismatch as data where the tool contract supports it | Hiding an unexpected failure with a shell success suffix |

Keep `accepted`, `conflict` and `already_handled` receipts unchanged and durable.
Add bounded recovery instructions through existing result projection. Receipt
replay returns the same receipt; any accompanying current-state inspection is
explicitly separate and time-qualified, never a rewritten historical reason.
Do not infer an exact historical conflict cause from today's state. If current
readiness/state is unavailable, give the safe read/reconciliation step and retain
unknown cause rather than inventing a reason field in storage.

An operation's ID binds its exact input. Unknown-outcome retries reuse that ID
and input. A deliberately revised operation may use a new ID after resolving
what happened to the previous one; changing ID alone never repairs arguments.
Same-input retry guidance is not authorization to replay non-idempotent tools.

Files/owners: Task tool projections in `ToolRuntime`, `ToolTaskService` only where
owner-provided observations are insufficient, current tool-error mapping,
built-in development guidance and any directly contradictory stable tool text,
Task/Thread tests and tool-design specification. Inspect `ToolTaskStore` replay
behavior but avoid changing receipt storage. Existing UI details consume the
returned fields; no new renderer lifecycle owner or UI feature is included.

Acceptance: stopped service handoff, stale revision, already handled event,
concurrent Stop, reply loss, replay after restart, and a receipt read while the
current state changes. Assert no duplicate execution, unchanged accepted receipts,
no revived responsibility and bounded recovery instructions. Include a successful
finite command and failed application check in the same fixture to expose false
success flattening. Invalid-input recovery remains useful even before Unit A.

### Unit C: attributable observations and calibrated conclusions

Deliver complete observation-to-conclusion behavior using existing Task/Item
provenance and process supervision, plus packaged Agent guidance.

For an owned execution, project its existing Task ID, originating Item, admitted
address, start/completion timestamps and available supervisor/child identity in
a bounded view. First inspect the already recorded `processObservation` and
`taskExecutionContext` payloads and `task_status` projection. Add only missing
exposure of recorded facts; optional OS inspection must degrade when unavailable.
A PID alone is not durable identity: PID reuse, reparenting and a wrapper's exit
must not become evidence of a new ownership relationship.

For externally observed processes, files or remote operations, retain the exact
observation source and time. Use existing version, hash, request ID or process
start identity when available. Distinguish in Agent reasoning and output:

- Association proven by the existing owner or an explicit causal receipt.
- A pre-existing or independently observed object, with no new control authority.
- Association unknown because evidence is absent, stale or conflicting.

These are interpretations of evidence, not new persistent Task states. Do not
adopt external processes, grant Stop/restart authority, or enumerate the machine
on every tool call. Scope any on-demand inspection to the authorized target.
A matching cwd, filename, port, display name or healthy sibling is insufficient.
Project selection controls future defaults under #679, not old Task identity.

Agent guidance separates observed facts, whether the user goal is fulfilled, and
causal hypotheses. An existing healthy service can satisfy “make it available”
without proving “my command launched it”; a request to run new code requires
version/process evidence. Equivalent rules apply to an existing output file or
a remote operation whose receipt was lost. Ask the user only if choosing reuse,
replacement or restart changes intent or exceeds current authorization.

Files/owners: existing Task status/process observation projection and their types
only as needed, stable Agent tool guidance and built-in development Skill,
Task/Thread/provider-boundary tests, Agent Core/tool-design/integration specs.
No new machine-wide probe or synthetic relationship is added to persistence.
If required process-generation identity is absent, report association unknown;
a new lifecycle identity protocol requires a separate concrete amendment.

Acceptance: two same-path processes with different launch times; an existing
healthy service and a new normally exited launch; reused PID; a detached child
without authoritative lineage; a pre-existing output file and a no-op successful
command; remote reply loss with an exact existing receipt; stale observation after
replacement; explicit target outside the Host's project. None may claim causal
identity or mutation authority from names/paths alone. Include a positive case
with real owner evidence so the feature does not merely refuse all conclusions.

### Measurement and release verification

Use fixed synthetic scenarios with isolated userData and real tool boundaries.
Freeze model/provider/reasoning, prompts, tool schemas and fixture expectations;
record commit IDs and environment. Run at least three independent fresh sessions
per live-model scenario before and after its relevant unit. Report the full
sample count and all outcomes; do not select only a successful retry. Scripted
providers test deterministic transport, not general model compliance.

Measure invalid-call repetitions, conflict repetitions without new observations,
unsupported success/causal claims, side-effect count, required reads, total tool
calls, elapsed time and tokens where available. Correct outcome and no duplicate
mutation outrank fewer calls. Do not set latency promises from this incident.

Deterministic contract/ownership/receipt tests must pass. Live acceptance must
show zero unsupported success or causal ownership claims in the stated corpus;
any violation needs an explained correction and a new complete reported run before
claiming acceptance. This is a release sample criterion, not a universal guarantee.
Purely diagnostic guidance may finish by reporting uncertainty rather than forcing
a speculative root cause. Add no generic runtime blocker to make the metric pass.

For each implementation PR run typecheck, relevant Core tests, docs check and
diff check; build and real-Electron/provider smoke where its runtime seam changes.
Add restart/replay verification for changed historical projections. Renderer and
visual verification apply only if the eventual amendment touches UI. Keep raw
session artifacts private under `tmp/`; publish sanitized acceptance in PRs, not
user transcripts or committed review reports. Preserve the original developer
session and its data throughout investigation.

### Existing plans and collision result

Baseline is current main `91b25605`; the planning check found no open PR claims.
This is a point-in-time collision result, not a reservation. The board is
main-owned and its future entry/ordering is an integration action, not a dev edit.

| Existing design | Treatment |
| --- | --- |
| [Image/service repair](agent-evidence-and-service-readiness.md), #675–677 | Shipped predecessor, not reopened. Preserve cwd-independent eligibility and immutable images. This plan addresses action-schema parity, recovery feedback and causal attribution beyond those repairs. |
| [Project defaults](composer-project-menu.md), #679 | Consume Project primary/application defaults and immutable admitted Task addresses; do not restore independent conversation folders or require Host/target projects to match. |
| [Scheduled work](scheduled-work-redesign.md) | No design rewrite. Scheduling retains assignment/run ownership and consumes final Task receipts. Coordinate overlapping Task/Thread projections; whichever lands later verifies the earlier consumer. No new unconditional dependency blocks scheduling. |
| [Targeted recovery](../targeted-thread-recovery.md) | No rewrite. Preserve canonical receipt/evidence closure and unknown-ownership rules. New projections must not become reconstructable originals or authorize deletion. |
| [Performance](../performance-optimization.md) | No rewrite. Recovery call counts measure this plan's correctness, not its Core/search optimization units. |
| [Settings working state](../semantic-working-state.md) | No rewrite. Its Settings-only visual work does not own tool outcomes or Task state. |
| [Computer Pilot](../computer-pilot-managed-skill.md) | No rewrite. Existing stable target/observation and verified-action semantics remain its authority; consume those as positive attribution examples, not a competing automation layer. |
| Memory/profile, Office preview, URL reader, toolbar and dark-mode plans | No changed design premise identified. They retain their owners and independent acceptance. |

No existing active plan needs an edit for this design. Update current specs in
each implementation PR; archived plans remain historical. If provider schema
constraints or lifecycle gaps force a changed contract, amend this plan and name
any affected consumer before implementation. Shared Core contracts require an
isolated coordinated interface change under repository rules if their actual
shape changes; such a PR must itself deliver complete usable contract behavior,
not inert groundwork. Do not edit `src/core/commands.ts`, `src/core/types.ts`,
build/dependency configuration or main-owned board/changelog for these units.

## Open questions

- Which supported provider adapters preserve the chosen action alternatives?
  Resolve with their actual transformed-schema fixtures inside Unit A. The
  decision is a tested representation, not a promise about undocumented support.
- Are existing process-observation facts sufficient for positive attribution in
  every selected fixture? Unit C must retain unknown when they are not; extending
  persistent identity is outside the ratified scope without an amendment.
- Exact single-instance refusal evidence is absent from the historical incident.
  A future isolated duplicate-launch reproduction can establish that fixture's
  cause; it cannot retroactively prove the original cause. This does not block
  the generic negative/positive attribution acceptance above.

## Implementation checklist

- [ ] Refresh claims, main contracts and per-unit call sites from on-disk searches.
- [ ] Capture the fixed baseline and ratify the unit's contract before coding.
- [ ] Ship A with provider-schema parity, bounded diagnostic repair and specs.
- [ ] Ship B with outcome-aware recovery, unchanged receipt replay and specs.
- [ ] Ship C with attributable observations, calibrated conclusions and specs.
- [ ] Publish complete deterministic/live acceptance and its limitations per PR.
- [ ] At integration, main updates the board/changelog and archives this design
      only after all three complete units are represented in current specs.
