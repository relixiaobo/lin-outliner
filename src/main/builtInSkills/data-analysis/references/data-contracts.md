# Data Contracts

## Data Shape

Record:

- file path and format
- row count and column count
- field names and inferred types
- primary keys or natural identifiers
- date/time fields and timezone assumptions
- units and currency assumptions
- missingness, duplicates, outliers, and constant-column risks

## Contract Pattern

Use a lightweight JSON contract when the task needs repeatable validation:

```json
{
  "fields": [
    { "name": "id", "type": "string", "required": true, "unique": true },
    { "name": "amount", "type": "number", "required": true, "min": 0 },
    { "name": "status", "type": "string", "allowedValues": ["open", "closed"] }
  ],
  "uniqueKeys": [["id"]],
  "rowCountMin": 1
}
```

When emitting a contract file, follow
`assets/schemas/data-contract.schema.json`.

Supported field types are `string`, `number`, `date`, `boolean`, and `empty`.
Use `allowedValues` for controlled categories, `min`/`max` for numeric or date
ranges, `required` for non-missing constraints, and `unique`/`uniqueKeys` for
identifier checks.

## Quality Checks

- Missing values: distinguish empty, null, zero, and "not applicable".
- Duplicates: check candidate keys before aggregation.
- Ranges: flag impossible dates, negative counts, and out-of-domain categories.
- Type drift: detect mixed numeric/text/date values before calculations.
- Joins: report join keys, match rates, duplicate-key risks, and dropped records.
- Outliers: flag values worth inspection; do not delete them without a stated rule.
- Formulas: for XLSX, distinguish stored formula text from recalculated values.
- Sampling: state whether analysis uses all records or a sample.

## Validation Strategy

1. Profile raw files first.
2. Derive or write a contract for fields, keys, ranges, and accepted values.
3. Validate before transformation.
4. Transform in a separate artifact.
5. Profile and validate the transformed artifact again.
6. Report changed/dropped records and any accepted violations.

## Reproducibility

- Preserve raw source files.
- Write transformed artifacts separately.
- Keep scripts or formulas that produced derived values.
- Report versions or runtime limits when relevant.
- Use exact filenames in conclusions when multiple inputs exist.
