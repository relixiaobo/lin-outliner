# Structured Field Resolution

## Goal

Make structured field writes deterministic, typed, and reusable across every
semantic write path. When an outline says `Field:: value`, Tenon should not blindly
mint a new plain-text field. It should resolve the field against the document's
existing structure, preserve the field's type when it already exists, infer a
safe type only for genuinely new field definitions, and reject ambiguous writes
before they create duplicate field rows.

The user-visible bug this fixes is agent-authored data such as repeated `xmlUrl`
field rows, all backed by fresh plain field definitions even when the document
already has an appropriate field or the value clearly has a URL/date/number/ref
shape.

## Non-goals

- No broad redesign of field UI. The field-name reuse popover can stay as the
  manual UX; this plan moves the write-time invariant below the UI so tools,
  paste, import, and agent edits cannot drift.
- No automatic global migration of dirty historical data. Existing duplicate
  fields should be surfaced with ids and cleaned by explicit merge/delete actions,
  not silently rewritten.
- No heuristic `options` inference from arbitrary words such as `Status:: Active`.
  Options fields are reused when a matching existing `fieldDef` is already
  `options` / `options_from_supertag`; newly-created fields infer only from
  low-risk scalar shapes.
- No protocol-surface addition. This should reuse existing commands and outline
  syntax unless implementation proves a small explicit type annotation is needed.
- No changes to `docs/TASKS.md` or `CHANGELOG.md` from this dev clone; those files
  are main-agent-owned.

## Shape

This is shape (a): one complete feature in one PR. The resolver, core guard,
agent integration, tests, and spec update must land together. Splitting it into
"agent only" and "core later" would leave the same class of bug available through
another write path.

## Collision Result

- `gh pr list` currently shows draft PR #383 and #384, both touching only
  `docs/plans/*`; neither overlaps this implementation/spec/test scope.
- `docs/TASKS.md` records the related `field-name-reuse` and
  `node-edit-orthogonal-primitives` work as shipped. No active item currently
  claims this surface.
- Relevant existing behavior:
  - UI reuse candidates exclude fields already present on the same owner, but only
    inside the renderer interaction.
  - `node_edit` upserts by field display name when exactly one matching entry
    exists.
  - `node_create` currently creates field entries through `create_inline_field`,
    which creates a new plain `fieldDef` every time.
- Planned file scope:
  - Core / shared resolver: `src/core/fieldResolution.ts` or equivalent.
  - Core guard and low-level commands: `src/core/core.ts`.
  - Agent outline application: `src/main/agentNodeTools.ts`.
  - Main command bridge only if a new internal helper command becomes necessary:
    `src/main/documentService.ts`.
  - Specs/tests: `docs/spec/agent-tool-design.md`,
    `tests/core/agentNodeTools.test.ts`, `tests/core/core.test.ts`, and focused
    renderer tests only if UI behavior changes.
- This plan intentionally does not edit `docs/TASKS.md`. Because `docs:check`
  requires every active plan to be linked from the board, the main/PM follow-up is
  to add a board entry for this file before marking an implementation PR ready.

## Design

### 1. Field identity rule

For semantic field writes, a node may not carry two active field entries with the
same normalized display name.

Normalization:

- trim leading/trailing whitespace
- case-fold with locale-insensitive lowercase
- collapse internal whitespace for matching only
- ignore trashed field entries and trashed field definitions
- empty field names are draft-only and are not resolved by name

If an owner already has duplicate active field entries for the same normalized
name, the write fails closed with the duplicate entry ids and a cleanup
instruction. It must not create a third entry.

### 2. Shared resolver

Introduce one shared resolver used by all outline/metadata write paths:

```ts
resolveFieldWriteTarget(index, ownerId, fieldName, values): FieldWriteTarget
```

Resolution order:

1. **Existing entry on owner** — if the owner has exactly one active field entry
   with the normalized display name, write values into that entry.
2. **Writable system field** — match system field labels and ids such as `Done`
   / `sys:done`. Writable system fields route to their owner-native scalar
   command instead of storing value children. Read-only system fields reject with
   guidance to use the real syntax (`#tag`, references, date parent, etc.).
3. **Existing user field definition** — if the document has exactly one active
   `fieldDef` with the normalized display name, create an entry that reuses that
   definition and therefore preserves its field type/config.
4. **New inferred field definition** — only when no existing entry/definition
   exists, create one new field definition using conservative type inference.

Ambiguity rules:

- Multiple active owner entries with the same name: error.
- Multiple active field definitions with the same name and no owner entry:
  error.
- Existing field type incompatible with the supplied value kind: error before
  mutation, with the field entry/definition id in the message.

### 3. Type inference for new fields

Inference only applies when creating a brand-new `fieldDef`.

Conservative defaults:

- all values are node references -> `reference`
- all non-empty values parse as canonical date field values -> `date`
- all non-empty values are finite numbers -> `number`
- all non-empty values are URLs -> `url`
- all non-empty values are email addresses -> `email`
- all non-empty values are boolean tokens (`true`, `false`) -> `checkbox`
- otherwise -> `plain`

Do not infer `options` or `options_from_supertag`. Those types depend on option
source semantics, not just current value shape.

For existing field definitions, the stored `fieldType` wins. A field named
`xmlUrl` that already exists as `url` stays `url`; a field named `Status` that
already exists as `options` stays `options`; a field named `Status` with no
definition and value `失效` becomes `plain` rather than guessing an option set.

### 4. Core write guard

Move the duplicate prevention below renderer/tool code:

- `createInlineField` must not create a non-empty field name that duplicates an
  active field already present on the same owner. It can either reuse the
  resolver target or reject; the implementation should choose the path that keeps
  undo/focus behavior least surprising.
- Field-definition rename via `apply_node_text_patch` must not make any owner
  that uses the renamed definition contain two same-name active fields. This is
  the guard that keeps manual UI edits from bypassing the invariant.
- `reuseFieldDefinition` must keep its current "relink, then remove orphan draft"
  behavior, but reject relinking when the target definition is already present on
  the owner under the same normalized name.

Draft empty fields remain allowed because the `>` trigger creates an empty entry
before the user chooses or types a name. The invariant applies when a non-empty
name is committed or when semantic write code resolves a field by name.

### 5. Agent tool integration

`node_create` and `node_edit` should call the same resolver for every
`OutlineField`.

Behavioral changes:

- `node_create` under an existing parent can add a field to that parent without
  minting a duplicate if the field already exists.
- `node_create` for a new node still works with tag-template/default fields: the
  resolver first sees materialized entries on the new node and writes into them.
- `node_edit` keeps non-pruning semantics. Omitted fields/values are preserved;
  unmarked fields upsert by resolver; annotated field/value ids still target
  exact existing rows.
- The result payload should distinguish created vs reused/matched fields:
  `createdFieldEntryIds`, `createdFieldDefIds`, `matchedNodeIds`, and warnings
  should make the resolver's decision visible to the model.

System field behavior:

- `Done:: true` / `Done:: false` resolves to `sys:done` and writes the owner's
  completion state, not a child value under a system field entry.
- Read-only system fields (`Created`, `Last edited`, `Tags`, `References`,
  `Owner`, `Day`) reject writes. The error explains the supported alternative
  where one exists.
- Command schedule remains command-node-specific; only support it here if the
  current command-node spec already exposes a writable outline form.

### 6. Paste/import reuse

Audit every structured metadata write path that converts parsed fields into
field entries:

- agent `node_create` / `node_edit`
- paste metadata extraction (`field:: value`)
- data import helpers / built-in import skill paths that materialize fields
- any launcher/capture path that writes visible user fields

Each path should either call the shared resolver directly or use a core helper
that calls it. If a path intentionally creates a brand-new draft field regardless
of name, document that as a UI-only creation primitive and keep it out of
semantic metadata writes.

### 7. Spec sync

Update `docs/spec/agent-tool-design.md`:

- Field syntax resolves before creation.
- Existing owner entries and field definitions are reused.
- Field types are preserved from existing definitions.
- New-field type inference is conservative and does not infer options.
- Duplicate owner entries / duplicate matching definitions are ambiguous errors.
- Writable vs read-only system-field behavior is explicit.

If paste/import specs already document `field:: value`, update the relevant spec
in the same PR.

## Acceptance Criteria

- Agent-created `xmlUrl:: https://example.com/feed.xml` creates one `url` field
  definition when no field exists, then reuses it on later nodes.
- If `xmlUrl` already exists as a `url` field, agent writes reuse that definition
  and do not create another `fieldDef`.
- If an owner already has `xmlUrl`, a second agent write appends/updates values
  on that field entry instead of adding a sibling `xmlUrl` entry.
- Existing typed definitions win over inference: existing `Status` as `options`
  stays `options`; existing `Due` as `date` validates date syntax.
- Ambiguous duplicate owner entries fail closed with duplicate entry ids.
- Ambiguous duplicate global definitions fail closed with definition ids when no
  owner entry disambiguates the write.
- `Done:: true` toggles owner completion through the system-field path; read-only
  system fields reject writes without storing child values.
- Manual UI rename cannot commit a field name that would create duplicate field
  names on any affected owner.
- `bun run typecheck`, `bun run test:core`, relevant renderer tests if touched,
  and `bun run docs:check` pass after the board entry links this plan.

## Tests

Core / agent tests:

- `node_create` infers `url`, `email`, `date`, `number`, `reference`, `checkbox`,
  and plain fallback for newly-created fields.
- `node_create` reuses an existing user `fieldDef` by name and preserves its type.
- `node_create` writes into a same-owner existing field entry instead of adding a
  duplicate field row.
- `node_edit` unmarked fields use the shared resolver and preserve omitted
  values.
- Duplicate same-owner field entries return an actionable error and create no
  nodes.
- Duplicate same-name field definitions return an actionable error when no owner
  field entry disambiguates.
- Existing typed field rejects incompatible values before partial mutation.
- `Done:: true` writes owner completion; read-only system fields reject.
- Field-definition rename guard rejects a rename that would make an owner contain
  duplicate field names.

Renderer tests only if UI code changes:

- committing a field name that duplicates another owner field shows the command
  failure and leaves the draft unchanged
- reuse popover behavior stays intact

## Risks

- **Manual UI compatibility.** The UI currently allows creating empty draft fields
  and then naming them. The guard must allow the empty draft and reject only the
  non-empty duplicate commit.
- **Existing dirty documents.** Users may already have duplicate definitions or
  duplicate owner entries. Failing closed is correct for future writes, but the
  error must include enough ids for an agent or user to clean the data explicitly.
- **Type inference overreach.** Keep inference conservative. In particular, do not
  infer `options` from short strings; that would create harder-to-fix schema
  choices from weak evidence.
- **System field storage.** System fields are computed projections. Writing child
  value nodes under `sys:*` entries would be wrong; route writable ones to owner
  scalars and reject read-only ones.

## Open Questions

- Should the implementation expose an explicit outline type annotation later
  (for example for intentionally creating `options` fields), or is reuse plus
  conservative inference enough for this pass? Default: no new syntax.
- Should a follow-up add a safe duplicate-field cleanup command, or is explicit
  `node_read` + `node_edit`/`node_delete` sufficient? Default: no new command in
  this PR.
