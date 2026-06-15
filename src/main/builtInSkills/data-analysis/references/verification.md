# Data Analysis Verification

Approach verification as reproducibility plus analytical sanity checking.

## Universal Checks

- raw inputs are preserved
- data shape and inferred types were inspected
- missingness and duplicate risks are reported
- transformations are named and reproducible
- totals and denominators are sanity-checked
- charts match the transformed data
- claims are supported by computed evidence
- limitations are explicit

## File Checks

- profile CSV/TSV/JSON/JSONL inputs with `scripts/data_tool.py`
- inspect XLSX workbooks with `scripts/xlsx_tool.py`
- check broken local paths for any produced report artifacts
- avoid remote dependencies unless the user requested them

## Delivery Report

When emitting JSON, follow `assets/schemas/verification-report.schema.json`.

Include:

- `artifact`: final report or output path
- `outputRoute`: report, chart, transformed data, workbook, or notebook
- `filesProduced`: produced deliverables
- `sourceMaterials`: source inputs used
- `checks`: check objects with name, status, tool, and evidence or result
- `issues`: issues found, including fixed issues
- `limitations`: checks not possible in the current environment
- `finalStatus`: passed, warning, or failed
