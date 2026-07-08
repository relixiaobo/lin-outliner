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

- Keep model-facing Issue tools focused on flat durable Issue definitions.
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

The main agent's responsibility is to author a good Issue definition: objective,
scope, coverage, output shape, trigger, and verification criteria. It does not
need to pre-plan every execution step because the Agent Session will build that
plan from the Issue snapshot. This keeps the tool trace small, makes the Work UI
easy to scan, and gives the executor room to choose the right strategy. If each
district is truly independently user-visible work that should be managed
separately, the agent can create separate flat Issues, but that is a different
user request.

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

Issue tools operate on flat Issue definitions. Search filters and read includes
return Issue-level facts rather than execution breakdown trees.

`issue_create`

- Creates either a flat Issue or a Recurring Issue.
- For complex work, the caller writes the full objective and acceptance criteria
  on the Issue instead of pre-materializing internal steps as separate durable
  work.

`issue_update`

- Updates flat Issue definition, lifecycle, trigger, criteria, verification,
  evidence, relations, input, output, permission, or execution policy.
- `relations` connect independently user-visible Issues whose lifecycle is
  managed separately, such as true external blockers, duplicates, or related
  outcomes.
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

- Inbox: attention-needed work.
- Today: when-ready, running, due, scheduled today, repeating today, and done today work.
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
- Internal breakdown is verified through criteria/evidence on the same Issue.

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
