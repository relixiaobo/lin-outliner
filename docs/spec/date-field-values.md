# Date Field Values

Date field values use one canonical local-date language across storage,
editing, search/query text, and agent-facing tools.

## Grammar

Endpoint:

```text
YYYY-MM-DD
YYYY-MM-DDTHH:mm
```

Range:

```text
<endpoint>/<endpoint>
```

Recurring single date (a repeat rule on a single endpoint; ranges never recur):

```text
<endpoint> RRULE:FREQ=DAILY
<endpoint> RRULE:FREQ=WEEKLY;BYDAY=MO,WE;INTERVAL=2;UNTIL=2026-12-31
```

Rules:

- Endpoints are local time values. They do not include seconds, milliseconds, or
  a timezone suffix.
- Stored and model-facing values use hyphenated dates and a literal `T` before
  time.
- Ranges use `/` only. `..`, `to`, dashes, and localized date forms are not
  canonical range syntax.
- A single endpoint may carry a recurrence rule, appended as ` RRULE:...` (one
  space separator). The rule is `FREQ=DAILY|WEEKLY|MONTHLY|YEARLY` with optional
  `INTERVAL=N`, `BYDAY=<weekdays>` (weekly only), and `UNTIL=<endpoint>`. A range
  never carries a rule (`<start>/<end> RRULE:...` is rejected).
- Normalizers may accept whitespace around `/`, but canonical output has no
  spaces.

## Semantics

- A date-only endpoint covers that whole local day.
- A datetime endpoint covers one local minute.
- A range start uses the start of the start endpoint.
- A range end includes the full end endpoint. Internally comparisons use
  half-open ranges.
- Explicit same-endpoint ranges are valid and remain ranges, for example
  `2026-05-20/2026-05-20`.
- A range is invalid when the start boundary is after the end boundary under
  the endpoint semantics above.
- UI inputs may reorder reversed start/end selections before storing the
  canonical value.
- A recurrence rule repeats the single anchor endpoint; `UNTIL` (the editor's
  "Ends") bounds the repetition. Recurrence is a single-date concept only.

## Examples

Canonical:

```text
2026-05-20
2026-05-20T13:45
2026-05-20/2026-05-24
2026-05-20T13:45/2026-05-24T17:00
2026-05-20/2026-05-20
2026-05-20T09:00 RRULE:FREQ=DAILY
2026-05-20 RRULE:FREQ=WEEKLY;BYDAY=MO,WE;INTERVAL=2;UNTIL=2026-12-31
```

Not canonical:

```text
2026/05/20
2026-05-20..2026-05-24
2026-05-20 to 2026-05-24
2026-05-20T13:45Z
2026-05-20T13:45:00
```

## Entry Points

- Date picker interactions store canonical values.
- Typed date field editing normalizes to canonical values.
- Agent `node_create` and `node_edit` outline field values for existing date
  fields must use canonical text values.
- Date-aware search/query operands use the same canonical forms.
- Agent-facing instructions teach only this grammar.

## Implementation

- Core parser and formatter, plus the recurrence-rule primitives
  (`DateRecurrenceRule`, `parseDateRecurrenceRule`, `formatDateRecurrenceRule`):
  `src/core/dateFieldValue.ts`. The `single` value variant carries an optional
  `recurrence`; a `range` never does.
- Recurring Issue materialization builds on the same date/recurrence primitives,
  but command nodes do not carry schedules or recurrence state.
- Search date matching: `src/core/searchEngine.ts` (matches on the anchor; a
  recurring value's later occurrences are not expanded for search).
- Date field UI: `src/renderer/ui/outliner/DateValuePicker.tsx` — a date value is a
  plain editable row whose picker is summoned additively (Space on an empty draft,
  or a calendar affordance on a committed value), not a dedicated whole-field
  control (PR #64). The picker carries a **Repeat** control (single dates only;
  hidden in range mode) backed by the shared recurrence helpers in
  `src/renderer/ui/outliner/dateRecurrence.ts`.
