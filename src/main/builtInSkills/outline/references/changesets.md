# ChangeSets

Read this reference when one user intent changes multiple resources, depends on
IDs created inside the same operation, spans dates, or applies a bounded batch
mutation. A ChangeSet is composition of public generic operations, not a route
to scenario-specific Runtime APIs.

## Authoring Loop

1. Inspect only enough document state to resolve existing targets and bounds.
2. Read the canonical schema with `outline schema ChangeSet` and the exact CLI
   contracts with `outline diff --help` and `outline apply --help`.
3. Write one ChangeSet containing the complete intent.
4. Bind created or ensured resources and refer to those bindings from later
   operations. Do not query intermediate IDs.
5. Request bounded return Projections for created roots or other results the
   caller needs immediately.
6. Produce one immutable Diff, review its hashes, targets, warnings, affected
   count, destructive classification, and returned bindings, then apply that
   exact artifact once.
7. Preserve the Operation and verify representative final state independently.

```sh
outline --json schema ChangeSet > changeset.schema.json
outline --json diff --input changeset.json --output reviewed.diff.json
outline --json apply --input reviewed.diff.json > operation.json
```

Add `--yes` to `apply` only when the reviewed Diff itself is destructive. Never
reconstruct a Diff or substitute `--yes` for review.

## Bindings

Use a unique binding name on a create or ensure operation, then use
`{ "binding": "name" }` wherever a later operation needs that resource. This
supports definitions applied to new and existing Nodes, trees created under
ensured dates, cross-references between newly created Nodes, and view rules
that depend on newly created fields.

Bindings are local to one ChangeSet. They must resolve exactly as required by
the consuming operation. The returned Diff records their concrete IDs, and a
bounded returned Projection exposes the IDs without a follow-up discovery read.

## Selectors and Bounds

Every mutating target declares `one`, `zero-or-one`, or `many`. A `many` target
always includes an explicit `max`; use the smallest honest bound. Review the
Diff's concrete affected targets rather than assuming a query still selects the
same Nodes at apply time.

Use one exact or semantic alias selector for stable system locations. Use the
canonical structured query grammar for general search. Do not turn a Projection
page into a shell loop of individual mutations.

## Operation Boundary

One accepted ChangeSet produces one Operation, including its definitions,
dates, created trees, field/tag/reference changes, view configuration, and
template or lifecycle work. A failure before commit produces no partial
document state. A successful Operation is reverted as one unit with:

```sh
outline --json revert OPERATION_ID
```

If settlement is uncertain, inspect `outline log` by idempotency key or known
Operation ID before any retry.
