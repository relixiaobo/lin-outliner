---
name: data-analysis
description: Analyze, clean, profile, summarize, validate, chart, and explain CSV, TSV, JSON, JSONL, XLSX workbooks, spreadsheets, tables, metrics exports, logs, and datasets with reproducible calculations.
---

# Data Analysis

## Overview

Treat analysis as a reproducible reasoning workflow, not as a spreadsheet-format
task. XLSX, CSV, JSON, charts, reports, and notebooks are input/output routes.

## Route

1. Identify the analytical question, decision, dataset inputs, required output, and acceptable assumptions.
2. Inspect data before drawing conclusions. For CSV/TSV/JSON/JSONL, use `python3 ${AGENT_SKILL_DIR}/scripts/data_tool.py profile path/to/data.csv --out profile.json` when useful. For XLSX, use `python3 ${AGENT_SKILL_DIR}/scripts/xlsx_tool.py inspect path/to/workbook.xlsx --out workbook-report.json`.
3. Create an analysis plan before transformations. If emitting JSON, keep it compatible with `${AGENT_SKILL_DIR}/assets/schemas/analysis-plan.schema.json`.
4. Separate data cleaning, transformation, analysis, visualization, and interpretation. Keep a short audit trail of assumptions and dropped/changed records.
5. Choose the output route:
   - Use a concise written report for decisions.
   - Use CSV/JSON artifacts for transformed data.
   - Use charts only when they clarify a comparison, trend, distribution, or relationship.
   - Use XLSX output only when the user needs spreadsheet handoff.
6. Verify before delivering. Re-run deterministic checks after any transformation, sanity-check totals and missingness, and label limitations.

## References

Load only the reference needed for the current route:

- `references/workflow.md` for planning, profiling, analysis flow, and delivery.
- `references/data-contracts.md` for schemas, data quality, missing values, joins, and reproducibility.
- `references/analysis-patterns.md` for common analytical questions and method choices.
- `references/visualization.md` for chart selection and visual QA.
- `references/verification.md` for analytical QA and delivery reporting.

## Scripts

- `python3 ${AGENT_SKILL_DIR}/scripts/data_tool.py profile data.csv --out profile.json` profiles CSV, TSV, JSON arrays, and JSONL records with column types, missingness, numeric summaries, and top values.
- `python3 ${AGENT_SKILL_DIR}/scripts/xlsx_tool.py inspect workbook.xlsx --out workbook-report.json` inspects XLSX workbook sheets, dimensions, formulas, shared strings, external links, and placeholder-like text.

The scripts are portable baseline tools. They intentionally use Python standard
library only so the skill can travel across hosts. Use richer host runtimes
when available, but preserve reproducible inputs, steps, checks, and outputs.

## Quality Bar

- Do not infer from raw data without first inspecting shape, types, missingness, and obvious quality risks.
- Do not hide transformations; report filters, joins, grouping keys, and assumptions.
- Do not claim causality from descriptive data unless the method supports it.
- Keep charts honest: labeled axes, readable scales, visible units, and no decorative distortion.
- Preserve source files; write derived artifacts separately.
- State limitations plainly when files are too large, formulas cannot recalculate, or rendering/chart verification is unavailable.
