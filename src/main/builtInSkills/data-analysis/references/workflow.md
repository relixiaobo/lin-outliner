# Data Analysis Workflow

## Decision Flow

1. Define the question, decision, and intended audience.
2. Inventory input files, tables, fields, time ranges, and known caveats.
3. Profile data before analysis.
4. Write or infer a data contract when repeatable validation matters.
5. Create an analysis plan.
6. Clean and transform with an audit trail.
7. Analyze and visualize.
8. Verify results, assumptions, and reproducibility.
9. Deliver conclusions with caveats and paths to artifacts.

## Analysis Plan Schema

When emitting JSON, follow `assets/schemas/analysis-plan.schema.json`.

Capture:

- `question`: analytical question
- `audience`: intended reader
- `decision`: decision or action the analysis supports
- `inputs`: files/tables used
- `metrics`: metrics or derived fields
- `methods`: profiling, contract validation, cleaning, grouping, joins, statistics, or modeling steps
- `outputs`: report, chart, transformed data, workbook, or notebook
- `verificationPlan`: checks to run before delivery
- `limitations`: known gaps or assumptions

## Working Pattern

- Start with a data dictionary or inferred schema.
- Make every filter and transformation explicit.
- Keep raw inputs unchanged.
- Prefer simple, auditable methods before complex modeling.
- Use deterministic scripts for repeated profiling, contract validation, and workbook inspection.
- Save derived data with names that describe the transformation.
- For workbook handoff, keep editable inputs, formulas, outputs, and checks clearly separated.

## Delivery Report

When finished, report:

- source inputs used
- transformations performed
- key findings
- verification performed
- output artifacts
- limitations and follow-up checks
