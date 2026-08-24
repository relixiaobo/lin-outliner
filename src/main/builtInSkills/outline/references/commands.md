<!-- Generated from the Outline capability registry. Do not edit by hand. -->

# Outline Command Guide

Use this guide to understand the complete public CLI surface and choose a command.
Run `outline COMMAND --help` for the same command contract at runtime and
`outline schema COMMAND` for its exact structured request and result schemas.

## Choose an Execution Shape

| Intent | Public shape |
|---|---|
| Read one known resource | `outline show` with an exact ID or stable alias |
| Discover resources | `outline find` with a bounded text or structured query |
| Create one complete resource | One porcelain `create` or `add` invocation |
| Supply complex state for one resource | The same porcelain command with `--input FILE|-` |
| Update one resource | One convergent `set`, `configure`, or leaf-edit invocation |
| Change multiple dependent resources | One ChangeSet, one `diff`, and one `apply` |
| Perform a bounded bulk mutation | One bounded selector or one ChangeSet; never a shell mutation loop |
| Perform destructive or high-impact work | Preview and apply only the exact reviewed Diff |
| Import external data | `import inspect`, `import plan`, exact `apply`, then `import verify` |
| Recover a completed mutation | Inspect `log`, then `revert OPERATION_ID` |

## Mutation Semantics

- `create` and `add` explicitly create new semantic state.
- Patch commands preserve omitted properties.
- Replacement happens only through an explicitly documented replacement form.
- Repeated `set`, `configure`, and `ensure` calls converge or return semantic no-change.
- Every successful mutation returns one visible Operation or semantic no-change result.
- Every `many` mutation is bounded by an explicit maximum.

## Global Options

Place global options before the command:

- `--json`: Write stable machine-readable response envelopes; ignored by --help.
- `--human`: Write human-readable output even when stdout is not a TTY; ignored by --help.
- `--protocol MAJOR` (default 1): Require one supported protocol major.
- `--no-start`: Fail if Runtime is not already running.
- `--startup-timeout MS` (default 10000): Limit Runtime startup wait time.
- `--timeout MS` (default 60000): Limit one Runtime request, transfer, or stream.

## Command Families

| Family | Purpose |
|---|---|
| `asset` | Stage, inspect, and export retained assets. |
| `capture` | Create provenanced capture trees. |
| `daily` | Address and ensure local-date Daily Notes. |
| `definition` | Create, configure, and merge tag or field definitions. |
| `done` | Set or cycle checkbox completion state. |
| `field` | Define, reuse, set, clear, remove, or select fields. |
| `import` | Inspect external sources and plan reviewed imports through normalized data. |
| `media` | Create and patch image or attachment Nodes. |
| `reference` | Add, retarget, inline, and restore references. |
| `search` | Create, configure, ensure, and refresh Saved Searches. |
| `tag` | Apply or remove tag definitions. |
| `template` | Preview and apply tag-template backfill. |
| `text` | Apply bounded, reviewed literal text transformations. |
| `view` | Configure complete views or edit group, sort, filter, and display leaves. |

Root commands cover discovery, direct Node operations, ChangeSets, history, and lifecycle.

## Root Commands

| Command | Semantics | Purpose | Common syntax |
|---|---|---|---|
| `outline version` | metadata; idempotent | Print CLI, app, protocol, and storage versions. | `outline version` |
| `outline status` | read-only; idempotent | Inspect Runtime presence and storage health without starting it. | `outline status` |
| `outline capabilities` | metadata; idempotent | Print the executable CLI registry and optionally verify Runtime parity. | `outline capabilities [--runtime]` |
| `outline schema` | metadata; idempotent | Print an exact public or command-specific JSON Schema. | `outline schema [SCHEMA\|COMMAND...]` |
| `outline find` | read-only; idempotent | Find bounded Nodes with text shorthand or the canonical query grammar. | `outline find [TEXT] [OPTIONS]` |
| `outline show` | read-only; idempotent | Read one deterministic target with a bounded Projection. | `outline show SELECTOR [PROJECTION OPTIONS]` |
| `outline export` | read-only stream; idempotent | Export a bounded target as JSON, JSONL, Markdown, or OPML. | `outline export SELECTOR [PROJECTION OPTIONS] [--output FILE\|-]` |
| `outline watch` | read-only stream; idempotent | Stream ordered, resumable Runtime events. | `outline watch [--cursor CURSOR] [--filter FILE\|-] [--projection FILE\|-]` |
| `outline diff` | preview; idempotent | Normalize and preview one complete ChangeSet without writing. | `outline diff --input FILE\|- [--input-format json\|jsonl] [--output FILE\|-] [--idempotency-key KEY]` |
| `outline apply` | exact apply; idempotent | Apply one exact reviewed Diff atomically. | `outline apply --input DIFF_FILE\|- [--yes]` |
| `outline log` | read-only; idempotent | Read paginated durable Operation history. | `outline log [FILTER OPTIONS]` |
| `outline revert` | recovery mutation; idempotent | Guard and exactly revert one retained Operation. | `outline revert OPERATION_ID [--idempotency-key KEY]` |
| `outline undo` | recovery mutation; idempotent | Revert the latest applicable Operation. | `outline undo [--idempotency-key KEY]` |
| `outline redo` | recovery mutation; idempotent | Revert the latest applicable revert Operation. | `outline redo [--idempotency-key KEY]` |
| `outline add` | create; not idempotent | Create one complete typed Node tree below a parent. | `outline add PARENT TEXT \| add --input FILE\|-` |
| `outline set` | patch; idempotent | Patch content, description, code, checkbox, icon, banner, or image state. | `outline set TARGET [PROPERTY OPTIONS]` |
| `outline move` | patch; idempotent | Move a bounded Node selection below one destination. | `outline move TARGET DESTINATION` |
| `outline duplicate` | create; not idempotent | Duplicate a bounded Node selection below one destination. | `outline duplicate TARGET DESTINATION` |
| `outline merge` | destructive; not idempotent; destructive review required | Merge source Nodes into one target after exact Diff review. | `outline merge SOURCE TARGET` |
| `outline indent` | patch; not idempotent | Move one Node below its preceding sibling. | `outline indent TARGET` |
| `outline outdent` | patch; not idempotent | Move one Node after its parent. | `outline outdent TARGET` |
| `outline trash` | patch; idempotent | Move a bounded Node selection to Trash. | `outline trash TARGET` |
| `outline restore` | patch; idempotent | Restore a bounded Node selection from Trash. | `outline restore TARGET` |
| `outline purge` | destructive; not idempotent; destructive review required | Permanently purge selected Nodes or Empty Trash after exact Diff review. | `outline purge TARGET [--contents]` |

## Asset

Stage, inspect, and export retained assets.

| Command | Semantics | Purpose | Common syntax |
|---|---|---|---|
| `outline asset ingest` | asset staging; not idempotent | Stage verified asset bytes under a recovery-aware lease. | `outline asset ingest PATH\|-` |
| `outline asset show` | read-only; idempotent | Read logical asset metadata. | `outline asset show ASSET_ID` |
| `outline asset export` | read-only stream; idempotent | Stream verified asset bytes. | `outline asset export ASSET_ID --output FILE\|-` |

## Capture

Create provenanced capture trees.

| Command | Semantics | Purpose | Common syntax |
|---|---|---|---|
| `outline capture add` | create; not idempotent | Ensure an optional date and create a provenanced typed capture tree. | `outline capture add (--parent TARGET \| --date YYYY-MM-DD) --title TITLE --metadata FILE` |

## Daily

Address and ensure local-date Daily Notes.

| Command | Semantics | Purpose | Common syntax |
|---|---|---|---|
| `outline daily ensure` | ensure; idempotent | Ensure one local-date Daily Note exists. | `outline daily ensure YYYY-MM-DD` |

## Definition

Create, configure, and merge tag or field definitions.

| Command | Semantics | Purpose | Common syntax |
|---|---|---|---|
| `outline definition create` | create; not idempotent | Create a complete tag or field definition. | `outline definition create TYPE NAME \| definition create --input FILE\|-` |
| `outline definition configure` | patch; idempotent | Patch type-specific definition configuration. | `outline definition configure TARGET TYPE --patch JSON\|FILE` |
| `outline definition merge` | destructive; not idempotent; destructive review required | Merge source definitions into one target after exact Diff review. | `outline definition merge SOURCE TARGET` |

## Done

Set or cycle checkbox completion state.

| Command | Semantics | Purpose | Common syntax |
|---|---|---|---|
| `outline done set` | patch; idempotent | Set done state on a bounded Node selection. | `outline done set TARGET BOOLEAN` |
| `outline done cycle` | patch; not idempotent | Cycle done state on one exact Node. | `outline done cycle TARGET` |

## Field

Define, reuse, set, clear, remove, or select fields.

| Command | Semantics | Purpose | Common syntax |
|---|---|---|---|
| `outline field define` | create; idempotent | Create or reuse a field on a target and optionally set its initial value. | `outline field define TARGET NAME [--value VALUE]` |
| `outline field set` | patch; idempotent | Set one field value on a bounded Node selection. | `outline field set TARGET FIELD VALUE` |
| `outline field clear` | patch; idempotent | Clear one field value while retaining the field slot. | `outline field clear TARGET FIELD` |
| `outline field remove` | patch; idempotent | Remove one field slot from a bounded Node selection. | `outline field remove TARGET FIELD` |
| `outline field reuse` | patch; idempotent | Replace a local field definition with a reusable definition. | `outline field reuse TARGET SOURCE_FIELD TARGET_FIELD` |
| `outline field select` | patch; idempotent | Select one option for a field on a bounded Node selection. | `outline field select TARGET FIELD OPTION` |

## Import

Inspect external sources and plan reviewed imports through normalized data.

| Command | Semantics | Purpose | Common syntax |
|---|---|---|---|
| `outline import inspect` | read-only local inspection; idempotent | Return a bounded profile of one external source without writing. | `outline import inspect SOURCE` |
| `outline import plan` | preview; idempotent | Normalize one external source and produce one reviewed import Diff. | `outline import plan SOURCE --output DIFF --evidence-output EVIDENCE [OPTIONS]` |
| `outline import verify` | read-only verification; idempotent | Verify one import Operation against its reviewed Diff and evidence. | `outline import verify OPERATION_ID --diff DIFF --evidence EVIDENCE` |

## Media

Create and patch image or attachment Nodes.

| Command | Semantics | Purpose | Common syntax |
|---|---|---|---|
| `outline media add` | create; not idempotent | Stage a local asset and create its media Node in one invocation. | `outline media add PARENT TYPE PATH\|-` |
| `outline media set` | patch; idempotent | Patch image or attachment metadata and source. | `outline media set TARGET [PROPERTY OPTIONS]` |

## Reference

Add, retarget, inline, and restore references.

| Command | Semantics | Purpose | Common syntax |
|---|---|---|---|
| `outline reference add` | patch; not idempotent | Add a reference from a bounded Node selection. | `outline reference add TARGET REFERENCE` |
| `outline reference set` | replace; idempotent | Replace the target of an existing reference. | `outline reference set TARGET REFERENCE` |
| `outline reference inline` | patch; not idempotent | Inline a referenced Node into one exact target. | `outline reference inline TARGET [REFERENCE]` |
| `outline reference restore` | patch; not idempotent | Restore an inlined Node to a reference. | `outline reference restore TARGET REFERENCE` |

## Search

Create, configure, ensure, and refresh Saved Searches.

| Command | Semantics | Purpose | Common syntax |
|---|---|---|---|
| `outline search create` | create; not idempotent | Create a complete Saved Search and its initial materialized view. | `outline search create [PARENT] TITLE (--match TEXT \| --query JSON\|FILE) \| search create --input FILE\|-` |
| `outline search ensure-tag` | ensure; idempotent | Ensure the canonical Saved Search for one tag exists. | `outline search ensure-tag TAG` |
| `outline search set` | patch; idempotent | Atomically patch a Search query, title, and view, then refresh results. | `outline search set TARGET [--title TITLE] [--query JSON\|FILE]` |
| `outline search refresh` | patch; idempotent | Refresh materialized results for a Search. | `outline search refresh TARGET` |

## Tag

Apply or remove tag definitions.

| Command | Semantics | Purpose | Common syntax |
|---|---|---|---|
| `outline tag add` | patch; idempotent | Apply a tag definition to a bounded Node selection. | `outline tag add TARGET TAG` |
| `outline tag remove` | patch; idempotent | Remove a tag definition from a bounded Node selection. | `outline tag remove TARGET TAG` |

## Template

Preview and apply tag-template backfill.

| Command | Semantics | Purpose | Common syntax |
|---|---|---|---|
| `outline template apply` | patch; idempotent | Preview or apply template backfill to all matching tagged Nodes. | `outline template apply TAG` |

## Text

Apply bounded, reviewed literal text transformations.

| Command | Semantics | Purpose | Common syntax |
|---|---|---|---|
| `outline text replace` | destructive; idempotent; destructive review required | Replace literal text across one exact or bounded query-selected Node set. | `outline text replace TARGET --find TEXT --replace TEXT \| text replace --matching TEXT --max N --find TEXT --replace TEXT \| text replace --input FILE\|-` |

## View

Configure complete views or edit group, sort, filter, and display leaves.

| Command | Semantics | Purpose | Common syntax |
|---|---|---|---|
| `outline view set` | patch; idempotent | Apply one complete declarative view patch with explicit collection replacement. | `outline view set TARGET MODE \| view set --input FILE\|-` |
| `outline view group set` | patch; idempotent | Set or clear the view grouping field. | `outline view group set TARGET FIELD\|null` |
| `outline view sort add` | create; not idempotent | Append one sort rule to a view. | `outline view sort add TARGET --field FIELD` |
| `outline view sort set` | patch; idempotent | Patch one existing sort rule. | `outline view sort set TARGET --rule ID --field FIELD` |
| `outline view sort remove` | patch; idempotent | Remove one existing sort rule. | `outline view sort remove TARGET --rule ID` |
| `outline view sort clear` | patch; idempotent | Clear all sort rules from a view. | `outline view sort clear TARGET` |
| `outline view filter add` | create; not idempotent | Append one filter rule to a view. | `outline view filter add TARGET --field FIELD` |
| `outline view filter set` | patch; idempotent | Patch one existing filter rule. | `outline view filter set TARGET --rule ID [PATCH OPTIONS]` |
| `outline view filter remove` | patch; idempotent | Remove one existing filter rule. | `outline view filter remove TARGET --rule ID` |
| `outline view filter clear` | patch; idempotent | Clear all filter rules from a view. | `outline view filter clear TARGET` |
| `outline view display add` | create; not idempotent | Append one display field to a view. | `outline view display add TARGET --field FIELD` |
| `outline view display set` | patch; idempotent | Patch one existing display field. | `outline view display set TARGET --display-field ID --value JSON` |
| `outline view display remove` | patch; idempotent | Remove one existing display field. | `outline view display remove TARGET --display-field ID` |
