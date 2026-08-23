---
name: outline
description: Inspect, edit, organize, import into, or recover the Tenon outline through the public outline CLI. Use for any request that reads or changes Outliner Nodes, fields, tags, references, views, searches, Daily Notes, media, Trash, or operation history.
allowed-tools: bash, file_read, file_glob, file_grep, request_user_input
execution: isolated
---

# Outline

Use the `outline` CLI as the only document access path. Never read workspace
storage, invoke private app APIs, or substitute UI/session state for persisted
document state.

## Workflow

1. Run `outline status` when availability is uncertain. Use `outline --help`,
   `outline --json capabilities`, and `outline --json schema [name]` for the
   current contract.
2. Use `outline find` before mutation when the request does not supply an exact
   selector. Use structured selectors with explicit cardinality; never guess a
   Node from display text.
3. Use one porcelain command for one independent intent. For dependent,
   multi-target, or high-volume work, compose one generic ChangeSet and pass it
   to `outline diff` through stdin or a file. Do not replace composition with a
   shell mutation loop.
4. Preview destructive, ambiguous, or high-volume changes. Inspect the affected
   targets and warnings, then apply the exact returned Diff. When using porcelain,
   bind execution with `--expect-diff <hash>`.
5. Read the Operation result after every write. Preserve and report its
   Operation ID, status, affected count, and recovery state.
6. Verify consequential writes independently with `outline show` or `outline
   find`. On mismatch, stop and use `outline log` plus guarded `outline revert`;
   never issue an unrelated compensating edit.

`outline log` returns `data.operations` and an optional `data.cursor`. Follow
the cursor when complete history or affected IDs are required. A guarded
revert conflict exits as an error without writing; inspect
`error.details.conflictDiff` for the exact changed Node preconditions.

## Canonical Patterns

Read one exact Node:

```sh
outline --json show 'node:example'
```

Discover before editing:

```sh
outline --json find 'Quarterly plan' --limit 20
```

Review and apply one composed ChangeSet:

```sh
outline --json diff --input changeset.json --output diff.json
outline --json apply --input diff.json > operation.json
```

Recover one known Operation:

```sh
outline --json log --operation 'operation:example'
outline --json revert 'operation:example'
```

Use `--json` for machine workflows and explicit output files for large exports.
Stop before writing when selection is unresolved, cardinality is surprising, a
Diff has changed, destructive acknowledgement is missing, or verification
cannot distinguish the intended result.
