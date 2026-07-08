# Agent Issue Manager

## Goal

Replace Run-centered durable work with a flat Issue model that is clear to both
users and agents.

An Issue is the user-visible unit of work. It contains the goal, constraints,
acceptance criteria, verification policy, input scope, output policy, trigger,
Activity, and Agent Sessions that execute it. Repeated work is represented by a
Recurring Issue that materializes flat concrete Issues when due.

The key simplification is that Issues do not form a hierarchy. Complex work is
decomposed inside an Agent Session plan, evidence, Activity, and final output.
Agents can create another Issue only when the new work is independently
user-visible and should be managed separately from the current Issue.

## Non-goals

- Do not support parent or child Issues in model-facing tools.
- Do not expose Project, Task, Job, Run, Occurrence, or Logbook as durable work
  concepts.
- Do not keep legacy readers or migrations for previous pre-release Issue
  shapes.
- Do not make Dream ordinary Issue work; Dream keeps its protected runtime-only
  path.

## Design

### Core Concepts

`Issue`

- A flat durable work item.
- Holds title, description, lifecycle status, delegate profile, relations,
  trigger, due date, recurrence context, completion criteria, verification
  policy, evidence, note links, input scope, output policy, execution policy,
  confirmation provenance, revisions, timestamps, and Activity.
- Does not contain parent or child fields.

`Recurring Issue`

- A reusable rule that materializes flat concrete Issues.
- Holds title and description templates, cadence, time zone, missed-window
  policy, concrete Issue template, confirmation provenance, and next
  materialization time.
- Generated Issues link back through recurrence context, not hierarchy.

`Agent Session`

- One execution, continuation, retry, or verification attempt for one Issue.
- Holds purpose, state, source, Issue snapshot, input/output snapshots,
  execution policy, continuation link, plan, latest output, error, revisions,
  timestamps, and Activity.
- Session plan items are the place for internal breakdown such as "query each
  district" or "verify each source".

`Activity`

- The audit and user-visible history stream for Issues, Recurring Issues, and
  Agent Sessions.
- Records definition changes, status changes, comments, progress, questions,
  responses, errors, verification results, and output links.

### Flat Decomposition

When a user asks for a complex task, the main agent should create the smallest
set of user-visible Issues.

Example:

- User asks: "Create a verified task to query Beijing district weather and a
  verified task to query Chengdu district weather. Each district should be
  checked."
- Main agent creates two flat Issues:
  - "Query Beijing district weather"
  - "Query Chengdu district weather"
- Each Issue description and criteria specify that every district must be
  enumerated, queried, sourced, timestamped, verified, and summarized.
- Runtime starts the relevant Agent Session when the trigger allows it.
- The Issue's Agent Session creates plan items for each district and records
  results/evidence on the same Issue.

The main agent should not expand that request into dozens of child Issues. That
would make the tool trace noisy, make the Work UI harder to scan, and force the
model to decide when hierarchy is appropriate. If each district is truly
user-visible work that should be managed separately, the agent can create flat
Issues with explicit relation links, but that is not the default decomposition
mechanism.

### Tool Surface

The model-facing tools are:

- `issue_search`
- `issue_read`
- `issue_create`
- `issue_update`
- `agent_session_start`
- `agent_session_read`
- `agent_session_send_message`
- `agent_session_stop`

Issue tools never accept parent or child Issue parameters. Search filters do not
include parent fields, and read includes do not expose child trees.

`issue_create`

- Creates either a flat Issue or a Recurring Issue.
- For complex work, the caller writes the full objective and acceptance criteria
  on the Issue instead of pre-materializing internal steps as separate durable
  work.

`issue_update`

- Updates flat Issue definition, lifecycle, trigger, criteria, verification,
  evidence, relations, input, output, permission, or execution policy.
- Updates Recurring Issue cadence/template/lifecycle.

`agent_session_start`

- Starts or requests one execution or verification attempt for an existing
  Issue.
- Runtime eligibility still enforces archived/terminal/blocked/active-session
  rules.

`agent_session_send_message`

- Sends guidance or an answer into an active Session.
- Durable definition changes still go through `issue_update`.

### Work UI

The Work panel is Issue-first and flat:

- Inbox: unarranged manual work and attention-needed work.
- Today: running, due, scheduled today, repeating today, and done today work.
- Upcoming: future scheduled work and recurring rules.
- Logbook: terminal concrete Issues.

Rows show concept/status marker, title, and one context-sensitive meta line.
Internal Session plan items do not become first-level Work rows.

Opening an Issue shows:

- title and status marker;
- timing/trigger line when useful;
- instructions;
- inline Agent Session cards;
- generated Issues from Recurring Issues when relevant;
- Activity.

Agent Session cards reuse the chat execution presentation: the process summary is
visible, process details are collapsed by default, and latest output/error is
shown inline.

### Verification

Verification is an execution policy on an Issue.

- `agent-review` starts a verifier Agent Session when requested by runtime or
  tools.
- The verifier reviews criteria, evidence, Activity, linked Agent Sessions, and
  output.
- Verdicts are Activity and do not automatically complete the Issue.
- Internal breakdown can be verified through criteria/evidence on the same Issue,
  not through child Issue status.

### Permissions

Issue and Agent Session tools use the same runtime-owned authorization model as
the rest of the agent tool surface.

- The model does not pass user action ids.
- Runtime-owned authorization context decides whether a mutation or execution
  control action is allowed.
- Creating unattended scheduled or ready work means the user intentionally
  created a durable trigger; runtime may execute it when eligible.

### Dream Compatibility

Dream remains excluded from ordinary Issue work.

- It is runtime-only memory processing.
- It runs in the protected Dream channel and keeps its existing tool whitelist,
  evidence exclusion, retention, and visibility boundaries.

## Open Questions

- Whether Issue criteria should gain a first-class structured checklist shape or
  remain the current text/evidence criteria.
- Whether Session plan progress should be searchable from `issue_search` as a
  summary slice.
