# Agent Issue Manager

## Goal

Define the lightest clean model for agent-managed work.

V1 uses one durable work object: Issue. Large work is represented by parent
Issues and sub-issues. Repeated work is represented by Recurring Issues that
create concrete Issues. Execution is represented by Agent Sessions. History and
progress are represented by Activity.

The V1 product model is:

```text
Issue -> sub-issues
Issue -> Trigger -> Agent Session -> Activity
Recurring Issue -> Issue
UI Views -> filters over Issues, Recurring Issues, Agent Sessions, and Activity
```

There must not be separate internal and external names for the same concept. If
the user sees an Agent Session, the protocol and code should also call it an
Agent Session, not an Attempt or Run. If the user sees Activity, the stored event
should also be Activity, not a hidden logbook entry. Legacy Run and command-node
terms can appear only when describing current implementation debt that this plan
retires.

The outliner remains a content surface: notes, nodes, tags, daily reports,
references, and user-authored structure. Issues may reference outliner content
as inputs, outputs, or supporting notes, but the outliner does not own work
state, recurrence, agent sessions, or activity history.

Build shape: **one complete feature in one PR** after PM ratification. This is a
protocol/runtime/product-surface replacement for the old scheduled-command
model, not a timeout patch.

## Purpose, Evidence, And Assumptions

This plan is the authoritative design proposal for the Agent Issue Manager until
it is ratified, implemented, and folded into `docs/spec/`.

Product direction:

- Keep the outliner clean as content management.
- Use Linear's clearest work concepts where they directly fit agent
  collaboration: Issues, parent/sub-issues, Activity-like history, and
  agent-facing execution.
- Do not add a first-class Project object in V1. It creates a hard model choice
  for agents and users, while parent Issues with sub-issues cover the current
  product need.
- Do not make Runs, command nodes, GTD tasks, or chat jobs the durable work
  object.
- Let agents manage Issues using the same concepts humans see.
- Keep the agent tool surface small. Good tools are high-level, structured,
  permission-aware, and composable; they are not one CRUD set per object.

Linear references used for the concept model:

- `https://linear.app/docs/conceptual-model`
- `https://linear.app/docs/creating-issues`
- `https://linear.app/docs/parent-and-sub-issues`
- `https://linear.app/developers/agents`
- `https://linear.app/developers/agent-interaction`

Current code reality:

- Command-node schedules and node watermarks exist today, but they are
  implementation debt.
- The current Runs surface lists execution records. It does not yet expose a
  first-class Issue, Recurring Issue, Agent Session, or Activity model.
- Some scheduled command executions can appear live indefinitely when delegated
  execution does not terminalize. The replacement model must make every Agent
  Session reach a visible terminal or waiting state.

Assumptions:

- V1 can replace the old scheduled-command mechanism without migration because
  the product is pre-release.
- One implicit local workspace is enough. It does not need a first-class V1 UI
  or tool surface.
- Parent Issues with sub-issues are enough for project-like outcomes in V1.
- Completion criteria can live on an Issue. They are useful for large outcomes
  without creating a separate Project ontology.
- Issue triggers can live on an Issue. They are the clean start mechanism for
  immediate, scheduled, and dependency-gated execution.
- Recurring Issues creating concrete Issues is acceptable when UI Views and
  grouping keep generated work readable.
- Linear Agent API details may change, but Agent Session and Activity are the
  right concepts to preserve.

## Non-goals

- No separate Task, WorkItem, Job, Attempt, Occurrence, Run, or Logbook ontology.
- No first-class Project object in V1.
- No full Linear clone: no V1 Teams, Initiatives, Cycles, Project Updates,
  Project Documents, custom workflows, or multi-user permissions.
- No GPT-style scheduled chat list.
- No command-node scheduled-routine redesign. Command nodes may later remain as
  manual prompt nodes or be retired, but they are not the source of truth for
  agent work.
- No workflow DSL, branch graph, or external cron service.
- No V1 labels, priorities, assignees, or public identifiers. These are useful
  in collaborative issue trackers, but they are not necessary for the current
  local agent-work model.
- No hidden unattended automation. Agents can draft or propose work, but
  unattended execution requires a confirmed Issue or Recurring Issue scope.
- No migration or back-compat reader for old command schedule watermarks.

## Objective, Constraints, And Options

- **OBJ-1:** Users can define immediate, scheduled, recurring, delegated, and
  project-like agent work using one work vocabulary, without polluting the
  outliner and without seeing forever-running executions.
- **Minimum acceptable outcome:** A user can create or confirm an Issue or
  Recurring Issue; split an Issue into sub-issues; delegate Issues to an agent;
  inspect Agent Sessions and Activity; and use UI Views to filter work without
  any separate Task/Project/Run/Logbook concept.
- **Clean-slate best answer:** Use a single Issue-based work model: Issue,
  Recurring Issue, Agent Session, and Activity. Treat hierarchy, triggers,
  completion criteria, due dates, input, output, and permissions as fields.
- **Selected target:** The clean-slate answer is also the brownfield target. The
  old command scheduled-routine implementation is replaced because preserving it
  keeps the wrong source-of-truth boundary.

### Constraints

- **CON-1 hard:** The same concept name must be used in UI, protocol, tools,
  storage projection names, and implementation-facing docs. No internal/external
  synonym pair may describe the same object.
- **CON-2 hard:** V1 must be materially lighter than Linear. Any concept that
  does not directly solve scheduling, delegation, hierarchy, execution, or
  activity audit is out of scope.
- **CON-3 hard:** A user must confirm unattended Issue or Recurring Issue
  execution before it can run on a schedule.
- **CON-4 hard:** Every Agent Session must reach `complete`, `error`,
  `awaitingInput`, `stale`, or `canceled`. Nothing may remain live forever.
- **CON-5 hard:** The outliner must remain a content surface. Work lifecycle,
  recurrence, session state, and activity history live in the Issue system.
- **CON-6 hard:** Agent-facing tools must be few enough for the model to choose
  correctly. Prefer fewer structured tools over many object-specific CRUD tools.
- **CON-7 legacy:** Current code has command-node schedules, watermarks, and Run
  records. These names are not target concepts.

### Options

- **OPT-1 issue-only target:** Keep Issue, Recurring Issue, Agent Session, and
  Activity as first-class concepts. Represent project-like outcomes as parent
  Issues with sub-issues and completion criteria. Selected.
- **OPT-2 light Linear subset with Projects:** Add a first-class Project object
  alongside Issues. Rejected because it forces agents to choose between Project,
  parent Issue, and ordinary Issue for many user requests.
- **OPT-3 full Linear clone:** Add Teams, Initiatives, Cycles, Project Updates,
  Project Documents, and separate tools for each object. Rejected as too heavy
  for a local outliner plus agent runtime.
- **OPT-4 run-list target:** Put scheduled and upcoming items into the existing
  Run list. Rejected because it centers execution records instead of work.
- **OPT-5 minimum patch:** Add deadlines to current scheduled Runs. Rejected
  because it fixes the symptom while preserving the wrong model.

### Revisit Triggers

- If users need roadmap/timeline planning that cannot be expressed as parent
  Issues with completion criteria, revisit a first-class Project object.
- If users need shared collaboration, revisit Teams, members, and permissions.
- If recurring generated Issues create too much list noise, solve it first with
  UI Views, grouping, and parent Recurring Issue context.

## Decision Summary

- **DEC-1:** V1 uses an issue-only work model, not the full Linear product
  model.
- **DEC-2:** Issue is the only durable work object. A leaf Issue is the atomic
  executable unit; a parent Issue can group sub-issues when work needs
  breakdown.
- **DEC-3:** Project-like outcomes are parent Issues with optional completion
  criteria, evidence, sub-issues, Activity, and Agent Sessions.
- **DEC-4:** Recurring Issue is the cadence/template for repeated work. Each due
  window creates a concrete Issue. There is no separate Occurrence object.
- **DEC-5:** Agent Session is the visible lifecycle object for agent execution
  or orchestration on an Issue. There is no separate Attempt or user-facing Run
  object.
- **DEC-6:** Activity is the audit and progress feed for Issues, Recurring
  Issues, and Agent Sessions. There is no separate Logbook object.
- **DEC-7:** Views are UI projections over canonical objects. Triage, Active,
  Scheduled, Completed, and Activity are presets, not stored object categories
  and not model-facing tools in V1.
- **DEC-8:** Hierarchy, relations, triggers, due dates, completion criteria,
  evidence, input scope, output policy, permission mode, and execution policy
  are fields on Issues or Recurring Issues, not independent V1 product objects.
- **DEC-9:** Dependencies use Issue relations, especially `blocked-by` and
  `blocks`. Readiness gates are derived from visible fields and relations; they
  are not hidden workflow nodes.
- **DEC-10:** Starting execution means the runtime creates an Agent Session
  either when an Issue trigger becomes ready or when an authorized
  `agent_session_start` request is accepted.
- **DEC-11:** The old execute -> signal -> feedback -> adjust loop is
  represented as Agent Session state, plan changes, and Activity entries.
- **DEC-12:** Dream is a system-owned Recurring Issue or Issue family using the
  same Issue, Agent Session, and Activity lifecycle, with protected fields and
  permissions.
- **DEC-13:** Agents can manage parent Issues by creating sub-issues, assigning
  delegates, setting sub-issue triggers, starting Agent Sessions on eligible
  sub-issues, summarizing progress, and linking evidence.
- **DEC-14:** Agent tools reuse the proven Run-control shape without preserving
  Run as a product concept: search/read/create/update durable Issues, then
  start, inspect, message, or stop runtime-owned Agent Sessions.
- **DEC-15:** Agent Session lifecycle is runtime-owned. Model-facing tools can
  request start, read status, send guidance, or request stop, but they cannot
  mark a Session complete/error/stale/canceled or append arbitrary Session
  records.
- **DEC-16:** Legacy Run and command-schedule names must not appear in new
  public contracts. They may remain only inside deletion/refactor notes until
  removed.
- **DEC-17:** Issue hierarchy is represented by parent/sub-issue fields on
  Issues, following Linear's model. Agent Sessions do not own hidden sub-run or
  sub-job trees.
- **DEC-18:** Immediate execution has two clean paths. New create-and-run work
  can be represented by a confirmed Issue with a ready trigger. Existing manual
  or unscheduled Issues can be run by `agent_session_start` without changing
  their durable trigger.
- **DEC-19:** Runtime owns Agent Session mechanics: validation, snapshots,
  worker lifecycle, deadlines, recovery, terminal state, and Activity emission.
  Worker agents own execution decisions and may request Issue changes, but the
  runtime does not invent hidden work breakdowns.
- **DEC-20:** Session completion and Issue completion are separate. A completed
  Agent Session can provide output or evidence, but the Issue becomes completed
  only through an allowed Issue status transition, completion rule, or verified
  completion policy.
- **DEC-21:** Agent Sessions are not rewound after terminal state. Awaiting
  Sessions can continue in place through a message; runtime can automatically
  recover interrupted non-terminal Sessions when a live checkpoint exists;
  failed, stale, canceled, or completed work continues by starting a new Agent
  Session linked to the previous one.
- **DEC-22:** Verification is an Issue-level completion policy. A verifier is a
  specialized Agent Session and records Activity; there is no model-facing
  verification CRUD tool.
- **DEC-23:** Confirmation is the shared execution authorization field for
  Issues and Recurring Issues. It is not encoded in status, trigger, cadence, or
  a Recurring-specific flag.
- **DEC-24:** Trigger controls execution start. Relation controls dependency
  gating. Due date controls deadline/display. Cadence controls repeated
  materialization. These four concerns must not be collapsed into one field or
  View rule.

## Product Model

### Canonical Terms

Use these terms consistently:

| Term | Product meaning | V1 role |
|---|---|---|
| Issue | Primary work item; leaf Issues are atomic execution units. | Primary work object. |
| Sub-issue | Normal Issue with a parent Issue. | Work breakdown below a parent Issue. |
| Recurring Issue | Cadence/template that creates concrete Issues. | Repeated work definition. |
| Trigger | Field that tells runtime when an Issue should create an Agent Session. | Start condition. |
| Agent Session | Agent execution lifecycle on an Issue. | Execution object visible to users. |
| Activity | Object history and session progress feed. | Audit, progress, comments, outputs. |
| View | Filter/order/group/display preset. | UI projection, not a durable V1 work object. |
| Relation | Field linking Issues. | Dependencies and related work. |
| Due date | Field on Issue. | Deadline/display target, not the start mechanism. |
| Cadence | Field on Recurring Issue. | Repeated materialization trigger. |
| Delegate | Agent assigned to act on an Issue. | Agent execution assignment. |
| Completion criteria | Field on parent or large Issues. | Outcome acceptance checklist. |
| Evidence | Field or Activity link proving criteria progress. | Completion support. |
| Verification policy | Field on Issue or Recurring Issue template. | Completion gate, not a separate tool. |

Do not reintroduce Task, WorkItem, Job, Attempt, Occurrence, Project, Run, or
Logbook as target concepts. Do not add Teams, Initiatives, Cycles, Project
Updates, Project Documents, or Milestones as first-class V1 objects. If needed,
they can later be promoted without changing the core Issue -> Trigger -> Agent
Session -> Activity lifecycle.

### Issue

An Issue is the primary unit of work that can be triaged, delegated, related,
scheduled, split into sub-issues, and completed. A leaf Issue is the atomic
execution unit. A parent Issue groups sub-issues when the work needs breakdown.

Suggested shape:

```ts
interface AgentIssue {
  id: string;
  title: string;
  description?: string;
  status: IssueStatus;
  delegate?: AgentRef;
  parentIssueId?: string;
  subIssueIds: string[];
  relations: IssueRelation[];
  trigger: IssueTrigger;
  dueDate?: IssueDueDate;
  recurrence?: IssueRecurrenceContext;
  completionCriteria?: IssueCompletionCriterion[];
  verificationPolicy?: IssueVerificationPolicy;
  evidence?: IssueEvidenceRef[];
  noteNodeIds?: string[];
  input?: IssueInputScope;
  output?: IssueOutputPolicy;
  permissionMode: 'attended' | 'unattended';
  executionPolicy?: AgentExecutionPolicy;
  confirmation: IssueConfirmation;
  createdAt: number;
  updatedAt: number;
  archivedAt?: number;
}

interface IssueStatus {
  id?: string;
  name: string;
  category:
    | 'triage'
    | 'backlog'
    | 'unstarted'
    | 'started'
    | 'completed'
    | 'canceled';
}

type IssueRelation =
  | { type: 'blocked-by'; issueId: string }
  | { type: 'blocks'; issueId: string }
  | { type: 'related'; issueId: string }
  | { type: 'duplicate-of'; issueId: string };

type IssueTrigger =
  | { type: 'manual' }
  | { type: 'when-ready' }
  | { type: 'scheduled'; startAt: number; timeZone: string };

interface IssueRecurrenceContext {
  recurringIssueId: string;
  windowStartAt: number;
  windowEndAt: number;
  materializedAt: number;
  skippedWindowCount?: number;
}

interface IssueCompletionCriterion {
  id: string;
  text: string;
  state: 'open' | 'met' | 'waived';
  evidence?: IssueEvidenceRef[];
}

interface IssueVerificationPolicy {
  mode: 'none' | 'criteria-and-evidence' | 'agent-review' | 'human-review';
  verifier?: AgentRef;
  requiredVerdict?: 'pass' | 'pass-or-partial';
  requiredEvidence?: string[];
}

type IssueEvidenceRef =
  | { type: 'issue'; issueId: string }
  | { type: 'agent-session'; agentSessionId: string }
  | { type: 'activity'; activityId: string }
  | { type: 'node'; nodeId: string }
  | { type: 'file'; path: string }
  | { type: 'url'; url: string; label?: string };

type IssueConfirmation =
  | { state: 'draft' }
  | { state: 'confirmed'; confirmedBy: ActorRef; confirmedAt: number };
```

Required behavior:

- Draft Issues can be created by a human or an agent.
- If no trigger is specified, the Issue defaults to `manual`.
- `manual` Issues do not create Agent Sessions automatically.
- `when-ready` Issues create an Agent Session when they are confirmed,
  delegated, unblocked, in an executable status, and have no active Session for
  the same trigger revision.
- `scheduled` Issues create an Agent Session at or after `startAt` when the
  same readiness rules pass.
- Unattended delegated Issues require confirmation before their triggers become
  active. If the user action that creates the Issue explicitly authorizes
  execution, no second confirmation is required.
- Editing an Issue affects future Agent Sessions only. Existing Agent Sessions
  keep their Issue snapshot through Activity.
- A blocked Issue can remain visible without creating an Agent Session.
- A sub-issue is a normal Issue with `parentIssueId`; it can have its own
  delegate, status, trigger, due date, input/output scope, Activity, and Agent
  Sessions.
- Parent Issue status is not automatically completed when all sub-issues are
  complete unless an explicit rule or user/agent action changes it.
- A verification policy gates Issue completion. It may be satisfied by criteria
  and evidence alone, by a verifier Agent Session, or by human review.
- Cycles are invalid: an Issue cannot become its own parent, descendant, or
  duplicate parent path.
- If a large Issue becomes too broad for parent/sub-issue hierarchy, a future
  feature may promote it into a richer object, but V1 does not need that object.

### Recurring Issue

A Recurring Issue is the durable cadence/template for repeated work. It creates
concrete Issues according to its cadence.

Suggested shape:

```ts
interface AgentRecurringIssue {
  id: string;
  titleTemplate: string;
  descriptionTemplate?: string;
  status: 'active' | 'paused' | 'archived';
  cadence: RecurringIssueCadence;
  timeZone: string;
  missedPolicy: RecurringIssueMissedPolicy;
  issueTemplate: RecurringIssueTemplate;
  confirmation: IssueConfirmation;
  createdAt: number;
  updatedAt: number;
}

type RecurringIssueCadence =
  | { type: 'daily'; time: string }
  | { type: 'weekly'; weekdays: number[]; time: string }
  | { type: 'monthly'; dayOfMonth: number; time: string };

type RecurringIssueMissedPolicy =
  | { type: 'coalesce-latest' }
  | { type: 'skip-missed' };

interface RecurringIssueTemplate {
  delegate?: AgentRef;
  parentIssueId?: string;
  relations?: IssueRelation[];
  trigger?: IssueTrigger;
  completionCriteria?: IssueCompletionCriterion[];
  verificationPolicy?: IssueVerificationPolicy;
  input?: IssueInputScope;
  output?: IssueOutputPolicy;
  permissionMode: 'attended' | 'unattended';
  executionPolicy?: AgentExecutionPolicy;
}
```

For "summarize news every day at 08:00", the durable object is a Recurring
Issue. Each due day materializes a concrete Issue such as "Summarize news -
2026-07-07", records recurrence window metadata on that concrete Issue,
delegates it to the selected agent, and gives it a ready trigger when allowed.
Runtime creates the Agent Session from that trigger. Completed daily work is a
completed Issue with Activity, not a hidden occurrence and not a long-lived Run.

If the app was not running for several due windows, `coalesce-latest` creates
one latest Issue whose `recurrence` field records the covered window and skipped
window count. It does not create many stale Issues unless the user explicitly
chooses that future policy.

Recurring Issue behavior:

- Draft Recurring Issues can be created by a human or an agent.
- A Recurring Issue materializes concrete Issues only when it is `active` and
  `confirmed`.
- Confirmation authorizes the cadence and the template scope. Runtime still
  validates generated concrete Issues before starting Agent Sessions.
- A generated concrete Issue inherits the template fields and receives
  recurrence context. It does not create or reference a hidden Occurrence.
- Single scheduled work is an ordinary Issue with a `scheduled` trigger, not a
  Recurring Issue.
- V1 cadence is calendar-based: daily, weekly, and monthly. Workday schedules,
  every-N-hour schedules, and richer calendar rules are future cadence types,
  not new product objects.

### Agent Session

An Agent Session tracks one agent execution or orchestration lifecycle on an
Issue. It is the execution object. There is no separate Attempt or user-facing
Run object.

Suggested shape:

```ts
interface AgentSession {
  id: string;
  issueId: string;
  delegate: AgentRef;
  state:
    | 'pending'
    | 'active'
    | 'error'
    | 'awaitingInput'
    | 'complete'
    | 'stale'
    | 'canceled';
  source:
    | { type: 'delegation'; actor: ActorRef }
    | { type: 'recurring-issue'; recurringIssueId: string; dueAt: number }
    | { type: 'orchestration'; coordinatorAgentSessionId: string }
    | { type: 'manual'; actor: ActorRef };
  issueSnapshot: AgentIssue;
  inputSnapshot?: ResolvedIssueInput;
  outputSnapshot?: IssueOutputPolicy;
  executionPolicy?: AgentExecutionPolicy;
  continuationOfAgentSessionId?: string;
  plan: AgentSessionPlanItem[];
  startedAt?: number;
  completedAt?: number;
  createdAt: number;
  updatedAt: number;
}

interface AgentSessionPlanItem {
  content: string;
  status: 'pending' | 'inProgress' | 'completed' | 'canceled';
}

interface AgentExecutionPolicy {
  deadlineAt: number;
  retryPolicy: 'none' | 'manual' | 'bounded';
  maxAutomaticRetries?: number;
}
```

Session rules:

- Runtime creates a Session before agent execution begins when an Issue trigger
  is ready.
- A Session can be created only for an Issue.
- A leaf Issue Session may execute the Issue directly.
- A parent Issue Session may orchestrate the parent Issue by creating,
  updating, assigning, or setting triggers on sub-issues.
- Child work is represented by normal sub-issues, their Agent Sessions, and
  Activity, not hidden sub-runs.
- A Session must not outlive its execution policy without becoming `error` or
  `stale`.
- A Session that needs user input becomes `awaitingInput`, not running.
- A Session that splits work into sub-issues records those Issue links in
  Activity and then reaches a terminal state. The parent Issue, not the Session,
  carries ongoing work state.
- A Session that finishes successfully becomes `complete`.
- A Session that fails emits error Activity and becomes `error`.
- A Session stopped by user or policy emits stop Activity and becomes
  `canceled`.
- A Session in `awaitingInput` continues in place when the missing answer or
  guidance arrives through `agent_session_send_message`.
- Runtime may automatically recover an interrupted `pending` or `active`
  Session in place only when the executor checkpoint is still valid.
- A restored `pending` or `active` Session with no live executor or valid
  checkpoint becomes `stale` or `error` according to recovery policy.
- A Session in `complete`, `error`, `stale`, or `canceled` is immutable as an
  execution record. Continuing that work creates a new Agent Session on the same
  Issue and links it with `continuationOfAgentSessionId`.
- A parent or coordinator agent chooses the semantic continuation intent:
  continue from prior context, retry the same objective, revise part of the
  prior result, or start unrelated work. Runtime chooses record identity. The
  agent cannot force a terminal Agent Session to become active again.
- Continuing prior work should reuse the same Issue, prior Activity, prior
  evidence, and a linked Agent Session context, not the same terminal Agent
  Session identity.

### Activity

Activity is the single history and progress feed. It covers Issue history,
Recurring Issue history, and Agent Session progress.

Suggested shape:

```ts
type ActivityTarget =
  | { type: 'issue'; issueId: string }
  | { type: 'recurring-issue'; recurringIssueId: string }
  | { type: 'agent-session'; agentSessionId: string };

type ActivityContent =
  | { type: 'comment'; body: string }
  | { type: 'field-change'; field: string; from?: unknown; to?: unknown }
  | { type: 'status-change'; from?: string; to: string }
  | { type: 'agent-progress'; body: string }
  | { type: 'agent-question'; body: string }
  | { type: 'agent-action'; action: string; parameter?: string; result?: string }
  | { type: 'agent-response'; body: string }
  | { type: 'agent-error'; body: string }
  | {
      type: 'verification-result';
      verdict: 'pass' | 'fail' | 'partial';
      body: string;
      agentSessionId?: string;
    }
  | { type: 'output-link'; nodeId?: string; url?: string; label: string };

interface Activity {
  id: string;
  target: ActivityTarget;
  actor: ActorRef;
  content: ActivityContent;
  signals?: ActivitySignal[];
  relatedTargets?: RelatedTargetRef[];
  createdAt: number;
}
```

The former execute -> signal -> feedback -> adjust loop maps to Agent Session
and Activity:

- execute: `agent-action` activities and plan items;
- signal: activity `signals` metadata, tool results, verifier evidence,
  execution-policy state, missing inputs, and external state;
- feedback: `agent-progress`, `agent-action.result`, `agent-error`, or plan
  updates explaining interpretation;
- adjust: updated plan plus subsequent `agent-action` activities;
- terminalize: `agent-response` plus `complete`, `agent-error` plus `error`,
  `agent-question` plus `awaitingInput`, or stop Activity plus `canceled`.

No hidden controller Run should be used as the user's work object. If the
implementation needs orchestration, it must still emit Agent Session and
Activity as the canonical persisted contract.

Activity must not store raw model reasoning. Agent progress entries are concise
user-visible summaries of meaningful execution state, decisions, blockers, or
results.

### Verification Model

Verification is an Issue completion rule, not a separate model-facing tool. The
agent does not call `issue_verify`, `verification_create`, or any other special
verification CRUD surface. It updates the Issue definition with
`verificationPolicy`, links evidence with `issue_update`, and starts or waits for
Agent Sessions through the normal Agent Session tools.

The policy modes are:

- `none`: completion is allowed by an authorized status transition.
- `criteria-and-evidence`: completion requires every completion criterion to be
  `met` or `waived`, with required evidence present.
- `agent-review`: completion requires a verifier Agent Session on the same Issue
  or parent Issue, using `verificationPolicy.verifier`, and a recorded
  `verification-result` Activity.
- `human-review`: completion requires an explicit human status transition or
  confirmation Activity.

This mirrors the useful part of `cc-2.1`'s verification agent: verification is a
specialized agent role launched through the same Agent tool chain, not a separate
tool family. Tenon keeps the result at the Issue layer. A verifier Agent Session
can produce `pass`, `fail`, or `partial`; the Issue becomes completed only when
the policy accepts the verdict and required evidence is linked. A failed or
partial verifier Session leaves the Issue visible as started or
attention-needed, with the verifier output recorded in Activity.

### Input Scope

Input scope is an Issue field that tells the agent which content may be read
when an Agent Session is created.

```ts
type IssueInputScope =
  | { type: 'none' }
  | { type: 'selected-nodes'; nodeIds: string[] }
  | { type: 'node-children'; nodeId: string; depth?: number }
  | { type: 'tag-query'; tag: string; includeArchived?: boolean }
  | { type: 'saved-query'; queryId: string };
```

Examples:

- "Handle this node" -> `selected-nodes`.
- "Handle all children under this outline" -> `node-children`.
- "Process every node tagged #invoice" -> `tag-query`.

### Output Policy

Output policy is an Issue field that tells the agent where results may be
written.

```ts
type IssueOutputPolicy =
  | { type: 'activity-only' }
  | { type: 'daily-note'; datePolicy: 'session-date' | 'due-date' }
  | { type: 'append-to-node'; nodeId: string }
  | { type: 'create-child-under-node'; nodeId: string }
  | { type: 'per-input-child'; parentNodeId: string }
  | { type: 'replace-input'; requiresConfirmation: true };
```

Default output should be `activity-only` unless the user or confirmed Issue
scope names a write target.

## Views

Views are UI filter projections over the same underlying objects. They are not
model-facing types.

Recommended V1 presets:

- **Triage:** draft or unconfirmed Issues and Recurring Issues.
- **Active:** unstarted, started, blocked, or attention-needed Issues.
- **Scheduled:** Issues with `scheduled` triggers and Recurring Issues with a
  next materialization time.
- **Completed:** completed and canceled Issues.
- **Activity:** Issue, Recurring Issue, and Agent Session Activity.

Due dates can appear in Active or Scheduled rows as deadline metadata, but a due
date alone does not put an Issue in Scheduled and does not start execution.

Users may later create custom Views named Today, Upcoming, or Backlog, but those
names are View presets, not ontology.

## User Flows

### FLOW-1: Agent Creates A Daily Recurring Issue

- **Entry path:** User says, "Create a recurring issue: summarize news every day
  at 08:00."
- **Entry state:** No matching Recurring Issue exists.
- **Mainline:**
  1. Agent creates a Recurring Issue draft with cadence, delegate, input,
     output, and permission mode.
  2. The draft appears in Triage.
  3. User reviews and confirms unattended execution.
  4. At the next due time, the Recurring Issue creates a concrete Issue.
  5. The generated Issue receives a ready trigger if its confirmation and
     dependency rules allow it.
  6. Runtime creates an Agent Session from the ready Issue trigger.
  7. Agent Session emits Activity and reaches `complete`, `error`,
     `awaitingInput`, `stale`, or `canceled`.
- **Result:** Each due window is represented by a concrete Issue and Agent
  Session. No long-running Session represents future days.

### FLOW-2: Agent Manages A Large Outcome Issue

- **Entry path:** User says, "Prepare the July release and break it into issues."
- **Entry state:** No matching Issue exists.
- **Mainline:**
  1. Agent creates a parent Issue with description, completion criteria,
     delegate, and optional target due date.
  2. Agent creates sub-issues under the parent Issue as the plan for satisfying
     those criteria.
  3. User confirms the parent Issue and any unattended delegated sub-issues.
  4. Agent gives executable sub-issues ready or scheduled triggers where
     permission allows.
  5. Runtime starts Sessions for sub-issues whose triggers become ready.
  6. Agent updates sub-issues, links evidence, marks criteria met or waived, or
     summarizes parent Issue progress.
- **Result:** Large outcomes use the same Issue concepts. Parent Issue
  completion is judged against its completion criteria, not by sub-issue count
  alone.

### FLOW-3: Issue Waits On Another Issue

- **Entry path:** User says, "Only summarize the news after the collection issue
  is complete."
- **Entry state:** Summary Issue or Recurring Issue exists.
- **Mainline:**
  1. Agent adds or proposes a `blocked-by` relation.
  2. View shows the blocked Issue as blocked, not running.
  3. No Agent Session is created while the blocker is incomplete.
  4. When the upstream Issue completes, the downstream Issue trigger becomes
     eligible if all other rules pass.
  5. Runtime creates the downstream Agent Session from that ready trigger.
- **Result:** Dependencies remain visible Issue relations, not hidden start
  conditions or workflow nodes.

### FLOW-4: Agent Session Needs More Permission

- **Entry path:** Agent Session is active and needs content outside the Issue
  input/output scope.
- **Mainline:**
  1. Agent emits `agent-question` or `agent-error` Activity.
  2. Agent Session becomes `awaitingInput` or `error`.
  3. Agent proposes an Issue change if broader scope is needed.
  4. User confirms or rejects the change.
- **Result:** The Session does not silently broaden scope and does not stay
  running forever.

### FLOW-5: Dream Uses The Same Model

- **Entry path:** Dream schedule is due.
- **Entry state:** System-owned Recurring Issue or Issue family is configured by
  Dream settings.
- **Mainline:**
  1. Dream creates a concrete system-owned Issue for the due window.
  2. Dream assigns a protected delegate, permissions, and ready trigger.
  3. Runtime creates an Agent Session from the ready trigger.
  4. Dream emits Activity and terminal state.
  5. Dream output links to memory or dream nodes.
- **Result:** Dream shares Issue, Recurring Issue, Agent Session, Activity,
  deadlines, and recovery semantics, while keeping protected edit rules.

### FLOW-6: Main Agent Offloads Long Work

- **Actor:** Main agent acting in the current user conversation.
- **Entry path:** The main agent decides the user-requested work is long enough
  to run outside the current conversation.
- **Entry state:** A current user action authorizes delegation and immediate
  execution, or the agent can only create a draft/proposal for later
  confirmation.
- **Goal:** Keep the current conversation usable while a separate Agent Session
  executes the work and reports back through Issue Activity.
- **Mainline:**
  1. Main agent calls `issue_create` for new work or `issue_update` for an
     existing Issue, defining objective, delegate, trigger, input scope, output
     policy, completion criteria, permission mode, and execution policy.
  2. If new work should immediately run and the current user action authorizes
     it, the Issue can be created confirmed with
     `trigger: { type: 'when-ready' }`.
  3. If an existing manual or unscheduled Issue should run now, main agent calls
     `agent_session_start`. This starts one Agent Session without changing the
     Issue's durable trigger.
  4. If immediate execution is not authorized, the Issue remains draft, manual,
     scheduled, blocked, or waiting for confirmation. No Session is created.
  5. Runtime validates the Issue revision, confirmation, trigger or start
     request, permission, blockers, scope, and execution policy; snapshots the
     Issue; creates the Agent Session; and starts the worker.
  6. The worker agent either executes the Issue directly or uses `issue_create`
     or `issue_update` to create visible sub-issues under the parent Issue.
  7. The worker agent can give sub-issues ready/scheduled triggers or call
     `agent_session_start` on sub-issues only when the parent Issue's confirmed
     scope and orchestration policy allow it.
  8. Runtime records Session progress, Issue changes, child Session links,
     outputs, questions, errors, and terminal state as Activity.
  9. Completion criteria, evidence, and any verifier policy are checked before
     the Issue is moved to completed. A successful Session alone is not enough.
  10. The main agent receives a notification or calls `agent_session_read` /
     `issue_read` when it needs to summarize the result to the user.
- **Decision points:** trigger now vs save/schedule for later; execute directly
  vs create sub-issues; mark Issue complete vs leave it
  started/attention-needed.
- **Validation:** User action or confirmation must authorize unattended
  execution; blockers must be clear; child Issue triggers or direct starts must
  stay within the parent Issue scope; destructive output must be confirmed.
- **Result state:** The current conversation is not occupied by long execution;
  work is visible as an Issue with Agent Sessions and Activity.
- **Failure/recovery:** If validation fails, no Session is created and the Issue
  records or returns the blocking reason. If the worker fails, the Session
  becomes `error`, `awaitingInput`, `stale`, or `canceled`, and retry creates a
  new Session on the same Issue.
- **Requirements:** FR-4, FR-6, FR-9, FR-10, FR-11, FR-19.

## Agent Operating Model

The agent should experience the system as a small set of intent choices, not as
an object graph it must manually orchestrate. Every user request should first be
classified into one of these decisions:

1. **Find existing work:** use `issue_search`, then `issue_read` before
   mutating anything.
2. **Define new work:** use `issue_create`.
3. **Change durable work definition:** use `issue_update`.
4. **Run existing work once now:** use `agent_session_start`.
5. **Observe execution:** use `agent_session_read` or `issue_read` with session
   context.
6. **Guide an active or waiting execution:** use `agent_session_send_message`.
7. **Stop execution:** use `agent_session_stop`.
8. **Verify completion:** use `issue_read`, optionally `agent_session_start` for
   an `agent-review` verifier, then `issue_update` to link evidence or transition
   status when the policy is satisfied.

The first question is whether the user is changing durable work or controlling
one execution:

| User intent | Durable object action | Runtime action |
|---|---|---|
| "Create this work" | `issue_create` | None unless trigger becomes ready. |
| "Do this every day / later / after X" | `issue_create` or `issue_update` with trigger, recurrence, or relation fields. | Runtime starts when ready. |
| "Run this existing issue now" | None unless fields must change first. | `agent_session_start`. |
| "Retry / continue that failed execution" | Usually none. | `agent_session_start` with `continuation`. |
| "Answer the agent's question" | None unless scope changes. | `agent_session_send_message`. |
| "Change what this should do" | `issue_update`. | Existing Sessions keep their snapshot. |
| "Stop what is running" | None. | `agent_session_stop`. |
| "Can this be marked done?" | `issue_read`, then `issue_update` if criteria and verification policy are satisfied. | Optional verifier `agent_session_start`. |

The second question is whether the agent has enough authority:

- A current user action can authorize immediate creation, update, or Session
  start when the user explicitly asked for it.
- Unattended triggers, destructive output, broader input scope, and direct
  starts outside current user intent return `needs-confirmation`.
- A worker Agent Session can create or update sub-issues and start child
  Sessions only inside the confirmed parent Issue scope and orchestration
  policy.
- If the request is ambiguous between a durable schedule and a one-off run, the
  agent should prefer the narrower one-off run and ask or propose before
  changing durable triggers.

The third question is what context to load:

- Before creating work, search for likely duplicates by title, target nodes,
  tags, and recurring cadence.
- Before updating work, read the Issue with `definition`, `criteria`,
  `sessions`, and `activity` when relevant.
- Before starting work, read the Issue if the current conversation does not
  already contain its latest revision, delegate, trigger, scope, and blockers.
- Before continuing a Session, read the Agent Session to classify it as
  `awaitingInput`, `pending`, `active`, `complete`, `error`, `stale`, or
  `canceled`.

### Agent Tool Decision Rules

| Tool | Use when | Do not use when |
|---|---|---|
| `issue_search` | The agent needs to find existing Issues or Recurring Issues, avoid duplicates, or list work by field-derived state. | The target object is already known and only needs details. |
| `issue_read` | The agent needs Issue definition, progress, criteria, linked notes, sub-issues, generated Issues, sessions, or Activity context. | The agent only needs to inspect one Agent Session. |
| `issue_create` | The user asks for new durable work, a new recurring routine, or a new sub-issue. | The user refers to an existing Issue. |
| `issue_update` | The user changes title, scope, delegate, trigger, recurrence, relations, status, criteria, output, or permissions of existing work. | The user only wants a one-off execution now. |
| `agent_session_start` | The user wants an existing Issue executed now, retried, continued after terminal state, or delegated as child execution. | The user is setting a future schedule or recurrence. |
| `agent_session_read` | The agent needs runtime state, latest output, blocking question, or high-signal execution Activity. | The agent needs durable Issue definition or trigger details. |
| `agent_session_send_message` | The user answers a question, adds guidance, or unblocks an `awaitingInput` Session. | The message changes durable Issue scope, permissions, or output policy. |
| `agent_session_stop` | The user or policy wants to cancel one running or pending Agent Session. | The user wants to archive, cancel, or pause the durable Issue or Recurring Issue. |

### Real Usage Scenario Matrix

| Scenario | User phrase | Agent interpretation | Primary tools | Runtime result |
|---|---|---|---|---|
| SCN-1 recurring report | "Create a scheduled routine: write a daily report every day at 18:00." | New Recurring Issue with daily cadence, delegate, input/output policy, and unattended permission. | `issue_search`, `issue_create` | Recurring Issue materializes concrete Issues; runtime starts Sessions when due and authorized. |
| SCN-2 capture for later | "Add an issue for this, but don't start it yet." | New manual Issue, usually draft or unstarted, no automatic execution. | `issue_create` | No Agent Session is created. |
| SCN-3 create and run now | "Research this in the background now." | New confirmed Issue with ready trigger, or create Issue then direct start if the user wants an explicit one-off run. | `issue_create`, optional `agent_session_start` | Runtime creates one Agent Session and current conversation can continue. |
| SCN-4 run existing work | "Start this issue now." | Existing Issue should execute once without changing durable trigger. | `issue_read`, `agent_session_start` | New Agent Session starts from the Issue snapshot. |
| SCN-5 schedule existing work | "Do this tomorrow morning." | Existing Issue needs durable scheduled trigger. | `issue_read`, `issue_update` | Runtime starts when the scheduled trigger becomes ready. |
| SCN-6 dependency-gated work | "Only summarize after the collection issue is done." | Add `blocked-by` relation and keep or set a ready trigger. | `issue_search`, `issue_update` | Runtime starts only after blockers clear and readiness rules pass. |
| SCN-7 process tagged nodes | "Process all nodes tagged #invoice." | New Issue with `tag-query` input scope and explicit output policy. | `issue_create` | Runtime resolves tagged nodes at Session start and fails closed outside scope. |
| SCN-8 large outcome breakdown | "Prepare the July release and split it up." | Parent Issue with completion criteria; sub-issues carry executable work. | `issue_create`, `issue_update`, optional `agent_session_start` | Parent progress is derived from sub-issues, evidence, Activity, and criteria. |
| SCN-9 answer blocked Session | "The answer is yes, use the selected nodes." | Existing Agent Session is waiting for input or permission clarification. | `agent_session_read`, `agent_session_send_message`, optional `issue_update` | `awaitingInput` Session continues in place, or scope change needs confirmation. |
| SCN-10 retry failed work | "Try that failed execution again." | Same Issue should get a new Agent Session, linked to the failed one. | `agent_session_read`, `agent_session_start` | New continuation Session is created with structured `continuation` intent and an Activity link to the previous Session. |
| SCN-11 restore or continue | "Continue that session." | State-based handling: answer waiting Session in place; continue terminal/stale work with a linked new Session. | `agent_session_read`, then `agent_session_send_message` or `agent_session_start` | No terminal Session is rewound. |
| SCN-12 inspect result | "What happened with the report?" | User wants durable progress and latest execution output. | `issue_read`, `agent_session_read` | Agent summarizes Activity, output links, errors, or blockers. |
| SCN-13 stop execution | "Stop that running work." | Cancel one Agent Session, not the durable Issue. | `agent_session_read`, `agent_session_stop` | Runtime records stop Activity and moves Session to `canceled`. |
| SCN-14 pause routine | "Pause the daily news summary." | Recurring Issue should stop generating future concrete Issues. | `issue_search`, `issue_update` | No future due Sessions start while paused. |
| SCN-15 edit definition while running | "Actually include the competitor list too." | If it changes durable scope, update the Issue for future Sessions; optionally message current Session if allowed. | `issue_read`, `issue_update`, optional `agent_session_send_message` | Current Session keeps its snapshot unless explicitly guided within permission scope. |
| SCN-16 verify completion | "Can we mark the release prep done?" | Read parent Issue, evaluate criteria/evidence, start verifier Session if policy requires it, then transition only when allowed. | `issue_read`, optional `agent_session_start`, `issue_update` | Completion is recorded as Issue status plus Activity, not inferred from one successful Session. |

These scenarios are normative for tool choice. If a future tool is proposed, it
must make at least one scenario simpler without making another scenario more
ambiguous.

## Requirements

- **FR-1:** The product must use Issue, Recurring Issue, Agent Session, and
  Activity as the canonical first-class concepts. Views are UI projections over
  those concepts.
- **FR-2:** Hierarchy, relations, triggers, due dates, completion criteria,
  verification policy, evidence, input, output, permissions, and execution
  policy must be fields, not separate V1 objects.
- **FR-3:** No target protocol, tool, or spec section may introduce Task,
  WorkItem, Job, Attempt, Occurrence, Project, Run, or Logbook as product
  objects.
- **FR-4:** Agents can create and update Issue drafts.
- **FR-5:** Agents can create and update Recurring Issue drafts.
- **FR-6:** Agents can create, update, assign, and reorder sub-issues under a
  parent Issue.
- **FR-7:** Agents can add, remove, update, and evaluate completion criteria and
  verification policy on Issues.
- **FR-8:** A confirmed Recurring Issue can create concrete Issues on a cadence.
- **FR-9:** Runtime can create an Agent Session only when a concrete Issue has a
  ready trigger or an accepted `agent_session_start` request, and user action,
  confirmed automation, or orchestration policy authorizes it.
- **FR-10:** Every Agent Session must reach `complete`, `error`,
  `awaitingInput`, `stale`, or `canceled`; it must not remain live forever.
- **FR-11:** Agent Sessions must emit Activity for visible progress, actions,
  questions, responses, and errors.
- **FR-12:** Issue relations must support blocked-by dependency behavior without
  hidden workflow nodes.
- **FR-13:** Views must be implemented as UI projections over canonical objects,
  not as model-facing object types.
- **FR-14:** Activity must be queryable without loading full session
  transcripts.
- **FR-15:** Input selectors can target selected nodes, children, or tags while
  keeping work state outside the outliner.
- **FR-16:** Output policy can write to Activity, daily notes, chosen nodes,
  per-input child nodes, or explicitly confirmed in-place edits.
- **FR-17:** Missed recurring work defaults to coalescing into the latest
  concrete Issue with coverage metadata.
- **FR-18:** System-owned Dream work uses the same canonical lifecycle with
  protected ownership and permissions.
- **FR-19:** The agent-facing tool surface must stay small and complete:
  Issue discovery, Issue inspection, Issue creation, Issue update, Session
  start, Session read, Session messaging, and Session stop. It must not expose
  one CRUD family for every object, field, or sub-object.
- **FR-20:** Old command-node schedule fields and watermark commands must not
  drive new scheduled behavior.
- **FR-21:** Users and agents can continue interrupted work without mutating
  terminal Agent Session history: non-terminal recovery happens in place only
  when valid, and terminal continuation creates a linked new Agent Session.
- **FR-22:** The agent-facing tools must support the normative scenario matrix:
  capture, create-and-run, schedule, dependency-gate, process scoped content,
  split work, start existing work, inspect progress, answer waiting Sessions,
  retry, continue, stop, pause recurring work, and verify completion.
- **FR-23:** Issue completion can be gated by criteria-and-evidence,
  agent-review, or human-review verification policy without adding separate
  model-facing verification tools.
- **FR-24:** Every agent-facing tool must provide a short description, search
  hint, prompt guidance, input field descriptions, and output field descriptions
  following the same schema-first discipline as `cc-2.1` tools.
- **FR-25:** Confirmation, trigger, relation, due date, cadence, and recurrence
  provenance must remain separate fields with separate behavior.
- **FR-26:** Activity must be able to target Issues, Recurring Issues, and Agent
  Sessions, and must store user-visible progress rather than raw model
  reasoning.

## Business Rules

- **BR-1:** Draft unattended work cannot create Agent Sessions until confirmed.
- **BR-2:** A Recurring Issue creates concrete Issues; it does not create hidden
  occurrences.
- **BR-3:** An Issue may have many Agent Sessions over time, such as initial
  execution, orchestration passes, and retries.
- **BR-4:** Retrying failed work creates a new Agent Session on the same Issue
  through `agent_session_start`, or re-arms the Issue trigger when the durable
  schedule should run again.
- **BR-5:** A failed Session remains Activity history and is not mutated into a
  successful Session.
- **BR-6:** A blocked Issue trigger cannot create an Agent Session until
  blockers are complete or the relation is changed.
- **BR-7:** A parent Issue can have Agent Sessions. Those Sessions are for
  execution or orchestration, not automatic parent Issue completion.
- **BR-8:** Parent Issue progress is evaluated against completion criteria using
  sub-issue status, Activity, and linked evidence. Completing all sub-issues
  does not automatically complete the parent Issue unless an explicit rule or
  user/agent action changes it.
- **BR-9:** Agent Session execution-policy and permission snapshots are fixed
  when the Session is created.
- **BR-10:** An unattended Agent Session fails closed when the requested read or
  write is outside its confirmed Issue scope.
- **BR-11:** A restored active Session with no live executor becomes `stale` or
  `error`; it does not remain active indefinitely.
- **BR-12:** Activity feeds summarize important events and link to detailed
  session Activity; they do not duplicate every transcript token.
- **BR-13:** View membership is derived from object fields and Activity, not
  manually stored as object state or exposed as a model-facing object.
- **BR-14:** A tool that changes execution permissions, recurrence, destructive
  output, execution triggers, or direct Session start must carry a current user
  action, an allowed orchestration source, or create a proposal.
- **BR-15:** Completion-criteria updates are Activity or field changes, not a
  separate update object in V1.
- **BR-16:** A sub-issue is a normal Issue with its own delegate, status, due
  date, Activity, permission snapshot, and Agent Sessions.
- **BR-17:** Issue hierarchy cannot contain cycles. An Issue cannot be its own
  parent, ancestor, or descendant.
- **BR-18:** Agent Sessions do not form a durable parent/child execution tree.
  If a Session creates sub-issues, sets triggers on them, or starts Sessions on
  them, those relationships are recorded as Activity on the relevant Issues.
- **BR-19:** The runtime, not the calling model, owns Agent Session state
  transitions and Activity recording. A model-facing tool can request start,
  read status, send guidance, or request stop, but cannot directly set terminal
  state or append Activity.
- **BR-20:** Creating or updating an Issue can include its trigger. A UI or
  agent may present "create and start" as one user action by recording a
  confirmed Issue with a ready trigger. Running an existing manual Issue now
  uses `agent_session_start` and does not change the Issue trigger.
- **BR-21:** Runtime can validate, dispatch, monitor, recover, stop, and
  terminalize Agent Sessions. It must not create hidden sub-work as a product
  decision; worker-driven decomposition must be expressed as normal sub-issues.
- **BR-22:** A worker agent that needs to split work uses `issue_create` or
  `issue_update` to create visible sub-issues. Giving those sub-issues ready or
  scheduled triggers, or starting Sessions on them, requires an allowed
  orchestration source and permission scope.
- **BR-23:** A Session reaching `complete` does not automatically complete its
  Issue. The Issue reaches completed only through an allowed Issue status
  transition, completion rule, or verified completion policy.
- **BR-24:** `awaitingInput` is resumable in place by
  `agent_session_send_message`. `complete`, `error`, `stale`, and `canceled`
  Sessions are immutable execution records and cannot be moved back to
  `active`.
- **BR-25:** Continuing terminal or stale work uses `agent_session_start` on the
  same Issue with a structured `continuation` request; runtime creates a new
  Agent Session and records the continuation relationship as Activity.
- **BR-26:** Runtime recovery after app restart may keep the same Session only
  when a valid executor checkpoint exists. Without a valid checkpoint, the
  Session becomes `stale`, `error`, or `canceled`, and further work requires a
  new linked Session.
- **BR-27:** `agent-review` verification starts or waits on a normal Agent
  Session with a verifier delegate. The verifier output is stored as Activity and
  linked evidence; it is not a hidden approval record.
- **BR-28:** A Session reaching `complete` and a verifier returning `pass` are
  evidence for Issue completion, not the same thing as Issue completion. The
  Issue still needs an allowed status transition or completion rule.
- **BR-29:** A Recurring Issue can materialize concrete Issues only when it is
  both `active` and confirmed. Paused, archived, or draft Recurring Issues do
  not materialize work.
- **BR-30:** Runtime, not the model, writes confirmation metadata. Models can
  request create, update, or confirm operations, but they cannot forge
  `confirmedBy` or `confirmedAt`.
- **BR-31:** Dependency readiness is derived from Issue relations. It must not be
  encoded as a trigger type.
- **BR-32:** Due dates never start execution by themselves. Execution starts from
  an Issue trigger or an authorized `agent_session_start` request.

## Agent Tool Surface

The tool surface must optimize for the agent's call-time decision. The agent
should not need to choose between Project and Issue, because V1 has no Project
object. It should choose between create and update because that intent is known
before the call. It should not need to choose between `draft`, `propose`, and
`apply` tools before it knows whether the action is allowed. The tool should
validate the request, apply it when permission allows, or return a confirmation
proposal when it does not.

V1 should reuse the current Run-tool ergonomics where they remain useful while
replacing the concept names. Tool names must use a consistent concept-prefix
shape: `concept_action`. The prefix makes the target object obvious before
the model inspects the schema; the action makes the intent obvious after the
target is chosen. The old Run tools split execution control into start, status,
soft message, hard amendment, and stop. The Issue model keeps direct start for
existing Issues while also supporting trigger-derived start:

- `issue_create` creates new normal or recurring Issues;
- `issue_update` replaces hard amendment for objective, criteria, scope,
  delegate, recurrence, hierarchy, trigger, and execution-policy changes;
- `agent_session_start`, `agent_session_read`, `agent_session_send_message`,
  and `agent_session_stop` replace the start/inspect/steer/stop
  runtime-control parts of the old Run tools;
- no model-facing tool replaces `agent_session_record`, because runtime owns
  Session records, state transitions, and Activity emission.

V1 exposes eight model-facing tools:

```text
issue_search
issue_read
issue_create
issue_update
agent_session_start
agent_session_read
agent_session_send_message
agent_session_stop
```

`issue_search`, `issue_read`, `issue_create`, and `issue_update` are the
durable Issue definition surface. `agent_session_start`,
`agent_session_read`, `agent_session_send_message`, and `agent_session_stop`
are the runtime execution surface. Neither group creates a hidden `Work`,
`WorkItem`, `Task`, `Project`, or `Run` object.

This eight-tool surface covers the complete agent capability loop:

1. discover existing Issues and Recurring Issues;
2. inspect the selected Issue with enough context to avoid duplicate work;
3. create a new Issue or Recurring Issue;
4. update an existing Issue or Recurring Issue, including its trigger;
5. let runtime create Agent Sessions when Issue triggers become ready;
6. start an Agent Session directly for an eligible existing Issue;
7. read or briefly wait on runtime state when needed;
8. send soft guidance or user answers to an active Session;
9. request stop when the user or policy requires it.

The main-agent long-work path has two explicit modes:

- New create-and-run work uses `issue_create` with a ready trigger when the
  current user action authorizes immediate execution.
- Existing manual or unscheduled work uses `agent_session_start` for one
  execution, or `issue_update` to set a durable trigger for future execution.

Naming rules:

- Use concept-prefix names: `issue_*` for Issue and Recurring Issue operations,
  and `agent_session_*` for one execution's runtime controls.
- Split create and update when the agent can know the intent before the call.
  Creation and editing have different required fields, validation, conflict
  behavior, and confirmation copy.
- Use full concept names for Agent Sessions. Do not shorten the prefix to
  `session_*`, because plain session can mean chat, login, or runtime transport.
- A tool named `issue` has Issue or Recurring Issue as its primary target.
  Agent Sessions and Activity can appear only as included context or returned
  targets.
- Do not use generic `work_*`, `task_*`, `project_*`, or `run_*` tool names in
  the target surface.

### Tool Architecture Reference

The `cc-2.1` reference project is useful for implementation architecture and
agent runtime behavior, not for product naming. It defines tools through a
common schema-first contract: each tool has a stable name, Zod input schema,
optional output schema, description, prompt text, permission/read-only/
destructive classifiers, validation, execution, and UI/result rendering hooks. A
`buildTool` helper fills safe defaults so every registered tool has a complete
runtime shape.

V1 should reuse that architecture pattern:

- define every Issue and Agent Session tool from a single typed schema source;
- keep model-facing schema, validation, permission gating, execution, and UI
  rendering as separate concerns;
- mark read-only and destructive behavior on the tool contract so policy can
  reason before execution;
- let runtime own Agent Session state transitions, terminalization,
  notifications, and Activity creation;
- support remote or deferred tool surfaces through stubs that preserve name,
  schema, and permission behavior without coupling model prompts to local
  implementation details.

The right `cc-2.1` comparison set is the AgentTool chain:

```text
AgentTool
  -> LocalAgentTask / RemoteAgentTask
  -> runAgent
  -> sidechain transcript / output file
  -> task-notification
  -> SendMessage / TaskStop / resumeAgentBackground
  -> verification agent
```

V1 should not copy `cc-2.1`'s product-level tool names:

- `AgentTool` is the useful launch abstraction, but it carries the legacy wire
  alias `Task`. Tenon should expose `agent_session_start`, not `Task` or
  `Agent`, because the product object is an Agent Session.
- `TaskCreate`, `TaskUpdate`, `TaskList`, and `TaskGet` are session checklist
  tools. They are not the durable work model Tenon needs.
- `TaskOutput` is already treated as deprecated in `cc-2.1`; the preferred path
  is output references plus completion notifications. Tenon should use
  `agent_session_read` only for bounded inspection, not as the main polling
  loop.
- `TaskStop` remains a valid runtime-control pattern. Tenon maps that behavior
  to `agent_session_stop`.
- `CronCreate` is a scheduled prompt tool. Tenon maps recurrence into Recurring
  Issues and concrete Issues, not cron tools.
- `SendMessage` is the right continuation pattern. Tenon maps it to
  `agent_session_send_message` for active or waiting Sessions, and to
  `agent_session_start` with `continuation` when terminal work must continue as a
  linked new Session.

The most important behavior to absorb is lifecycle separation. In `cc-2.1`, an
agent launch registers a background runtime task, returns an output reference,
and later delivers a completion notification; the calling model does not set the
runtime task's final state directly. Tenon should apply the same boundary:
`issue_create` or `agent_session_start` can request work, but the runtime
creates, monitors, recovers, stops, and completes Agent Sessions and records
Activity.

`cc-2.1`'s AgentDefinition layer is also a useful reference. Agent types declare
when to use them, allowed/disallowed tools, permission mode, background behavior,
isolation, MCP servers, skills, hooks, and model preferences. Tenon should keep
the same separation: Issue fields choose the delegate and policy; runtime
assembles the worker's tool pool and execution context; the model-facing Issue
tools do not expose low-level worker construction details.

Verification follows the same rule. `cc-2.1` has a specialized verification
agent launched through `AgentTool`, plus prompt-time nudges that require a
verifier before reporting non-trivial work as complete. Tenon should make that
less ad hoc: `verificationPolicy` is an Issue field, the verifier is an Agent
Session, and the verdict is Activity/evidence. No separate verification tool is
needed.

### Agent Tool Contract

Every model-facing work-management tool should be implemented through one
shared schema-first contract, inspired by `cc-2.1`'s `Tool` / `buildTool`
pattern but reduced to Tenon's domain needs:

```ts
interface TenonAgentToolDefinition {
  name: string;
  kind: 'read' | 'mutation' | 'runtime-control';
  searchHint: string;
  description(
    input: unknown,
    context: TenonAgentToolDescriptionContext
  ): string;
  promptGuidance(context: TenonAgentToolPromptContext): string;
  inputSchema: unknown;
  outputSchema: unknown;
  isReadOnly(input: unknown): boolean;
  isDestructive(input: unknown): boolean;
  requiresCurrentUserAction(input: unknown): boolean;
  validate(input: unknown, context: TenonAgentToolContext): ValidationResult;
  execute(input: unknown, context: TenonAgentToolContext): unknown;
}

interface TenonAgentToolContext {
  actor: ActorRef;
  currentUserActionId?: string;
  coordinatorAgentSessionId?: string;
  permissionMode: AgentPermissionMode;
  now: number;
}

interface TenonAgentToolDescriptionContext {
  actor: ActorRef;
  permissionMode: AgentPermissionMode;
  isNonInteractiveSession: boolean;
}

interface TenonAgentToolPromptContext {
  actor: ActorRef;
  permissionMode: AgentPermissionMode;
  availableDelegates: AgentRef[];
}
```

This contract is an implementation boundary, not an extra model-facing object.
It keeps the concerns separate:

- schema descriptions and prompt examples tell the model how to call the tool;
- validation rejects impossible or stale requests before mutation;
- permission gating decides whether to apply, preview, or return
  `needs-confirmation`;
- execution changes Issue state or requests Agent Session runtime action;
- rendering/UI code decides how to show the result;
- runtime emits Activity and terminal Agent Session state.

The eight tools should carry these classifications:

| Tool | Kind | Read-only | Destructive | Description | Search hint |
|---|---|---:|---:|---|---|
| `issue_search` | `read` | yes | no | Search Issues and Recurring Issues by durable fields, derived execution state, and Activity state. | `find durable agent work` |
| `issue_read` | `read` | yes | no | Read one Issue or Recurring Issue with requested context. | `inspect issue details` |
| `issue_create` | `mutation` | no | no by default | Create a normal Issue or Recurring Issue, or return a confirmation proposal. | `create durable agent work` |
| `issue_update` | `mutation` | no | depends on change | Update an existing Issue or Recurring Issue, including lifecycle, hierarchy, trigger, criteria, verification, and recurrence. | `change durable agent work` |
| `agent_session_start` | `runtime-control` | no | no by default | Request one Agent Session execution or orchestration pass for an eligible Issue. | `start issue execution` |
| `agent_session_read` | `read` | yes | no | Read bounded status, latest output, or blocking question for one Agent Session. | `inspect agent execution` |
| `agent_session_send_message` | `runtime-control` | no | no by default | Send guidance or an answer into an active or waiting Agent Session. | `message running agent` |
| `agent_session_stop` | `runtime-control` | no | yes | Request cancellation of one pending or active Agent Session. | `stop agent execution` |

The tool surface intentionally does not include:

- `agent_session_list`: find running or failed work with `issue_search`
  filters such as `hasActiveSession`, `needsAttention`, and `sessionState`,
  then read the Issue or Session;
- `agent_session_resume`: use `agent_session_send_message` for
  `awaitingInput`, or `agent_session_start` with `continuation` for terminal or
  stale work;
- `activity_record` or `agent_session_record`: runtime emits Activity;
- `verification_*` or `issue_verify`: verification is an Issue policy that
  starts or waits on normal Agent Sessions;
- `cron_*`: recurrence is part of Recurring Issue and Issue trigger fields;
- `task_*`, `run_*`, `job_*`, or `project_*`: they are not product concepts in
  this architecture.

All mutation and runtime-control tools must require a `reason`. This is not
user-facing prose; it is an audit and debugging summary for Activity,
confirmation copy, and model self-correction.

### Tool Description And Schema Text

Tenon should adopt `cc-2.1`'s schema discipline:

- `description(input, context)` is the short capability sentence shown with the
  callable tool. It may vary by permission context, but it should stay brief.
- `searchHint` is a stable 3-10 word phrase for deferred tool search. It should
  use words that help retrieval and not merely repeat the tool name.
- `promptGuidance(context)` is the longer tool prompt. It explains when to use
  the tool, when not to use it, permission behavior, examples, and handoff
  rules. Dynamic lists, such as available delegate agents, belong here or in a
  separate runtime attachment so cache churn stays controlled.
- `inputSchema` and `outputSchema` must describe every visible field. In a Zod
  implementation this means every top-level field, nested object field, union
  discriminator, and output field has `.describe(...)`; in a JSON Schema
  implementation each property has `description`.
- Parameter descriptions are product contract text, not comments. They should
  say what the agent should provide, when to omit the field, what default
  runtime behavior follows from omission, and what permission or conflict rule
  applies.
- New V1 tools should not include deprecated aliases or compatibility
  parameters. If a later rename requires compatibility, aliases and deprecated
  parameters must be explicitly described the same way `cc-2.1` describes
  `TaskStop.shell_id`.

The longer prompt guidance should carry these usage boundaries:

| Tool | Prompt guidance focus |
|---|---|
| `issue_search` | Use for discovery, lists, dashboards, and locating work by state. Do not use UI view names as filters. |
| `issue_read` | Use before changing a known Issue when current revision, Activity, sub-issues, or Sessions matter. |
| `issue_create` | Use when the durable definition does not exist yet. Use `preview` for ambiguous or permission-sensitive creation. |
| `issue_update` | Use for durable definition, lifecycle, hierarchy, schedule, criteria, verification, or recurrence changes. Do not use it for soft execution guidance. |
| `agent_session_start` | Use only to request execution of an existing eligible Issue. Do not mutate the Issue trigger or silently bypass blockers. |
| `agent_session_read` | Use for bounded inspection or a short wait. Do not poll by default; rely on runtime notifications and Activity projections. |
| `agent_session_send_message` | Use for guidance or answers inside an existing Session. Use `issue_update` when the durable Issue definition changes. |
| `agent_session_stop` | Use only to cancel a pending or active Session; stopping execution does not archive or delete the Issue. |

### Current Tool Shape

Current model-facing tools are organized around content, local resources, and
legacy execution control:

- outliner content tools: `node_search`, `node_read`, `node_create`,
  `node_edit`, `node_delete`, `operation_history`;
- local tools: `file_read`, `file_glob`, `file_grep`, `file_edit`,
  `file_write`, `bash`, `task_stop`;
- web tools: `web_search`, `web_fetch`;
- conversation/context tools: `past_chats`, `ask_user_question`, `skill`;
- legacy execution tools: `spawn_run`, `run_status`, `run_steer`, `run_amend`,
  `run_stop`.

The current scheduled command path includes `set_command_schedule`,
`mark_command_attempted`, `mark_command_fired`, `agent_run_command_now`, and
`agent_ensure_command_conversation`. These are legacy implementation concepts,
not target tools.

### Common Result Shape

Mutation and runtime-control tools return the same permission-aware result
shape:

```ts
interface TenonAgentToolResult {
  status:
    | 'preview'
    | 'applied'
    | 'needs-confirmation'
    | 'blocked'
    | 'conflict';
  targets: RelatedTargetRef[];
  revisions?: ObjectRevision[];
  validation?: ValidationMessage[];
  warnings?: ValidationMessage[];
  permissionBlock?: PermissionBlock;
  confirmation?: ConfirmationProposal;
}

interface ObjectRevision {
  target: RelatedTargetRef;
  revision: string;
}

type RelatedTargetRef =
  | { type: 'issue'; id: string }
  | { type: 'recurring-issue'; id: string }
  | { type: 'agent-session'; id: string }
  | { type: 'activity'; id: string };

type ChangeRequest =
  | { mode: 'preview' }
  | { mode: 'request'; userActionId?: string };
```

`preview` never persists. `request` persists only what is allowed by the current
permission context. If user confirmation is required, the tool returns
`needs-confirmation` with a structured `confirmation` object instead of letting
the agent invent an unsafe follow-up.

Common parameter descriptions:

| Parameter | Required | Description |
|---|---:|---|
| `request` | mutation/runtime-control only | Whether the caller wants a non-persistent preview or an actual request. Use `preview` when validating a proposal, estimating scope, or asking for confirmation copy. Use `request` only when a current user action or allowed orchestration source authorizes persistence. |
| `reason` | mutation/runtime-control only | Short audit summary of why the change or execution request is being made. It is stored with Activity and used for permission prompts and debugging. |
| `expectedRevision` | no | Revision last observed by the agent. Include it when updating an object previously read in this turn so stale writes return `conflict` instead of overwriting newer state. |
| `expectedIssueRevision` | no | Revision of the Issue snapshot the agent expects to execute. Include it when starting execution from a prior `issue_read`. |
| `include` | no | Explicit list of optional context slices to return. Omit heavy slices unless needed; use summaries before full Activity or transcript-like detail. |
| `limit` | no | Maximum number of rows to return. Runtime applies a bounded default and maximum if omitted or too large. |
| `cursor` | no | Pagination cursor returned by a previous search response. Omit on the first page. |

Common result field descriptions:

| Field | Description |
|---|---|
| `status` | Outcome of the tool call: preview only, applied, confirmation needed, blocked by validation or permission, or conflict with newer state. |
| `targets` | Durable or runtime objects affected or previewed by the call. |
| `revisions` | New revisions for changed objects, used for safe follow-up updates. |
| `validation` | Field-level or rule-level validation messages that prevent the requested operation. |
| `warnings` | Non-blocking issues the agent should surface or account for before continuing. |
| `permissionBlock` | Structured reason the operation cannot proceed under current permissions. |
| `confirmation` | Structured proposal the UI can show when user confirmation is required. |

### Search And Read Issues

`issue_search` is for discovery and list building. It searches Issues and
Recurring Issues by fields, trigger readiness, session-derived state, and
activity-derived state, not by UI View names.

```ts
type IssueSearchTarget =
  | 'issue'
  | 'recurring-issue';

interface IssueSearchInput {
  targets?: IssueSearchTarget[];
  text?: string;
  filter?: IssueSearchFilter;
  include?: IssueSearchInclude[];
  orderBy?: IssueSearchOrder[];
  limit?: number;
  cursor?: string;
}

interface IssueSearchFilter {
  ids?: string[];
  statusCategories?: string[];
  delegateIds?: string[];
  issueIds?: string[];
  recurringIssueIds?: string[];
  parentIssueIds?: string[];
  hasSubIssues?: boolean;
  triggerTypes?: IssueTrigger['type'][];
  dueDate?: TimeRangeFilter;
  cadence?: RecurringCadenceType[];
  nextMaterializationAt?: TimeRangeFilter;
  relation?: {
    type: 'blocked-by' | 'blocks' | 'related' | 'duplicate-of';
    issueId?: string;
  };
  confirmed?: boolean;
  archived?: boolean;
  hasActiveSession?: boolean;
  needsAttention?: boolean;
  inputNodeIds?: string[];
  inputTags?: string[];
  sessionState?: AgentSession['state'][];
  activityTypes?: ActivityContent['type'][];
  activityTarget?: ActivityTarget;
  createdAt?: TimeRangeFilter;
  updatedAt?: TimeRangeFilter;
}

type IssueSearchInclude =
  | 'activity-summary'
  | 'session-summary'
  | 'sub-issues-summary'
  | 'criteria-summary'
  | 'input-preview'
  | 'output-preview'
  | 'next-generated-issue';
```

`issue_search` parameter descriptions:

| Parameter | Description |
|---|---|
| `targets` | Object types to search. Omit to search both Issues and Recurring Issues when the user did not specify a type. |
| `text` | Full-text query against title, description, Activity summaries, and relevant output previews. Use structured filters for exact state, date, tag, delegate, or hierarchy queries. |
| `filter` | Structured predicates over durable fields, trigger readiness, session-derived state, and Activity-derived state. Combine filters when the user asks for a precise list. |
| `include` | Summary slices to return with each row. Prefer summaries over full reads; follow up with `issue_read` for one selected object. |
| `orderBy` | Stable sort definition. Omit when default relevance or system ordering is acceptable. |
| `limit` | Maximum number of rows to return. Use small limits for selection and larger limits only for explicit audit/reporting requests. |
| `cursor` | Pagination cursor from the previous search page. |

`IssueSearchFilter` field descriptions:

| Field | Description |
|---|---|
| `ids` | Exact object IDs when the caller already has durable references. |
| `statusCategories` | Canonical lifecycle and derived buckets such as triage, backlog, unstarted, started, blocked, completed, canceled, archived, or attention-needed. This replaces view-name filtering. |
| `delegateIds` | Assigned human or agent delegates. Use when the user asks what a specific agent or person owns. |
| `issueIds` | Exact Issue IDs. Use only when searching concrete Issues. |
| `recurringIssueIds` | Exact Recurring Issue IDs. Use only when searching recurrence definitions. |
| `parentIssueIds` | Parent Issues whose sub-issues should be listed. |
| `hasSubIssues` | Whether the Issue has visible child Issues. |
| `triggerTypes` | Issue trigger types: manual, when-ready, or scheduled. Dependencies use `relation`; generated recurring work uses `recurrence`. |
| `dueDate` | Time range over user-facing due dates. This is not the same as execution trigger time. |
| `cadence` | Recurring Issue cadence types for recurrence searches. |
| `nextMaterializationAt` | Time range for a Recurring Issue's next due materialization. Use this for Scheduled views over recurring work. |
| `relation` | Relationship query for blocked-by, blocks, related, or duplicate-of links. |
| `confirmed` | Whether the Issue or Recurring Issue is confirmed for execution. |
| `archived` | Whether archived objects should be included or excluded. |
| `hasActiveSession` | Whether a pending or active Agent Session currently exists. |
| `needsAttention` | Whether user input, failed verification, failed execution, or a blocked dependency needs attention. |
| `inputNodeIds` | Issues whose input scope includes specific outliner nodes. |
| `inputTags` | Issues whose input scope targets nodes by tag query. |
| `sessionState` | Agent Session states projected onto Issues for execution-status searches. |
| `activityTypes` | Activity content types, such as field-change, status-change, agent-progress, agent-action, agent-error, output-link, or verification-result. |
| `activityTarget` | Activity target object when searching by history around a specific Issue, Recurring Issue, Session, or node. |
| `createdAt` | Creation-time range. |
| `updatedAt` | Last durable update-time range. |

`issue_read` loads one Issue or Recurring Issue plus requested context.

```ts
interface IssueReadInput {
  target: IssueTargetRef;
  include?: IssueReadInclude[];
}

type IssueTargetRef =
  | { type: 'issue'; id: string }
  | { type: 'recurring-issue'; id: string };

type IssueReadInclude =
  | 'definition'
  | 'activity'
  | 'sessions'
  | 'sub-issues'
  | 'criteria'
  | 'progress'
  | 'generated-issues'
  | 'linked-notes'
  | 'input-preview'
  | 'output-preview'
  | 'session-plan';
```

`issue_read` parameter descriptions:

| Parameter | Description |
|---|---|
| `target` | Durable object to read: an Issue or a Recurring Issue. The caller must provide the canonical type and ID. |
| `include` | Context slices to load with the definition. Omit for the lightweight definition; include Activity, Sessions, sub-issues, generated Issues, linked notes, previews, or session plan only when needed for the next decision. |

`IssueReadInclude` value descriptions:

| Value | Description |
|---|---|
| `definition` | Durable fields and current revision. |
| `activity` | Activity feed entries, bounded by runtime defaults. |
| `sessions` | Agent Session summaries and terminal states linked to the object. |
| `sub-issues` | Direct child Issues. |
| `criteria` | Completion criteria and verification policy detail. |
| `progress` | Derived progress summary for dashboards and quick status answers. |
| `generated-issues` | Concrete Issues produced by a Recurring Issue. |
| `linked-notes` | Outliner nodes linked as notes, inputs, or outputs. |
| `input-preview` | Bounded preview of selected node/tag/query inputs. |
| `output-preview` | Bounded preview of latest durable outputs. |
| `session-plan` | Runtime-prepared execution plan or next-step projection when available. |

### Create And Update Issues

`issue_create` creates one normal Issue or Recurring Issue. It has no target
because the target does not exist yet. The tool handles preview, draft
creation, confirmation requirements, permission blocks, and duplicate warnings.

```ts
type IssueCreateInput =
  | {
      issueType: 'issue';
      fields: IssueDraftFields;
      request: ChangeRequest;
      reason: string;
    }
  | {
      issueType: 'recurring-issue';
      fields: RecurringIssueDraftFields;
      request: ChangeRequest;
      reason: string;
    };
```

`issue_update` changes one existing normal Issue or Recurring Issue. It always
has a target and should carry `expectedRevision` when the agent is acting on
previously read state. The tool handles patches, lifecycle actions, revision
conflicts, confirmation requirements, and permission blocks.

```ts
type IssueUpdateInput =
  | {
      target: {
        type: 'issue';
        id: string;
        expectedRevision?: string;
      };
      change: IssueUpdateChange;
      request: ChangeRequest;
      reason: string;
    }
  | {
      target: {
        type: 'recurring-issue';
        id: string;
        expectedRevision?: string;
      };
      change: RecurringIssueUpdateChange;
      request: ChangeRequest;
      reason: string;
    };

type IssueUpdateChange =
  | { type: 'patch'; patch: IssuePatchFields }
  | { type: 'transition'; status: IssueStatus }
  | { type: 'confirm' }
  | { type: 'archive' }
  | { type: 'delete' };

type RecurringIssueUpdateChange =
  | { type: 'patch'; patch: RecurringIssuePatchFields }
  | { type: 'confirm' }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'skip-next' }
  | { type: 'archive' }
  | { type: 'delete' };
```

The field shapes are:

```ts
interface IssueDraftFields {
  title: string;
  description?: string;
  delegate?: AgentRef;
  parentIssueId?: string;
  relations?: IssueRelation[];
  trigger?: IssueTrigger;
  dueDate?: IssueDueDate;
  completionCriteria?: IssueCompletionCriterion[];
  verificationPolicy?: IssueVerificationPolicy;
  evidence?: IssueEvidenceRef[];
  noteNodeIds?: string[];
  input?: IssueInputScope;
  output?: IssueOutputPolicy;
  permissionMode?: 'attended' | 'unattended';
  executionPolicy?: AgentExecutionPolicy;
}

interface RecurringIssueDraftFields {
  titleTemplate: string;
  descriptionTemplate?: string;
  cadence: RecurringIssueCadence;
  timeZone: string;
  missedPolicy?: RecurringIssueMissedPolicy;
  issueTemplate: RecurringIssueTemplate;
}

interface IssuePatchFields {
  title?: string;
  description?: string;
  status?: IssueStatus;
  delegate?: AgentRef;
  parentIssueId?: string;
  relations?: IssueRelation[];
  trigger?: IssueTrigger;
  dueDate?: IssueDueDate;
  completionCriteria?: IssueCompletionCriterion[];
  verificationPolicy?: IssueVerificationPolicy;
  evidence?: IssueEvidenceRef[];
  noteNodeIds?: string[];
  input?: IssueInputScope;
  output?: IssueOutputPolicy;
  permissionMode?: 'attended' | 'unattended';
  executionPolicy?: AgentExecutionPolicy;
}

interface RecurringIssuePatchFields {
  titleTemplate?: string;
  descriptionTemplate?: string;
  status?: 'active' | 'paused' | 'archived';
  cadence?: RecurringIssueCadence;
  timeZone?: string;
  missedPolicy?: RecurringIssueMissedPolicy;
  issueTemplate?: RecurringIssueTemplate;
}
```

`issue_create` parameter descriptions:

| Parameter | Description |
|---|---|
| `issueType` | Object type to create. Use `issue` for one concrete unit of work and `recurring-issue` for a reusable schedule that materializes concrete Issues. |
| `fields` | Durable definition fields for the new object. Required fields depend on `issueType`. |
| `request` | Preview or request mode. Use preview for ambiguous natural-language requests, risky triggers, broad input scopes, or missing confirmation. |
| `reason` | Short audit summary explaining why this object is being created. |

Agents do not set `confirmation.confirmedBy` or `confirmation.confirmedAt`
inside create fields. Runtime sets confirmation when the current user action or
an allowed orchestration source authorizes it; otherwise the created object
remains draft or the tool returns `needs-confirmation`.

`issue_update` parameter descriptions:

| Parameter | Description |
|---|---|
| `target` | Existing Issue or Recurring Issue to change, including optional expected revision for conflict protection. |
| `change` | Patch, lifecycle transition, confirmation, pause/resume, skip-next, archive, or delete operation. Use one explicit change per call. |
| `request` | Preview or request mode. Destructive changes, execution-enabling trigger changes, and permission changes may return `needs-confirmation`. |
| `reason` | Short audit summary explaining why the object is being changed. |

`IssueUpdateChange` descriptions:

| Change | Description |
|---|---|
| `patch` | Update durable fields without implying a lifecycle transition unless the patch explicitly includes status. |
| `transition` | Move a concrete Issue to a new lifecycle status. Runtime validates allowed transitions and completion rules. |
| `confirm` | Mark a draft or proposed Issue as confirmed so eligible triggers can execute. |
| `archive` | Hide completed or no-longer-needed work from active surfaces while preserving history. |
| `delete` | Remove a mistaken object before it becomes meaningful history; requires stronger confirmation than archive. |
| `pause` | Stop a Recurring Issue from materializing future Issues without deleting history. |
| `resume` | Reactivate a paused Recurring Issue for future materialization. |
| `skip-next` | Skip only the next scheduled materialization for a Recurring Issue. |

`IssueDraftFields` and `IssuePatchFields` descriptions:

| Field | Description |
|---|---|
| `title` | Human-readable Issue name. It should be specific enough to identify the desired outcome in lists and Activity. |
| `description` | Durable goal, context, constraints, and acceptance guidance. Use this for the stable definition, not transient execution chat. |
| `status` | Current lifecycle state. Patch only when a direct status edit is intended; otherwise use a transition change. |
| `delegate` | Human or agent expected to own execution. Omit when unassigned or when the runtime should use the default agent policy. |
| `parentIssueId` | Parent Issue for visible decomposition. Use sub-issues for meaningful work breakdown, not hidden runtime steps. |
| `relations` | Cross-links such as blocked-by, blocks, related, or duplicate-of. Use dependencies here rather than encoding them in prose only. |
| `trigger` | Execution trigger for the concrete Issue: manual, when-ready, or scheduled. Dependencies belong in `relations`; recurring provenance belongs in `recurrence`. |
| `dueDate` | User-facing deadline or target date. It does not by itself start execution. |
| `completionCriteria` | Observable conditions for deciding whether the Issue is complete. |
| `verificationPolicy` | Completion gate describing whether evidence, an agent review, or a human review is required before completion. |
| `evidence` | Links to Issues, Agent Sessions, Activity, nodes, files, or URLs that support completion. |
| `noteNodeIds` | Outliner notes attached as durable context or references. |
| `input` | Scope of source material to process, such as selected nodes, a node query, a tag query, or an external resource reference. |
| `output` | Where durable results should be written and how broad output changes may be. |
| `permissionMode` | Whether execution is attended or unattended. Use unattended only when the user or parent Issue has granted that capability. |
| `executionPolicy` | Limits and rules for Agent Session execution, such as retries, deadlines, allowed tools, or required isolation. |

`RecurringIssueDraftFields` and `RecurringIssuePatchFields` descriptions:

| Field | Description |
|---|---|
| `titleTemplate` | Template for generated concrete Issue titles. It should produce readable Issue names for each generated window. |
| `descriptionTemplate` | Template for generated Issue descriptions. Include stable instructions and variable date/window context. |
| `status` | Recurring Issue lifecycle: active, paused, or archived. |
| `cadence` | Recurrence rule that decides future materialization times. |
| `timeZone` | Time zone used to interpret recurrence times and daylight-saving changes. |
| `missedPolicy` | What to do when the app was offline or unable to materialize a scheduled window. |
| `issueTemplate` | Durable Issue template copied into each generated concrete Issue, including delegate, trigger, input, output, criteria, and verification policy. |

Examples:

- "Create a daily 18:00 report" calls `issue_create` with
  `issueType: 'recurring-issue'` and `request: { mode: 'request' }`.
- "Process all nodes tagged #invoice" calls `issue_create` with
  `input: { type: 'tag-query', tag: 'invoice' }` and can request
  `input-preview`.
- "Prepare the July release" calls `issue_create` with
  `issueType: 'issue'`, completion criteria, and optional sub-issues.
- "Move this issue to tomorrow at 08:00" calls `issue_update` with a scheduled
  trigger patch.
- "Retry the failed summary" calls `agent_session_start` for the same Issue if
  the user wants one immediate retry, or `issue_update` to re-arm the trigger if
  the durable schedule should change.

### Session Execution And Control Tools

`agent_session_start` requests one execution or orchestration Agent Session for
an existing Issue. It does not change the Issue trigger. Runtime validates
permission, blockers, revision, scope, and execution policy; snapshots the
Issue; creates the Agent Session; starts the worker; records Activity; and owns
terminal state.

```ts
interface AgentSessionStartInput {
  issueId: string;
  expectedIssueRevision?: string;
  continuation?: AgentSessionContinuationRequest;
  source:
    | { type: 'current-user-action'; userActionId: string }
    | { type: 'orchestration'; coordinatorAgentSessionId: string };
  detach?: boolean;
  executionPolicyOverride?: AgentSessionExecutionPolicyOverride;
  request: ChangeRequest;
  reason: string;
}

interface AgentSessionContinuationRequest {
  previousAgentSessionId: string;
  intent: 'continue' | 'retry' | 'revise';
  guidance?: string;
  context?: 'summary' | 'transcript' | 'none';
}

interface AgentSessionExecutionPolicyOverride {
  deadlineAt?: number;
  retryPolicy?: 'none' | 'manual' | 'bounded';
  maxAutomaticRetries?: number;
}
```

The caller owns `intent` and `guidance`: for example, "continue from where the
previous agent stopped", "retry with narrower scope", or "revise only the
summary section". Runtime owns whether this can continue in place or must become
a linked new Agent Session. If the previous Session is `awaitingInput`, the
caller should normally use `agent_session_send_message` instead of
`agent_session_start`. If the previous Session is terminal, runtime creates a
new Session and stores the link as `continuationOfAgentSessionId`.

`agent_session_read` is analogous to the read/status part of `run_status`: use
it to inspect an Agent Session or briefly wait for a specific decision. Agents
should not poll it by default; terminal runtime notifications and Activity
projections surface outcomes.

```ts
interface AgentSessionReadInput {
  agentSessionId: string;
  wait?: boolean;
  timeoutMs?: number;
  include?: AgentSessionReadInclude[];
}

type AgentSessionReadInclude =
  | 'activity-summary'
  | 'latest-output'
  | 'blocking-question';
```

`agent_session_send_message` is analogous to `run_steer`: it sends soft
guidance, user answers, or clarifications to an existing Agent Session. It does
not change the Issue definition, criteria, permissions, or execution policy.
If the Agent Session is `awaitingInput`, an answer can move the same Session
back to active execution when runtime accepts it.

```ts
interface AgentSessionSendMessageInput {
  agentSessionId: string;
  message: string;
  kind?: 'guidance' | 'answer';
  request: ChangeRequest;
  reason: string;
}
```

`agent_session_stop` is analogous to `run_stop`: it requests runtime stop and
records the stop request as Activity. The runtime moves the Agent Session to a
`canceled` terminal state.

```ts
interface AgentSessionStopInput {
  agentSessionId: string;
  request: ChangeRequest;
  reason: string;
}
```

`agent_session_start` parameter descriptions:

| Parameter | Description |
|---|---|
| `issueId` | Existing concrete Issue to execute or orchestrate. Do not pass Recurring Issue IDs; recurring definitions first materialize concrete Issues. |
| `expectedIssueRevision` | Issue revision the caller expects to execute. Include it after reading an Issue so runtime can reject stale execution requests. |
| `continuation` | Optional link to a previous terminal or stale Agent Session when the caller wants to continue, retry, or revise from prior work. |
| `source` | Authorization source for the execution request: a current user action or a coordinator Agent Session inside allowed orchestration scope. |
| `detach` | Whether the caller wants the Session to continue in the background while the current conversation proceeds. Runtime may still notify completion. |
| `executionPolicyOverride` | Narrow override for this execution only. It must not broaden the Issue's durable permissions without `issue_update`. |
| `request` | Preview or request mode. Preview validates eligibility, blockers, and confirmation requirements without starting a Session. |
| `reason` | Short audit summary explaining why this execution is being started. |

`AgentSessionContinuationRequest` descriptions:

| Field | Description |
|---|---|
| `previousAgentSessionId` | Session whose prior state should be linked as the continuation source. |
| `intent` | Caller intent: continue unfinished work, retry a failed attempt, or revise a previous result. Runtime decides whether this can reuse state or must create a new linked Session. |
| `guidance` | New instructions for this continuation. Keep it specific; use `issue_update` if the durable Issue definition changes. |
| `context` | Prior context to provide: bounded summary, transcript-level detail, or no prior context. Prefer summary unless transcript detail is required. |

`AgentSessionExecutionPolicyOverride` descriptions:

| Field | Description |
|---|---|
| `deadlineAt` | Execution-only deadline for this Session. It does not change the Issue due date. |
| `retryPolicy` | Execution-only retry behavior for this Session. |
| `maxAutomaticRetries` | Upper bound for automatic retries when retry policy allows them. |

`agent_session_read` parameter descriptions:

| Parameter | Description |
|---|---|
| `agentSessionId` | Agent Session to inspect. |
| `wait` | Whether runtime may briefly wait for a state change or blocking question. Omit or false for immediate status reads. |
| `timeoutMs` | Maximum wait time when `wait` is true. Runtime enforces a bounded maximum. |
| `include` | Optional detail slices to return. Use bounded summaries by default. |

`AgentSessionReadInclude` value descriptions:

| Value | Description |
|---|---|
| `activity-summary` | Recent Activity and state transitions for this Session. |
| `latest-output` | Bounded preview or reference to the latest visible output. |
| `blocking-question` | Current question or decision needed from the user or coordinator. |

`agent_session_send_message` parameter descriptions:

| Parameter | Description |
|---|---|
| `agentSessionId` | Active or waiting Agent Session to receive the message. |
| `message` | Guidance, clarification, or answer to send. It should not silently change durable Issue scope, criteria, trigger, or permissions. |
| `kind` | Message type. Use `answer` for a requested response to `awaitingInput`; use `guidance` for steering within the existing Issue definition. |
| `request` | Preview or request mode. Preview validates whether the Session can receive the message. |
| `reason` | Short audit summary explaining why this message is being sent. |

`agent_session_stop` parameter descriptions:

| Parameter | Description |
|---|---|
| `agentSessionId` | Pending or active Agent Session to cancel. |
| `request` | Preview or request mode. Preview validates that the Session can be stopped; request asks runtime to cancel it. |
| `reason` | Short audit summary explaining why execution should stop. |

The executing worker does not call a model-facing `session_record` tool. The
runtime records tool calls, progress summaries, final assistant output, errors,
questions, output links, and terminal state as Activity. If the worker needs a
durable Issue change, it uses `issue_create` or `issue_update` and that change
goes through the same permission and confirmation rules as any other agent
request.

The target surface intentionally has:

- no separate `recurring_issue_*` tools;
- no separate `activity_create` tool;
- no separate `verification_*` tools;
- no separate `view_*` tools;
- no direct Project, Run, Attempt, Occurrence, Task, or Logbook tool;
- no model-facing `session_record` tool;
- no one-tool-per-field CRUD.

### Permission Semantics

The same concept can be operated under different permissions:

- In an attended chat, if the user explicitly says "start this now", the agent
  can call `agent_session_start` for an existing Issue, or `issue_create` with a
  ready trigger for new create-and-run work, using the current `userActionId`.
- A scheduler activates triggers only for concrete Issues created by confirmed
  Recurring Issues.
- An executing Issue Session can set a ready/scheduled trigger or call
  `agent_session_start` only on a sub-issue inside the confirmed parent Issue
  scope and permission policy.
- An agent without user action can request Issue changes, but the tools either
  create safe drafts/proposals or return `needs-confirmation`; they cannot
  activate an unattended trigger or start an unattended Session.
- Issue edits that change status, delegate, sub-issues, destructive output, or
  trigger/execution policy can be drafted by the agent; direct starts,
  destructive changes, or
  execution-enabling changes require confirmation.

This is a permission distinction, not a concept distinction.

## Data And Runtime Design

Target stores and projections should use canonical names:

- Issue store;
- Recurring Issue store;
- Agent Session store;
- Activity store;
- View presets/projections.

Trigger evaluator behavior:

1. reads active Recurring Issues;
2. creates concrete Issues for due cadences according to missed policy;
3. reads concrete Issues whose triggers may be ready;
4. creates Agent Sessions only for concrete Issues that are confirmed,
   delegated, unblocked, executable, and authorized;
5. marks stale or interrupted Sessions as `stale` or `error` on recovery;
6. emits Activity for all material changes.

The trigger evaluator never waits on model/tool completion. Agent Session
lifecycle owns state, execution policy, activity, and recovery.

Direct Session-start behavior:

1. accepts `agent_session_start` only for an existing Issue;
2. validates current user action or orchestration source;
3. uses the same Issue readiness, blocker, scope, and execution-policy checks as
   trigger-derived starts;
4. if `continuation` is present, validates that the previous Session belongs to
   the same Issue and is in a continuable state;
5. creates a new Agent Session without changing the Issue trigger;
6. records continuation links as Activity when applicable;
7. returns `needs-confirmation` instead of starting when direct execution is not
   authorized.

Runtime responsibilities are mechanical and auditable:

- validate Issue revision, confirmation, blockers, permission scope, and
  execution policy before creating a Session;
- snapshot the Issue and resolved input/output scope at Session start;
- start, monitor, stop, recover, and terminalize the worker;
- emit Activity for starts, progress summaries, outputs, errors, questions,
  stops, stale recovery, child Issue links, and terminal states;
- notify or surface results to the owning conversation or Activity view.

Worker-agent responsibilities are product decisions inside the authorized Issue
scope:

- execute the Issue directly when it is leaf-sized;
- request visible sub-issues when work needs breakdown;
- set child Issue triggers or start child Agent Sessions only when
  orchestration is allowed;
- propose Issue definition or permission changes when the confirmed scope is not
  enough;
- provide output and evidence for completion criteria.

## Edge Cases And Failure Recovery

- **EDGE-1 blocked recurring work:** If a Recurring Issue creates a concrete
  Issue that is blocked, the concrete Issue remains blocked and visible. It does
  not create an Agent Session from its trigger until the blocker is complete or
  the relation is changed.
- **EDGE-2 missed cadence:** If multiple cadence windows were missed,
  `coalesce-latest` creates one latest concrete Issue with coverage metadata.
  Older windows are recorded in Activity as skipped or coalesced.
- **EDGE-3 stale execution:** If the app restarts and finds an active Agent
  Session with no live executor, recovery changes the Session to `stale` or
  `error` and emits Activity. It never leaves the Session active.
- **EDGE-4 out-of-scope action:** If an unattended Session requests content or
  writes outside the confirmed Issue scope, the Session emits `agent-question` or
  `agent-error` Activity and becomes `awaitingInput` or `error`.
- **EDGE-5 large outcome scope creep:** If Issue fields are not enough for a
  large outcome request, the agent should create supporting outliner notes or
  sub-issues rather than introducing a new object in V1.
- **EDGE-6 generated issue noise:** If recurring generated Issues make active
  views noisy, the product should adjust View grouping and filters. It should
  not reintroduce a hidden Occurrence object.
- **EDGE-7 hierarchy loop:** If a change would create a parent/sub-issue cycle,
  the tool returns `blocked` and records or returns validation details.
- **EDGE-8 abandoned sub-issue work:** If a sub-issue Session becomes `error`,
  `stale`, canceled, or overdue, the sub-issue records Activity and the parent
  Issue is surfaced as attention-needed through derived view state.
- **EDGE-9 restore request ambiguity:** If a user asks to "restore" or
  "continue" an Agent Session, runtime resolves the request by state:
  `awaitingInput` receives a message and continues in place; `pending` or
  `active` is read or recovered by runtime; `complete`, `error`, `stale`, or
  `canceled` creates a linked continuation Session when authorized.

## Implementation Boundary

Expected file areas:

- `src/core/agentEventLog.ts` or replacement protocol files for Agent Session,
  Activity, Issue, Recurring Issue, and view preset metadata.
- `src/main/agentEventStore.ts` or new stores for the canonical objects.
- `src/main/agentRuntime.ts` for Agent Session creation, state updates,
  activity emission, scheduler materialization, and recovery.
- `src/main/commandScheduler.ts`, `src/core/core.ts`, `src/core/types.ts`,
  `src/core/systemFields.ts`, and `src/main/documentService.ts` to retire
  command-node schedule ownership.
- `src/renderer/ui/agent/AgentRunsPanel.tsx` and related components to replace
  Run-first UI with Issue, Agent Session, and Activity views.
- `src/core/i18n/messages/en.ts` and `src/core/i18n/messages/zh-Hans.ts` for
  user-facing copy.
- `docs/spec/commands.md`, `docs/spec/agent-event-log-rendering.md`, and
  `docs/spec/agent-delegation-runtime.md` to fold shipped behavior into specs.
- Tests under scheduler/runtime, session lifecycle, stores, and renderer views.

## Acceptance Criteria

- **AC-1:** A user can ask the agent to create a recurring daily news summary
  and the agent creates a Recurring Issue draft, not a Task, Run, Project, or
  command node.
- **AC-2:** Until the Recurring Issue is confirmed, no unattended Agent Session
  can be created from it.
- **AC-3:** A due Recurring Issue creates a concrete Issue and then an Agent
  Session from the concrete Issue trigger when authorized.
- **AC-4:** A recurring daily workflow creates a new concrete Issue for each due
  window rather than keeping one Session alive across days.
- **AC-5:** Missed due windows coalesce into one latest Issue by default.
- **AC-6:** A failed Session can be retried by `agent_session_start` on the same
  Issue, or by re-arming the Issue trigger when the durable schedule should run
  again.
- **AC-7:** Every Agent Session reaches `complete`, `error`, `awaitingInput`,
  `stale`, or `canceled`.
- **AC-8:** Agent Session progress is visible as Activity.
- **AC-9:** A blocked Issue does not create an Agent Session before its blockers
  complete.
- **AC-10:** A large outcome can be represented as a parent Issue with
  completion criteria, sub-issues, evidence, Activity, and Agent Sessions.
- **AC-11:** Completing a parent Issue's Agent Session does not automatically
  complete the parent Issue. Parent completion still depends on explicit status
  change or completion criteria being met or waived.
- **AC-12:** Activity feeds show high-signal history and link to Agent Sessions.
- **AC-13:** The global Activity view is a UI projection over Activity, not a
  Logbook object.
- **AC-14:** `issue_search` filters by canonical Issue fields and
  activity-derived state; it does not encode Triage, Active, Scheduled,
  Completed, or Activity as protocol enum views.
- **AC-15:** Input selectors can process nodes by tag while keeping work state
  outside the outliner.
- **AC-16:** Unattended Sessions fail closed when they request content or writes
  outside confirmed Issue scope.
- **AC-17:** Dream uses the same canonical Issue, Recurring Issue, Agent
  Session, and Activity lifecycle with protected permissions.
- **AC-18:** New target contracts do not expose Task, WorkItem, Job, Attempt,
  Occurrence, Project, Logbook, or Run as product objects.
- **AC-19:** The model-facing tool list is limited to `issue_search`,
  `issue_read`, `issue_create`, `issue_update`, `agent_session_start`,
  `agent_session_read`, `agent_session_send_message`, and
  `agent_session_stop`.
- **AC-20:** When an Agent Session splits work, the created sub-issues are
  visible through `issue_search` and `issue_read`, linked to the parent Issue,
  and recorded in Activity.
- **AC-21:** `bun run typecheck`, `bun run test:core`, relevant renderer tests,
  and `bun run docs:check` pass before the PR is marked ready.
- **AC-22:** When the main agent offloads long work, it creates or updates an
  Issue with `issue_create` or `issue_update`, starts an Agent Session only when
  authorized, and cannot record progress for or terminalize an Agent Session.
- **AC-23:** A restore request never mutates a terminal Session back to active:
  `awaitingInput` continues through `agent_session_send_message`, while
  terminal continuation creates a new linked Agent Session from structured
  `continuation` intent.
- **AC-24:** For each scenario in the Real Usage Scenario Matrix, the agent can
  choose a primary tool path without needing hidden objects, UI View names,
  command nodes, or legacy Run concepts.
- **AC-25:** A verifier is represented as a normal Agent Session selected by
  `verificationPolicy`; its verdict is Activity/evidence, and no
  `verification_*` model-facing tool is required to complete an Issue.
- **AC-26:** Tool registration for the eight model-facing tools includes
  descriptions, search hints, prompt guidance, and described input/output schema
  fields; tests or schema snapshots fail if a visible parameter has no
  description.
- **AC-27:** A Recurring Issue has explicit confirmation state. Confirmed active
  Recurring Issues can materialize concrete Issues; draft, paused, or archived
  Recurring Issues cannot.
- **AC-28:** Recurring Issue create, confirm, pause, resume, skip, archive, and
  delete operations produce Activity on the Recurring Issue.
- **AC-29:** Scheduled views and trigger evaluation use scheduled triggers and
  Recurring Issue next materialization time; due dates alone do not start
  execution or place an Issue in Scheduled.
- **AC-30:** Activity entries exposed to users never contain raw model reasoning;
  progress is stored as concise `agent-progress`, action, question, response,
  error, output, or verification entries.

## Risks

- **Issue volume:** Recurring Issues and sub-issues can increase list volume.
  Solve with UI Views, grouping, and parent context instead of hidden
  occurrences or Projects.
- **Too little structure:** Removing Project can make large outcomes feel flat.
  The mitigation is parent Issues with completion criteria, evidence, sub-issue
  grouping, and progress summaries.
- **Too few tools:** A small tool surface can become too generic. The mitigation
  is strong typed `target` schemas, previews, validation errors, and structured
  return values.
- **Permission trust:** Agent-created unattended work is powerful.
  Confirmation must show cadence, delegate, input, output, execution-policy
  summary, and destructive-write policy.
- **Hierarchy overreach:** Parent Issues can become opaque containers if agents
  hide work inside Activity. Keep executable work visible as sub-issues with
  their own Agent Sessions.
- **Implementation debt:** Existing Run code may tempt wrapper terminology.
  Public contracts should move to Agent Session and Activity names in the same
  feature.

## Open Questions

- Should Recurring Issues materialize the concrete Issue at due time or slightly
  before due time so the user can inspect it in a Scheduled view?
- Should generated Issue titles include dates by default, or should date display
  be a View concern?
- Should `issue_search` and `issue_read` be available in every chat, or only
  after the user intent clearly asks to inspect durable work?
- Should failed scheduled Issues raise OS notifications by default, or only
  in-app notifications unless the user opts in?
- Should parent Issue completion criteria support optional auto-complete rules
  in V1, or should all parent completion remain explicit?
