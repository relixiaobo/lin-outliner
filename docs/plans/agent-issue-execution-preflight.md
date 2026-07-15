# Agent Issue Execution Preflight

## Goal

Make every active Issue definition honestly executable before Tenon claims that
it is enabled. Resolve symbolic node inputs and outputs into a concrete Session
plan, make `daily-note` output executable, enforce create-only output anchors at
the node-tool boundary, and turn preparation failures into visible Issue
failures instead of silently skipping scheduled work.

This is one complete feature in one PR. The implementation order is foundation
first, but the PR ships only when definition preflight, Session preparation,
runtime enforcement, observability, tests, and current specs all agree.

## Non-goals

- Implement saved-query execution.
- Invent an unattended confirmation UI for destructive replacement. Until a
  trusted confirmation channel exists, `replace-input` remains non-executable.
- Add a new Issue Manager panel or redesign existing Work views.
- Change cadence calculation, missed-window materialization, or the one-Issue
  per recurrence-window rule.
- Migrate or rewrite existing Issue definitions. Existing `daily-note`
  definitions become executable through preparation without changing their
  stored symbolic policy.

## Design

### One preparation contract

Add one main-process execution-preparation module shared by explicit Session
preview/start and scheduler-started Sessions. It receives the current Issue,
current document projection, execution timestamp, and request/preview mode, and
returns either:

- a prepared input snapshot, concrete output snapshot, node-access policy, and
  non-blocking warnings; or
- structured validation blockers that name the invalid selector or anchor.

The Store remains the revision authority. A prepared plan carries the Issue
revision used to build it, and `startSession` rechecks that revision inside its
existing atomic update before persisting the Session. Preparation is repeated at
every Session start; create/update checks are activation preflights, not durable
node snapshots.

Definition creation and patches that change an executable input/output contract
run the same non-mutating preflight before persistence. An active definition
cannot advertise unsupported `saved-query`, unresolved node anchors, or
`replace-input` without a trusted confirmation mechanism.

### Input resolution

- `selected-nodes`: every declared node is required. A missing or trashed member
  blocks preparation instead of being silently dropped.
- `node-children`: the root is required and must be active. Zero matching
  children is a valid empty result.
- `tag-query`: the tag definition is required and must be active. Matching stays
  dynamic per Session, so newly tagged nodes join later Sessions. Zero matches is
  valid but produces an explicit warning and zero-node preview.
- `none`: resolves to an explicit deny-all node input.
- `saved-query`: produces an unsupported-selector blocker until its resolver is
  implemented.
- Attached note nodes are required active read anchors. A dangling or trashed
  note blocks preparation.

Reference nodes remain physical node instances. Preparation does not silently
follow a reference into a target outside the declared scope. Output anchors that
are reference instances are rejected as ambiguous.

### Concrete outputs

The stored Issue keeps its symbolic output. The Agent Session persists the
prepared concrete output in `outputSnapshot`, and the objective displays that
concrete snapshot.

- `activity-only`: no node write capability.
- `daily-note`: choose the logical calendar date from the configured policy and
  time zone, idempotently ensure the date node in request mode, and lower the
  Session output to `create-child-under-node` for that concrete date node.
- `append-to-node` and `create-child-under-node`: require an active,
  non-reference parent that can contain ordinary children.
- `per-input-child`: validates the fixed parent and remains create-only there;
  per-input coverage stays an Issue criterion, not a broader mutation grant.
- `replace-input`: blocks preparation until an explicit trusted confirmation
  mechanism can be bound to the Session.

`session-date` uses the Session start instant in the Issue schedule's IANA zone,
falling back to the app's local IANA zone for unscheduled work. `due-date` uses
the Issue due date and its zone. A materialized Recurring Issue carries its
window start as `dueDate` and in its recurrence context, preserving the Recurring
Issue zone so catch-up runs resolve deterministically. Existing materialized
Issues without the derived `dueDate` fall back to their recurrence window.

Date-node creation may target a locked canonical day node: locking prevents
editing or moving the day page, but does not prevent creating a child beneath
it. Canonical date lookup must identify day-tagged date nodes, not reuse an
arbitrary same-title child.

### Operation-level node enforcement

Extend Run node resources with explicit create-parent ids. Existing
`writableNodes` continues to mean mutation of existing node subtrees;
create-parent ids mean that `node_create` may insert direct children only under
those exact parents.

Creation-style Issue outputs expose their anchor as readable, expose no mutable
existing subtree, and expose the anchor only as a create parent. `node_edit` and
`node_delete` therefore cannot modify the output root or its existing
descendants. A single `node_create` call may still create a complete outline
subtree with fields, tags, references, and nested content atomically.
Create-only Runs may reuse existing tag/field definitions and options, but an
outline that would create or extend Schema is rejected before node mutation
unless the Run independently has writable Schema authority. Top-level field
lines likewise require existing-node write authority for the output parent.

Run-scope normalization, narrowing, verifier projection, prompt formatting,
event-log restoration, and child-Issue scope authorization all preserve the new
resource dimension. Child Issues may narrow but never add a create parent that
the parent Session could not write beneath.

### Failure visibility and retry

A scheduler preparation failure records one error Agent Session for the concrete
Issue. This makes the Issue attention-needed, prevents a minute-by-minute retry
loop, preserves the failed recurrence window, and queues the ordinary terminal
delivery to the visible origin. The error names the selector or output anchor and
the required remediation.

Manual preview remains non-mutating. Manual request creates the same error
Session when preparation reached the execution boundary but could not produce a
valid plan. Definitions rejected during activation preflight are not persisted
as active work.

An existing materialized Issue with no Session remains eligible. Once
`daily-note` preparation ships, the scheduler can start that Issue on its next
sweep instead of creating a duplicate recurrence window.

### Files

- `src/core/agentEventLog.ts`
- `src/core/agentIssue.ts`
- `src/main/agentIssueExecutionPreparation.ts` (new)
- `src/main/agentIssueInputResolver.ts`
- `src/main/agentIssueRuntime.ts`
- `src/main/agentIssueScopeAuthorization.ts`
- `src/main/agentIssueSessionScope.ts`
- `src/main/agentIssueStore.ts`
- `src/main/agentNodeTools.ts`
- `src/main/agentDelegationRunPolicy.ts`
- `src/main/agentEventStore.ts`
- `src/main/agentRuntime.ts`
- focused core tests for preparation, Store/runtime scheduling, scope
  authorization, node tools, event restoration, and run-scope narrowing
- `docs/spec/agent-tool-design.md`
- `docs/spec/agent-delegation-runtime.md`

### Risks and collision result

The primary risk is widening a shared Run-scope protocol incorrectly. Guard it
with fail-closed normalization, child-scope narrowing tests, verifier stripping,
and node-tool mutation tests before wiring `daily-note` as a consumer.

The second risk is a document/Issue race while a date node is ensured. Serialize
date creation through the existing document command queue, then require the
Store's expected Issue revision before persisting the prepared Session. Node
tools revalidate the concrete parent against the current projection before every
write.

Open PR #396 also edits `src/main/agentRuntime.ts`; open PR #397 edits
`src/main/agentNodeTools.ts`, its tests, and `docs/spec/agent-tool-design.md`.
This branch starts from current `origin/main`; it must rebase after those PRs or
resolve their localized changes before becoming ready. No open claim overlaps
the new preparation module or Issue Store/Session scope files.

## Open questions

None for this delivery. Match-count requirements beyond the defined defaults and
a trusted `replace-input` confirmation flow are separate product decisions.

## Verification

- A daily Recurring Issue materializes, prepares a concrete day node, starts one
  Agent Session, and advances the next recurrence without duplicate output
  authority.
- A missing selected node, missing child root, trashed tag definition, dangling
  note, invalid fixed output, saved query, and replace-input each fail before an
  unrestricted Run can start.
- A zero-result active tag query yields an explicit deny-all input snapshot and
  warning without becoming unrestricted.
- Creation-style outputs can create direct children under the prepared parent
  but cannot edit/delete the parent, mutate existing descendants, or create
  beneath an existing descendant.
- Locked canonical day nodes accept child creation while remaining immutable.
- Preview performs no document mutation.
- Scheduler preparation failure creates one visible error Session and does not
  retry every minute.
- Typecheck, focused core tests, the full core suite, and `docs:check` pass.
