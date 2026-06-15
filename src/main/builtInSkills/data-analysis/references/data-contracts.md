# Data Contracts

## Data Shape

Record:

- file path and format
- row count and column count
- field names and inferred types
- primary keys or natural identifiers
- date/time fields and timezone assumptions
- units and currency assumptions
- missingness and duplicate risks

## Quality Checks

- Missing values: distinguish empty, null, zero, and "not applicable".
- Duplicates: check key fields before aggregation.
- Ranges: flag impossible dates, negative counts, and out-of-domain categories.
- Joins: report join keys, match rates, and dropped records.
- Formulas: for XLSX, distinguish stored formula text from recalculated values.
- Sampling: state whether analysis uses all records or a sample.

## Reproducibility

- Preserve raw source files.
- Write transformed artifacts separately.
- Keep scripts or formulas that produced derived values.
- Report versions or runtime limits when relevant.
- Use exact filenames in conclusions when multiple inputs exist.
