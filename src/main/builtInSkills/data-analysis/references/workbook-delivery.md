# Workbook Delivery

Use this reference when the output is an XLSX workbook, spreadsheet handoff,
dashboard, model, tracker, or chart-ready workbook.

## Workbook Shape

For nontrivial workbooks, prefer this order:

1. `Summary` or `Dashboard`: answer, KPIs, charts, and caveats.
2. `Inputs` or `Assumptions`: editable parameters and source notes.
3. `Data` or `Clean Data`: normalized source or transformed table.
4. `Analysis` or `Model`: formulas, pivots, grouping, calculations.
5. `Checks`: reconciliation, formula-error scans, and quality checks when correctness depends on linked calculations.

Small trackers and simple exports can use fewer sheets, but still keep source,
editable assumptions, and derived calculations distinct when they differ.

## Formula Rules

- Use formulas for user-editable workbook calculations instead of hardcoding derived values.
- Keep source constants and assumptions in named input cells or clearly labeled sections.
- Guard formulas against blank inputs, divide-by-zero, and missing lookups.
- Keep formulas consistent across repeated periods, categories, or rows.
- Scan for `#REF!`, `#DIV/0!`, `#VALUE!`, `#NAME?`, `#N/A`, and circular-reference risks.

## Layout Rules

- Make key numbers and labels visible without extreme column widths.
- Freeze panes when a table is meant for review.
- Use filters or real tables for long tabular handoffs.
- Use native charts when charts are central to the answer and the host can verify them.
- Keep dashboards compact: title, timestamp/source note, KPI row, chart/table blocks, caveats.
- Avoid decorative formatting that hides values, formulas, or source notes.

## Verification

Before delivery:

- inspect workbook package with `scripts/xlsx_tool.py`
- check hidden sheets and external links
- check formula error literals and manual calculation mode
- reconcile source totals against summary totals
- verify chart ranges match transformed data
- render or open the workbook when host tools allow it
