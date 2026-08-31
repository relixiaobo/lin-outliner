---
name: outline
description: Inspect, edit, organize, import into, or recover the Tenon outline through the public outline CLI. Use for any request that reads or changes Outliner Nodes, fields, tags, references, views, searches, Daily Notes, media, Trash, or operation history.
---

# Outline

Use the `outline` CLI as the only document access path. Never read workspace
storage, call private app APIs, or substitute UI state for persisted document
state. Through Bash, execute `outline` directly. Do not wrap it in a shell
pipeline, heredoc, loop, command substitution, or helper program. For
`--input -`, put the complete JSON payload in Bash's separate `stdin` field.

## Start Every Task

Load this Skill once, then choose the narrowest public command. Run
`outline status` only when availability is uncertain. If the command is not
already clear, read [references/commands.md](references/commands.md) or run
exact family/command help. Read only `outline schema COMMAND` for a structured
form you actually need. Do not load root help, the aggregate ChangeSet schema,
or a fixture for ordinary work.

Use `--human` for output the current model must read. Use `--json` only when an
exact machine contract is explicitly required. Never use Python, Node, `jq`,
`sed`, `grep`, temporary input files, or file tools to assemble or interpret an
Outline operation.

## Inspect Current State

Use `outline --human show` for a known exact target and `outline --human find`
for discovery. Prefer exact IDs and stable aliases such as `@inbox`, `@library`,
`@saved-searches`, `@today`, and `@date:YYYY-MM-DD`. Never select from display
text without one bounded read proving the target. Read only the smallest
Projection needed to decide the mutation.

Use `outline --human view inspect TARGET` to verify persisted view mode, exact
direct-item count, and ordered display configuration. Do not fetch a complete
table or parse generic descendant projections for view verification.

## Choose One Mutation Shape

| Intent | Use |
|---|---|
| Create one complete resource | One porcelain `create` or `add` invocation |
| Supply complex state for that resource | The same command with `--input -` |
| Patch one resource | One declared patch or leaf-edit command |
| Configure a complete search or view | One convergent `set` command |
| Change multiple resources or dependencies | One ChangeSet with bindings |
| Perform a bounded bulk mutation | One bounded selector or one ChangeSet |
| Replace literal text across bounded Nodes | One reviewed `text replace` invocation |
| Import external data | The public import workflow |

Always try porcelain first. Use a generic ChangeSet only when one intent spans
multiple independently addressable resources or dependencies that porcelain
cannot express. Never use a shell mutation loop, query intermediate created
IDs, or split one atomic intent into several writes. Every structured `many`
mutation has an explicit `max` bound.

Create and add forms explicitly create. Patch forms preserve omitted
properties. Only a documented replacement form replaces a collection.
Repeated `set`, `configure`, and `ensure` calls must converge or return
semantic no-change.

For a known non-destructive ChangeSet, use `outline --human commit --input -`
directly. Use `diff --output` followed by exact `apply` for destructive work,
ambiguous target effects, conversion of existing content, high-impact changes,
or when the user requests review. Read
[references/changesets.md](references/changesets.md) only for that generic path.
For external imports, read [references/import.md](references/import.md).

## Model Common Structures

Model a view-backed collection as one ordinary owner Node, reusable field
definitions, and one direct ordinary child Node per item. Store values in
fields and configure the complete view on the owner. Never substitute a
Markdown table or aligned text for native table state.

For a new table, list, cards view, or calendar view below one exact destination,
run one `outline --human add --input -` with `kind: "viewed-tree"`. Declare
local fields once with stable `key` values, reference them from item `values`
and view configuration as `{ "fieldKey": "key" }`, and use canonical `sys:*`
names for system fields. The CLI creates definitions, owner, ordinary items,
field values, and view atomically. Then verify with one
`outline --human view inspect OWNER_ID`.

Date field values use `YYYY-MM-DD`, `YYYY-MM-DDTHH:mm`, or `start/end` with `/`.
Use exact local-date selectors for Daily Notes; do not apply timezone conversion
to a local calendar date. In the final response, mention an ordinary persisted
`node:UUID` as `[[node://UUID]]`, removing the internal `node:` prefix.

## Review and Execute

`diff --output FILE` writes the exact immutable Diff and prints a bounded human
review receipt. Review its hashes, base revision, effects, destructive classes,
bindings, warnings, and any omission count. Stop or narrow the work if a
review-critical tail is omitted. Pass the exact artifact to `apply`; never
reconstruct it.

Destructive porcelain requires `--preview --idempotency-key KEY`, followed by
the same command and key with `--expect-diff SHA256 --yes`. `--yes` alone is
invalid. Never treat an idempotency key as permission to repeat an uncertain
write.

## Verify and Recover Safely

Every successful write returns one bounded receipt with its Operation ID,
revision transition, affected count/digest, returned root IDs, and recovery
state. Verify consequential work independently with one bounded `show`, `find`,
or `view inspect`; dispatch alone is not proof of final state.

If settlement is unknown, stop writing and inspect `outline --human log` by the
same idempotency key. Do not retry with a new key. Revert a known completed
Operation with `outline --human revert OPERATION_ID`; never issue an unrelated
compensating edit. Stop before writing when selection is unresolved,
cardinality is surprising, the reviewed Diff changed, acknowledgement is
incomplete, or verification cannot distinguish the intended result.
