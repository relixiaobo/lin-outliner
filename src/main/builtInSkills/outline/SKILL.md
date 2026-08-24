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

1. Run `outline status` when availability is uncertain. Discover from
   `outline --help`, `outline FAMILY --help`, and `outline COMMAND --help`; use
   `outline --json capabilities` and `outline schema COMMAND` for exact machine
   contracts. Help is plain text even with `--json` and never starts Runtime.
2. Select the narrowest complete mutation shape:
   - one complete resource intent -> one porcelain invocation;
   - complex state for that same resource -> the same command with
     `--input FILE|-`;
   - multiple resources, dependencies, cross-date work, or a bounded bulk edit
     -> one ChangeSet with bindings, then one `diff` and one `apply`.
   Never use a shell mutation loop, query intermediate created IDs, or split one
   atomic intent into several writes.
3. Use `outline show` for an exact selector and `outline find` when discovery is
   needed. Common text search uses positional text or `search create --match`;
   advanced search uses the canonical structured query through `--query` or
   `--input`. Never invent another query language or guess a Node from display
   text.
4. Use exact IDs and stable aliases such as `@inbox`, `@library`,
   `@saved-searches`, `@today`, or `@date:YYYY-MM-DD`. Structured selectors must
   declare `one`, `zero-or-one`, or `many`; every `many` mutation has an explicit
   `max` bound.
5. Treat verbs by their declared help semantics. `create`/`add` explicitly
   creates. Patch forms preserve omitted properties. Only an explicitly named
   replacement form such as `--replace` replaces a collection. Repeated
   `set`/`configure`/`ensure` calls must converge or return semantic no-change;
   use `--idempotency-key` for transport retries.
6. Preview destructive, ambiguous, or high-volume changes. Inspect targets,
   warnings, and affected count, then apply the exact Diff. Destructive
   porcelain requires the same command with `--expect-diff <hash> --yes`;
   `--yes` alone is invalid. Direct ChangeSets use the exact Diff artifact with
   `outline apply`.
7. Read the Operation result after every write. Preserve and report its
   Operation ID, status, affected count, and recovery state.
8. Verify consequential writes independently with `outline show` or `outline
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

Create one complete resource with common argv shorthand:

```sh
outline --json search create --title 'Modules' --match 'module' \
  --view table --sort sys:updatedAt:desc
```

Create complex state for that same resource:

```sh
outline --json add --input complete-tree.json
```

Review and apply one composed ChangeSet:

```sh
outline --json diff --input changeset.json --output diff.json
outline --json apply --input diff.json > operation.json
```

Use one-invocation date capture or local media creation:

```sh
outline --json capture add --date 2026-08-24 --title 'Reading note' \
  --metadata provenance.json
outline --json media add @inbox image ./diagram.png
```

Recover one known Operation:

```sh
outline --json log --operation 'operation:example'
outline --json revert 'operation:example'
```

Use `--json` for machine workflows and explicit output files for large exports.
Use `add`, `definition create`, `field define`, `search create`, `capture add`,
or `media add` to create complete resources; use `set`, `search set`, or `view
set` for declarative updates and the leaf view commands for small edits. Use
`trash` for reversible deletion and reviewed `purge` only for permanent removal.
Stop before writing when selection is unresolved, cardinality is surprising, a
Diff has changed, destructive acknowledgement is missing, or verification
cannot distinguish the intended result.
