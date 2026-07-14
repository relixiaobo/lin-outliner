# Remove the Reference Field Type

## Goal

Remove `reference` from the user-visible and protocol-level `FieldType` model.
References remain a node/value shape: a plain field may contain text nodes,
inline node references, or whole-row reference nodes, while `options` and
`options_from_supertag` keep their existing constrained reference semantics.

This restores the supported field-type set to the Tana-aligned subset already
modeled by Tenon and removes the dedicated reference-field picker and command.

## Non-goals

- Do not remove the `reference` node type, inline node references, backlinks, or
  reference search behavior.
- Do not change computed `References`, `Owner`, or `Day` system fields. Their
  synthetic read-only reference rows remain.
- Do not add Tana Outliner's user field type or broaden the Options source model.
- Do not migrate or retain compatibility for pre-release data whose field
  definition stores `fieldType = reference`. Development userData may be wiped.
- Do not edit main-owned `docs/TASKS.md` or `CHANGELOG.md` in this development PR.

## Shape

This is shape (a): one complete feature in one PR. The field-type contraction,
protocol deletion, renderer cleanup, agent field resolution, tests, and spec
updates must land together so no consumer can create or advertise the removed
type.

## Collision Result

- The only open claim is PR #392 (`codex-2/node-tool-context-compression`). It
  overlaps `src/main/agentNodeTools.ts`, `src/main/agentNodeToolSchemas.ts`,
  `docs/spec/agent-tool-design.md`, `tests/core/agentNodeTools.test.ts`, and
  `tests/core/searchEngine.test.ts`.
- This work must start from `main` after #392 merges. Rebase first, then apply the
  field-model changes to the compressed tool protocol rather than resolving two
  competing versions in parallel.
- `docs/TASKS.md` records the original reference-field work as shipped and the
  structured-field/definition-edit consumers as shipped. No other active plan
  claims the renderer field-value picker or core field command surface.
- Main must add the board entry for this plan before the implementation PR is
  marked ready so `docs:check` remains authoritative.

## Design

### 1. Field types return to the supported Tana-aligned subset

Delete `reference` from `FieldType`, the config enum domain, renderer metadata,
field icons, agent definition schemas, and every field-type switch. The supported
set becomes:

```ts
type FieldType =
  | 'plain'
  | 'options'
  | 'options_from_supertag'
  | 'date'
  | 'number'
  | 'url'
  | 'email'
  | 'checkbox';
```

No legacy parser, migration, hidden enum option, or retired-type compatibility
branch is added for `reference`.

### 2. References are field values, not a field type

A `plain` field keeps the normal outliner editor. Typing `@` uses the existing
reference trigger:

- an otherwise empty value becomes a whole-row `reference` child of the field
  entry;
- a reference inside text becomes an inline reference in a plain value node;
- ordinary text remains an ordinary plain value node.

Whole-row values use the generic reference command path (`add_reference` /
`add_reference_conversion`), which already accepts a field entry as the parent
and enforces normal duplicate/cycle rules. Field-value deletion continues through
`remove_field_value` because routing is based on the value's parent, not on the
field type.

`options` continues to reference members of its option pool.
`options_from_supertag` continues to reference nodes carrying its configured
supertag. Scalar typed fields keep their existing validation behavior.

### 3. Delete the reference-field-only protocol and renderer

Remove `add_field_reference` from the command list, core, document service, and
renderer API. Delete `ensureReferenceFieldDef`, `referencePicker`,
`TrailingReferencePopover`, its placeholder messages, and the special draft
branches in `FieldValueOutliner` / `OutlinerItem`.

The general `@` reference popover and reference-row rendering remain. The field
configuration UI no longer offers Reference, and no dead icon or localized label
remains.

### 4. Agent field resolution uses plain reference-valued fields

For semantic outline writes:

- all-reference values infer `plain`, not a new field type;
- `plain` validation accepts text values, node-reference values, or a mixture;
- appending a node-reference value to a plain field uses generic
  `add_reference` under the field entry;
- existing `options` and `options_from_supertag` validation and append paths stay
  unchanged;
- scalar field types continue rejecting node-reference values;
- field definition create/edit schemas reject `reference` as an unsupported
  type.

Serialization remains structural: a whole-row reference field value still
serializes as `[[node:Display^id]]`. `LINKS_TO`, backlinks, reference counts, and
reference-authority ranking continue to count it because those systems inspect
the reference node and its owning field entry, not `FieldType.reference`.

### 5. Remove obsolete tests and preserve behavioral coverage

Delete tests that exist only for the direct-on-focus reference-field picker or
the dedicated command. Replace them with focused coverage proving:

- Reference is absent from field configuration and agent definition schemas.
- A plain field accepts a whole-row `@` reference and an inline reference.
- Agent-created reference-only and mixed-value fields are `plain` and persist
  generic reference children correctly.
- Generic reference values under plain fields still participate in `LINKS_TO`,
  backlinks, reference counts, and field-value deletion.
- `options` and `options_from_supertag` reference semantics remain unchanged.
- Computed References / Owner / Day rows remain read-only reference rows.

### 6. Keep specs aligned with the value model

Update `docs/spec/ui-behavior.md`, `docs/spec/commands.md`,
`docs/spec/agent-tool-design.md`, and any search/reference wording that calls a
value a "reference field value." Use "reference-valued field child" or "reference
value under a plain/options field" where the distinction matters.

The archived original plan remains historical evidence and is not rewritten.

## Expected File Scope

- Shared/core protocol: `src/core/types.ts`, `src/core/commands.ts`,
  `src/core/configSchema.ts`, `src/core/core.ts`, `src/core/fieldResolution.ts`.
- Main/agent bridge: `src/main/documentService.ts`,
  `src/main/agentNodeToolSchemas.ts`, `src/main/agentNodeTools.ts`.
- Renderer: `src/renderer/api/client.ts`, field registry/presentation/editor
  modules, `FieldValueOutliner.tsx`, `OutlinerItem.tsx`, and deletion of
  `TrailingReferencePopover.tsx`.
- Messages/specs: reference-field-only i18n entries and the current behavior/
  command/agent/search specs.
- Tests: focused core, renderer, and E2E field/reference suites plus the shared
  E2E mock.

## Risks

- Over-deleting `reference` checks could damage the node type or computed system
  reference rows. Every removal must be qualified as field-type-only.
- PR #392 changes the same agent/search files. Implementing before it merges
  would create avoidable semantic conflicts and stale test expectations.
- Plain field reference entry currently shares the general trigger machinery;
  E2E coverage must prove both whole-row and inline paths before removing the
  dedicated picker.
- Agent field type changes can silently affect serialization and search. The
  reference graph assertions must remain green with `plain` field definitions.

## Acceptance Criteria

- No product code, public schema, command, UI option, or current spec contains a
  `reference` field type or `add_field_reference`.
- `node.type = reference` and inline references remain fully supported.
- Plain fields can contain text and references through the normal outliner `@`
  interaction and through agent outline writes.
- Reference-valued plain fields retain navigation, expansion, deletion,
  backlinks, `LINKS_TO`, and reference-count behavior.
- Options-based reference fields retain their existing constraints.
- No compatibility or migration code is introduced for pre-release reference
  field definitions.
- `bun run typecheck`, `bun run test:core`, `bun run test:renderer`, focused
  Playwright field/reference tests, `bun run docs:check`, and `git diff --check`
  pass on the final branch.

## Open Questions

None after the PM ratifies the value-model decision and confirms that this PR is
ordered after #392.
