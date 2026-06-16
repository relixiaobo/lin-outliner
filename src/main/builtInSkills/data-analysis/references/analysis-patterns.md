# Analysis Patterns

## Descriptive

Use for "what happened" questions:

- totals and subtotals
- distributions
- top categories
- missingness
- trends over time

## Diagnostic

Use for "why did it change" questions:

- segment comparisons
- cohort splits
- before/after comparisons
- outlier review
- funnel step differences

## Forecasting and Modeling

Use only when the data and question justify it:

- define target and horizon
- separate training and evaluation windows
- report baseline comparison
- avoid overclaiming accuracy

## Spreadsheet and Workbook Analysis

- Inspect sheet names, dimensions, formulas, hidden assumptions, and external links before using a workbook as evidence.
- Do not assume formula values are recalculated unless the tool actually recalculated them.
- Prefer exporting a normalized table before complex analysis.

## Interpretation

- Separate observation from explanation.
- Label correlations as correlations.
- State sample size and denominator for every rate.
- Provide caveats close to the finding they qualify.
