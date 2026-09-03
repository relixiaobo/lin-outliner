---
name: outline
description: Read, create, edit, organize, present, import, or recover persisted Tenon outline data through the public outline CLI. Use for Nodes, fields, tags, references, Views, Saved Searches, Daily Notes, media, Trash, or Operation history.
---

# Outline

Use `outline` through Bash as the only persisted document interface. Invoke it
directly. For `--input -`, pass JSON through Bash's separate `stdin` field; do
not construct temporary files, pipelines, loops, or helper programs.

## Model

- A **Node** is the only content and tree identity. A table row, card, calendar
  item, and outline item are the same Node under different Views.
- A **Field** is a reusable typed definition; each value belongs to a Node.
  Request-local field keys connect declarations, values, and View display only.
- A **View** projects Nodes as `outline`, `table`, `cards`, or `calendar`
  without converting or copying data. Every scope has an effective Outline View
  even when no explicit View is persisted.
- An **Operation** is the atomic settlement and recovery unit. One intent should
  create at most one Operation; rejected input creates none.

## Route

Use the narrowest semantic command:

| Intent | Command |
| --- | --- |
| Read an exact target | `outline get TARGET` |
| Discover or count | `outline find ...` |
| Create a complete Node tree and optional View | `outline create ...` |
| Converge Node content, metadata, tags, fields, or references | `outline edit ...` |
| Reorganize Nodes | `outline move`, `outline duplicate`, or `outline merge` |
| Create or update reusable definitions | `outline define create|ensure|edit` |
| Read or replace presentation | `outline view get|set` |
| Create, edit, or run a Saved Search | `outline search create|edit|run` |
| Ensure a Daily Note or use Trash | `outline daily ensure`, `outline trash`, or `outline restore` |
| Permanently destructive semantic work | the same semantic command with `--preview`, then `--expect-diff` |
| Multi-resource work with dependencies | `outline transact --input -` |
| Recover | `outline history`, `outline revert`, `outline undo`, or `outline redo` |

Use exact IDs or stable locators such as `@inbox`, `@library`, `@today`, and
`@date:YYYY-MM-DD`. Use one bounded `find` before a write only when identity is
not already known. A structured many-target request must include an explicit
`max`. Exact `get` returns the Node description and logical Field values by
default; do not traverse storage children to read Fields.

Use these common forms directly, without help or example discovery:

```text
outline get TARGET
outline find "TEXT" --limit N
outline create PARENT "TEXT"
outline edit TARGET --description "TEXT" --done true
outline move TARGET PARENT --last
outline duplicate TARGET PARENT
outline view set TARGET MODE
outline search create --title "TITLE" --match "TEXT" --view table
outline search edit TARGET --title "TITLE" --match "TEXT" --view cards
outline daily ensure YYYY-MM-DD
outline trash TARGET
outline restore TARGET
outline history OPERATION_ID
outline revert OPERATION_ID
outline export TARGET --format markdown --output FILE
outline merge SOURCE TARGET --preview --idempotency-key KEY
outline merge SOURCE TARGET --expect-diff SHA256 --yes --idempotency-key KEY
outline purge TARGET --preview --idempotency-key KEY
outline purge TARGET --expect-diff SHA256 --yes --idempotency-key KEY
```

View `MODE` is `outline`, `table`, `cards`, or `calendar`.
Do not read the current View before a fully specified `view set` on an exact
target; the command converges presentation without changing scoped Nodes.
Run `daily ensure` directly without a pre-read. When the intent applies one
change to every query match, do not find or enumerate IDs first; use `outline
example edit bounded-query`, then one bounded `outline edit --input -`.

## Common Create

Create plain, nested, field-backed, and View-backed content with the same shape:

```json
{
  "at": {
    "parent": "@today",
    "position": "first"
  },
  "fields": [
    {
      "key": "weather",
      "name": "Weather",
      "type": "text"
    },
    {
      "key": "low",
      "name": "Night low (C)",
      "type": "number"
    }
  ],
  "node": {
    "text": "Chengdu district weather",
    "description": "Sunny throughout.",
    "children": [
      {
        "text": "Central districts",
        "fields": {
          "weather": "Sunny",
          "low": 21
        }
      }
    ]
  },
  "view": {
    "mode": "table",
    "display": [
      "weather",
      "low"
    ]
  }
}
```

Run it once with `outline create --input -`. Public Field types are `text`,
`select`, `select-from-tag`, `date`, `number`, `url`, `email`, and
`checkbox`. Definitions are reused automatically only when same-name explicit
constraints are compatible; a mismatch returns the existing definition ID and
differences without writing. Do not look up or manually reuse field IDs after a
compatible success.

Keep collection-wide summaries on the owner Node's `description`; direct
children are the actual items projected as rows, cards, or calendar entries.

A successful semantic mutation receipt is derived from committed state and
contains the Operation ID, result handles, verification result, and recovery
command. Treat it as completion proof. Do not issue a separate verification
read unless the user asks to inspect content not covered by the receipt.
An export receipt already proves its path, byte count, and SHA-256; do not
reread or hash the file unless the user asks to inspect its contents.

## Disclosure And Recovery

When the task fits the Common Create shape above, run it directly; that example
is already validated. For a structured form not represented here, request one
matching example such as `outline example edit complete` or `outline example
search create`. Use `outline COMMAND
--help` only when neither the entrypoint nor an example covers the task. Use
`outline schema COMMAND` only to build an integration or diagnose a concrete
validation failure; never dump a schema speculatively.

If validation fails, follow the returned path and corrective command once. Do
not search broadly or inspect the full schema when the error already identifies
the invalid property and accepted vocabulary.

Use `transact` only when one intent spans dependent resources; start with
`outline example transact dependent-change` and bind resources inside its
ChangeSet instead of querying intermediate IDs. For destructive or
explicitly reviewed semantic work (`replace text`, `merge`, or `purge`), run the
same command first with `--preview --idempotency-key KEY`, inspect its Diff, then
once with `--expect-diff SHA256 --yes --idempotency-key KEY`. For an advanced
ChangeSet, persist one immutable Diff with `outline preview`, inspect it, then
`outline apply` that exact artifact once. Never approximate a reviewed change
or substitute an unreviewed compensating mutation.

If settlement is unknown, do not retry the write. Run the exact
`outline history --idempotency-key KEY` command from the failure receipt. Revert
only a known completed Operation.

For a normalized external dataset, use these exact stages:

```text
outline import inspect SOURCE
outline import plan SOURCE --format normalized --output DIFF --evidence-output EVIDENCE
outline apply --input DIFF
outline import verify OPERATION_ID --diff DIFF --evidence EVIDENCE
```

Use `asset ingest|get|export` for retained bytes and `capture create` for
provenanced captures.

In the final response, link an ordinary persisted `node:UUID` as
`[[node://UUID]]`, omitting the internal `node:` prefix.
