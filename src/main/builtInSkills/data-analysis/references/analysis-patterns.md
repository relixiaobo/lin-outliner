# Analysis Patterns

## Descriptive

Use for "what happened" questions:

- totals and subtotals
- distributions
- top categories
- missingness
- trends over time
- data quality exceptions

## Diagnostic

Use for "why did it change" questions:

- segment comparisons
- cohort splits
- before/after comparisons
- outlier review
- funnel step differences
- join/match-rate review

## Forecasting and Modeling

Use only when the data and question justify it:

- define target and horizon
- separate training and evaluation windows
- report baseline comparison
- avoid overclaiming accuracy
- keep feature construction and exclusions auditable

## Spreadsheet and Workbook Analysis

- Inspect sheet names, dimensions, formulas, hidden assumptions, and external links before using a workbook as evidence.
- Do not assume formula values are recalculated unless the tool actually recalculated them.
- Treat hidden sheets, manual calculation mode, formula errors, external links, and stale assumptions as analytical risks.
- Prefer exporting a normalized table before complex analysis.

## Joining and Aggregation

- Check key uniqueness on both sides before joining.
- Report match, left-only, right-only, and duplicated-key counts.
- Reconcile totals before and after aggregation.
- Keep denominators next to percentages and rates.
- State whether nulls are excluded or counted.

## Transformation

- Keep raw input unchanged.
- Use named derived artifacts.
- Apply one clear cleaning rule at a time.
- Record row filters, column drops, type coercions, deduplication rules, and imputation rules.
- Re-profile transformed data before interpreting it.

## Interpretation

- Separate observation from explanation.
- Label correlations as correlations.
- State sample size and denominator for every rate.
- Provide caveats close to the finding they qualify.
- Prefer "the data shows" over "this proves" unless the method supports proof.
