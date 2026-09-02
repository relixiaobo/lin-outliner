---
name: outline
description: Inspect, edit, organize, import into, or recover the Tenon outline through the public outline CLI. Use for persisted Outliner Nodes, fields, tags, references, views, searches, Daily Notes, media, Trash, or operation history.
---

# Outline

Use `outline` through Bash as the only persisted document interface. Execute it
directly: no shell pipeline, heredoc, loop, command substitution, temporary input
file, helper program, or private storage/API access. For `--input -`, send the
complete JSON through Bash's separate `stdin` field.

Default output is the bounded Agent receipt. Use `--json` only when the user asks
for a machine contract or raw records. Do not repeat a successful command solely
to recover an identifier: its receipt contains the next-step handles.

## Route The Intent

Choose the first matching shape:

| Intent | Command shape |
| --- | --- |
| Read a known target | `outline show TARGET` |
| Discover or count | `outline find ...` |
| Inspect a persisted view | `outline view inspect OWNER_ID` |
| Create or patch one resource | One porcelain command |
| Create one resource with structured state | The same porcelain command with `--input -` |
| Change dependent resources together | One `outline commit --input -` ChangeSet |
| Review destructive or high-impact work | `outline diff --output FILE`, then exact `outline apply FILE` |
| Inspect or recover history | `outline log ...` / `outline revert OPERATION_ID` |
| Import external data | `import inspect`, `import plan`, exact `apply`, then `import verify` |

Use exact IDs and stable locators such as `@inbox`, `@library`,
`@saved-searches`, `@today`, and `@date:YYYY-MM-DD`. Never infer identity from
display text without a bounded read. Exact structured targets are locator
strings; only genuinely bulk-capable inputs accept a bounded TargetSpec with an
explicit `max`.

For an unfamiliar structured shape, run exactly one matching recipe command,
for example `outline example add viewed-tree`, `outline example find
named-counts`, or `outline example commit dependent-change`. Use `outline
COMMAND --help` only when no recipe or obvious argv form covers the intent.
`outline schema` is an integration/debugging surface, not the normal discovery
path.

## Native Collections

A table, list, cards view, or calendar is one ordinary owner Node with direct
ordinary child items, field-backed values, and persisted view configuration. Do
not substitute Markdown or aligned text.

Create a complete collection atomically with `outline add --input -`, then use
the returned owner ID in one `outline view inspect OWNER_ID` verification:

```json
{
  "kind": "viewed-tree",
  "placement": { "kind": "first", "parent": "@today" },
  "title": "Prices",
  "fields": [
    { "key": "price", "name": "Price", "config": { "fieldType": "number" } }
  ],
  "items": [
    { "content": "Item A", "values": { "price": 12 } }
  ],
  "view": { "mode": "table" }
}
```

Field keys are local stable names shared by `fields`, item `values`, and view
configuration. Reused fields use an exact locator. System fields use canonical
`sys:*` names. Date values use `YYYY-MM-DD`, `YYYY-MM-DDTHH:mm`, or
`start/end`; Daily Note dates are local calendar dates with no timezone
conversion.

## Mutate, Review, Verify

Prefer one complete porcelain invocation. Use a ChangeSet only when one intent
has dependencies or spans independently addressable resources. Bind resources
created or ensured inside a ChangeSet and consume those bindings later; never
query intermediate IDs or issue a shell mutation loop.

Use direct `commit` for a known non-destructive ChangeSet. For destructive,
conversion, ambiguous-target, high-impact, or explicitly reviewed work, persist
one immutable Diff, review its hashes/effects/destructive classes/bindings and
warnings, then apply that exact artifact once. Destructive porcelain uses
`--preview --idempotency-key KEY`, followed by the same command and key with
`--expect-diff SHA256 --yes`; `--yes` alone is invalid.

After consequential writes, verify independently with one bounded `show`,
`find`, or `view inspect`. Dispatch is not final-state proof. Stop when target
selection, bounds, coverage, review, or verification is unresolved.

If settlement is unknown, do not write again. Run the exact `outline log
--idempotency-key ...` command from the failure receipt. Revert only a known
completed Operation with `outline revert OPERATION_ID`; never invent a
compensating edit.

For imports, profile the authorized source with `outline import inspect SOURCE`,
then create a reviewed Diff and evidence with `outline import plan SOURCE
--output import.diff.json --evidence-output import.evidence.json`. Apply the
exact Diff once and run `outline import verify OPERATION_ID --diff
import.diff.json --evidence import.evidence.json`. Every source record must be
accounted as imported, merged, dropped, unsupported, or empty; unaccounted must
be zero.

In the final response, reference an ordinary persisted `node:UUID` as
`[[node://UUID]]`, removing the internal `node:` prefix.
