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

Rules:

- Endpoints are local time values. They do not include seconds, milliseconds, or
  a timezone suffix.
- Stored and model-facing values use hyphenated dates and a literal `T` before
  time.
- Ranges use `/` only. `..`, `to`, dashes, and localized date forms are not
  canonical range syntax.
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

## Examples

Canonical:

```text
2026-05-20
2026-05-20T13:45
2026-05-20/2026-05-24
2026-05-20T13:45/2026-05-24T17:00
2026-05-20/2026-05-20
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

- Core parser and formatter: `src/core/dateFieldValue.ts`
- Search date matching: `src/core/searchEngine.ts`
- Date field UI: `src/renderer/ui/outliner/DateFieldControl.tsx`
