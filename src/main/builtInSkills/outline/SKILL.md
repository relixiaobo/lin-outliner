---
name: outline
description: Inspect, edit, organize, import into, or recover the Tenon outline through the public outline CLI. Use for any request that reads or changes Outliner Nodes, fields, tags, references, views, searches, Daily Notes, media, Trash, or operation history.
---

# Outline

Use the `outline` CLI as the only document access path. Never read workspace
storage, call private app APIs, or substitute UI state for persisted document
state.

## Start Every Task

Run `outline status` only when availability is uncertain. Use
`outline --help` for the family map, `outline FAMILY --help` for its commands,
and `outline COMMAND --help` for an exact command contract. Help is plain text
even with `--json` and never starts Runtime.

Read [references/commands.md](references/commands.md) when the command choice is
not already obvious, the request crosses command families, or a complete view
of the public capability surface is useful. Use `outline schema COMMAND` for
exact structured input and output schemas; never guess an option or invent a
query language.

## Inspect Current State

Use `outline show` for a known exact selector and `outline find` for discovery.
Use exact IDs or stable aliases such as `@inbox`, `@library`,
`@saved-searches`, `@today`, and `@date:YYYY-MM-DD`. Never select a Node from
display text without a bounded read that proves the target.

Read only the smallest Projection needed to decide and later verify the work.
Common text search uses positional text or `search create --match`; advanced
search uses the canonical structured query through `--query` or `--input`.
Read its executable operators and exact operands from
`outline schema QueryExpression`; operators absent from that schema are not
public even if they exist in internal document data.

## Choose One Mutation Shape

| Intent | Use |
|---|---|
| Create one complete resource | One porcelain `create` or `add` invocation |
| Supply complex state for that resource | The same command with `--input FILE|-` |
| Patch one resource | One declared patch or leaf-edit command |
| Configure a complete search or view | One convergent `set` command |
| Change multiple resources or dependencies | One ChangeSet with bindings |
| Perform a bounded bulk mutation | One bounded selector or one ChangeSet |
| Replace literal text across bounded Nodes | One reviewed `text replace` invocation |
| Import external data | The public import workflow |

Create and add forms explicitly create. Patch forms preserve omitted
properties. Only an explicitly documented replacement form replaces a
collection. Repeated `set`, `configure`, and `ensure` calls must converge or
return semantic no-change.

For multiple resources, bindings, cross-date work, or general batch mutation,
read [references/changesets.md](references/changesets.md). Never use a shell
mutation loop, query intermediate created IDs, or split one atomic intent into
several writes. Every structured `many` mutation has an explicit `max` bound.

For external notes, exports, migrations, or cleanup-before-import, read
[references/import.md](references/import.md). Import is an Outline workflow,
not a separate Skill or Runtime API.

## Model Common Structures

Model a table as one owner Node with a table view, reusable field definitions,
and one direct child Node per row. Store cells as field values and configure the
visible display fields, grouping, and sort on the owner. Create definitions,
owner, rows, values, and view together in one ChangeSet when they form one user
intent. Never substitute a Markdown table or aligned plain text for document
table state.

Date field values use `YYYY-MM-DD`, `YYYY-MM-DDTHH:mm`, or `start/end` with `/`.
Use exact local-date selectors for Daily Notes; do not apply timezone conversion
to a local calendar date. In the final response, mention persisted Nodes as
`[[node:^exact-id]]` so the client resolves the current title.

## Review and Execute

Preview destructive, ambiguous, or high-impact work. Inspect exact targets,
warnings, and affected count before applying the reviewed Diff. Destructive
porcelain requires `--preview --idempotency-key KEY`, followed by the same
command with the same key plus `--expect-diff SHA256 --yes`; changing the key
changes the Diff hash, and `--yes` alone is invalid. Direct ChangeSets use one
`diff` artifact and one exact `apply`.

Use `--idempotency-key` for transport retry identity, but never treat it as
permission to repeat an uncertain write. Do not retry when command settlement
is unknown.

## Verify the Result

Every successful write returns one Operation or semantic no-change result.
Preserve and report its Operation ID, status, affected count, returned created
or bound IDs, and recovery state. Verify consequential work independently with
a bounded `show` or `find`; successful command dispatch alone is not proof of
the intended document state.

## Recover Safely

On a mismatch or uncertain result, stop writing and inspect `outline log`.
Follow its cursor when complete affected IDs or history are required. Revert a
known completed Operation with `outline revert OPERATION_ID`; never issue an
unrelated compensating edit. A guarded revert conflict writes nothing and
returns the exact changed preconditions in `error.details.conflictDiff`.

Stop before writing when selection is unresolved, cardinality is surprising,
the reviewed Diff changed, destructive acknowledgement is incomplete, or
verification cannot distinguish the intended result.
