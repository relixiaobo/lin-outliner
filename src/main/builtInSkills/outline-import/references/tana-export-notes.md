# Tana Export Notes

The Tana route is deterministic and file-based. It reads a Tana JSON export with
`docs[]`, reconstructs parent/child structure from `_ownerId`, skips system and
Trash subtrees by default, and emits normalized import v1. If `currentWorkspaceId`
points at a Tana workspace metadata node without children, the route falls back
to the `Root node for file:*` document root.

Cleanup rules:

- Decode HTML entities and simple inline spans.
- Preserve `description` as Tenon node description.
- Preserve `_done` as checked state when the selected fidelity allows done
  state.
- Preserve `codeblock` docs as code block rows.
- Recognize a Daily Note only when `_docType` is exactly `journalPart` and its
  decoded title is an actual local calendar date in exact `YYYY-MM-DD` form.
  Merge that container into a date section and preserve its children in Tana's
  explicit source order. Invalid journal dates stay visible in the Tana
  Workspace library section and produce `invalid_journal_date`; do not guess.
- Extract literal `#tag` tokens from titles when tag preservation is enabled.
- Convert tuple children shaped as `[field, value...]` into Tenon fields at Full
  fidelity, merging same-node fields with the same name. Clean fidelity can
  degrade those fields to readable child text. Unparseable tuples remain
  unsupported.
- Treat `metanode`, unparseable `tuple`, `associatedData`, `attrDef`, `viewDef`,
  `search`, workspace, command, and system helper docs as unsupported or dropped
  unless a future adapter revision gives them a user-meaningful Tenon mapping.
- Record every skipped record in coverage.

The route intentionally does not preserve Tana internals for their own sake.
When a structure cannot be mapped confidently, keep the import clean and report a
warning instead of inventing Tenon content.
