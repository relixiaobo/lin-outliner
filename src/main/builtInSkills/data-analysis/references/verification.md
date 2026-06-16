# Data Analysis Verification

Approach verification as reproducibility plus analytical sanity checking.

## Universal Checks

- raw inputs are preserved
- data shape and inferred types were inspected
- missingness, duplicate, type drift, outlier, and key risks are reported
- contract checks are run when a contract exists or is required by the task
- transformations are named and reproducible
- totals and denominators are sanity-checked
- charts match the transformed data
- claims are supported by computed evidence
- limitations are explicit

## File Checks

- profile CSV/TSV/JSON/JSONL inputs with `scripts/data_tool.py`
- validate CSV/TSV/JSON/JSONL inputs with `scripts/data_tool.py validate` when a contract is available
- inspect XLSX workbooks with `scripts/xlsx_tool.py`
- check workbook hidden sheets, formulas, formula error literals, external links, and manual calculation mode
- check broken local paths for any produced report artifacts
- avoid remote dependencies unless the user requested them

## Analytical Sanity Checks

- Recompute totals by an independent path when feasible.
- Compare row counts before and after filters, joins, and deduplication.
- Report join match rates and dropped/unmatched rows.
- Keep denominators next to every percentage.
- Inspect outliers before excluding them.
- Distinguish observed data from interpretation and recommendation.

## Delivery Report

When emitting JSON, follow `assets/schemas/verification-report.schema.json`.
For contract validation output, follow
`assets/schemas/data-validation-report.schema.json`.

Include:

- `artifact`: final report or output path
- `outputRoute`: report, chart, transformed data, workbook, or notebook
- `filesProduced`: produced deliverables
- `sourceMaterials`: source inputs used
- `checks`: check objects with name, status, tool, and evidence or result
- `issues`: issues found, including fixed issues
- `limitations`: checks not possible in the current environment
- `finalStatus`: passed, warning, or failed
