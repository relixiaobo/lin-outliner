# Definition Node Edit Parity

## Goal

Make tag and field definition nodes editable through the existing outliner node
tools. A field definition or supertag is a node, so an agent should create it
with `node_create` and edit its own configuration with `node_edit`, without
addressing locked internal `defConfig` children directly and without adding a
separate `node_configure` tool.

The user-visible bug this fixes is that a human can change a field definition's
type in the definition config panel, while an agent reading the same definition
sees `Field type` as a locked config child and cannot change `plain` to `url`,
`reference`, `options`, or another valid field type.

## Non-goals

- Do not expose raw IPC commands such as `set_field_config` or
  `set_tag_config` as model-facing tools.
- Do not unlock `defConfig` or `systemOption` nodes for direct outline editing.
  Those nodes remain internal storage.
- Do not add a new `node_configure` tool. Definition configuration belongs to
  `node_create` and `node_edit` because definitions are nodes.
- Do not implement broad view configuration, icon/banner/media nodes, or Trash
  permanent deletion in this feature. Those are separate parity gaps.
- Do not auto-migrate incompatible existing field values silently. Preview and
  validation must make the migration risk explicit.

## Shape

This is shape (a): one complete feature in one PR. The protocol extension,
runtime implementation, tests, and spec updates must land together because the
agent prompt, tool schema, and mutation behavior need to agree.

## Collision Result

- `gh pr list` shows open PR #386 (`codex-4/agent-issue-manager`), which touches
  broad agent/runtime files including `src/main/agentNodeTools.ts`,
  `src/main/agentTools.ts`, `src/core/commands.ts`, `src/core/types.ts`,
  `docs/spec/agent-tool-design.md`, and `tests/core/agentNodeTools.test.ts`.
  This is a real overlap. This plan keeps the implementation focused so the
  eventual rebase/merge conflict has a small semantic surface.
- `docs/TASKS.md` records related shipped work:
  `structured-field-resolution`, `config-as-nodes`,
  `node-edit-orthogonal-primitives`, and `reference-field-type`.
- Planned file scope:
  - Tool schema/types/implementation: `src/main/agentNodeToolSchemas.ts`,
    `src/main/agentNodeToolTypes.ts`, `src/main/agentNodeTools.ts`,
    `src/main/agentNodeToolRead.ts`, `src/main/agentNodeToolGuidance.ts`.
  - Core helpers only if needed for shared validation:
    `src/core/configProjection.ts`, `src/core/fieldResolution.ts`.
  - Specs/tests: `docs/spec/agent-tool-design.md`, `docs/spec/commands.md`,
    `tests/core/agentNodeTools.test.ts`.
- This dev clone does not edit `docs/TASKS.md` or `CHANGELOG.md`; main owns
  those files.

## Design

### 1. Definition config is part of the parent definition node

`node_read` should present definition config as structured editable metadata on
the `tagDef` or `fieldDef` node, not as the child structure the agent should
mutate.

For a field definition read, the model-visible data should include:

```json
{
  "definition": {
    "kind": "field",
    "config": {
      "fieldType": "plain",
      "sourceSupertag": null,
      "autocollectOptions": false,
      "autoInitialize": [],
      "nullable": true,
      "hideField": null,
      "minValue": null,
      "maxValue": null
    },
    "editableWith": "node_edit operation configure_definition"
  }
}
```

For a tag definition read, the model-visible data should include the projected
tag config with the same parent-node editing guidance.

### 2. `node_edit` gains a definition configuration operation

Extend `node_edit.operation` with `configure_definition`.

Inputs:

```ts
{
  operation: "configure_definition";
  node_id: string;
  definition_patch: FieldDefinitionPatch | TagDefinitionPatch;
  existing_values?: "validate";
  preview_only?: boolean;
}
```

Rules:

- `node_id` must name an active `fieldDef` or `tagDef`.
- `fieldDef` patches compile to `set_field_config` through the existing host
  command layer.
- `tagDef` patches compile to `set_tag_config`.
- Patches are typed and allow only known config keys.
- Preview returns the projected before/after config plus validation warnings or
  blockers.
- Direct edits to locked `defConfig` nodes keep failing, but their error
  guidance points to the parent definition id and `configure_definition`.

### 3. Field type changes validate existing values

Changing a field definition's `fieldType` can invalidate stored values. The
first version should be conservative:

- `existing_values: "validate"` is the default. It accepts the change only when
  every active field entry value already satisfies the destination type.
- `plain -> url/date/number/email/checkbox` can pass validation when every
  non-empty value is compatible.
- `plain -> reference` requires all non-empty values to already be node
  references. Pure text author names are blockers unless a later migration
  operation maps text to node ids.
- `plain -> options` with `validate` fails when existing values are free text.
  `collect_options` may be added in this PR only if the implementation can reuse
  existing option collection semantics cleanly; otherwise it remains a documented
  follow-up.
- `options_from_supertag` requires `sourceSupertag`, and values must reference
  nodes carrying that source supertag.
- Validation reports incompatible field entry ids and value ids so the agent can
  clean or migrate explicitly.

### 4. `node_create` can create definition nodes with initial config

Extend `node_create` with a structured `definition` input:

```ts
{
  definition: {
    kind: "field" | "tag";
    name: string;
    config?: FieldDefinitionPatch | TagDefinitionPatch;
  };
  parent_id?: string;
  after_id?: string | null;
  preview_only?: boolean;
}
```

Rules:

- Exactly one of `outline`, `target_id`, `duplicate_id`, or `definition` is
  required.
- Field definitions are created through existing definition commands, then
  configured through the same validation path as `configure_definition`.
- Tag definitions are created through existing tag creation semantics, then
  configured through the same validation path.
- The structured `definition` input is preferred over outline directives because
  config values are typed, not ordinary child outline content.

### 5. Definition entry reuse remains node editing, not config editing

If an agent needs to point an existing field entry at a different field
definition, this is a node edit against the field entry:

```ts
{
  operation: "reuse_field_definition";
  node_id: "field-entry-id";
  target_definition_id: "field-def-id-or-system-field-id";
  preview_only: true
}
```

This operation compiles to `reuse_field_definition` and keeps existing duplicate
field guards.

### 6. Definition merge is a first-class definition-management operation

Merging definitions is not ordinary content merge. It rewrites identity-bearing
references across the document, so it needs a dedicated operation on the same
`node_edit` surface:

```ts
{
  operation: "merge_definition";
  node_id: "target-field-or-tag-definition-id";
  merge_from_node_ids: ["source-definition-id"];
  existing_values?: "validate";
  preview_only?: boolean;
}
```

Rules:

- Target and sources must be active definitions of the same kind.
- Field definition merge requires the same field type in v1. Values are still
  validated against the target type before mutation.
- Options field merge maps source options to target options by label, moving
  missing options and retargeting duplicate option references.
- Field entry uses of the source definition are relinked to the target. If a
  node already has the target field entry, source values move into the target
  entry and the source entry is removed.
- Field ids in saved-search rules, view field refs, and reference nodes are
  rewritten from source to target.
- Tag definition merge replaces source tag applications with the target tag,
  rewrites tag refs in saved-search rules and config references, moves missing
  template field entries from source tag to target tag, and removes the source
  tag definition.
- Target definition config wins. Source config is not merged implicitly; agents
  should configure the target explicitly before or after merge.

## Acceptance Criteria

- `node_read` on a `fieldDef` returns projected config and guidance to edit the
  field definition node, not its locked `defConfig` child.
- `node_edit` can preview and commit `fieldType: "url"` on a field definition
  whose existing values are URL-compatible.
- `node_edit` rejects `fieldType: "url"` when active values are not URL-compatible
  and returns the incompatible value ids.
- `node_edit` can preview and commit a tag config patch, such as setting color or
  checkbox config, through the parent tag definition node.
- Direct `node_edit` against a locked `defConfig` node still fails, with guidance
  pointing to `configure_definition` on the parent definition node.
- `node_create` can create a field definition named `xmlUrl` with
  `fieldType: "url"` without writing a content node.
- `node_create` can create a tag definition with initial config.
- `node_edit` can reuse an existing field definition for a field entry without
  creating duplicate field definitions.
- `node_edit` can merge duplicate field definitions, relinking all source field
  entries and search/view references to the target.
- `node_edit` can merge duplicate supertags, replacing tag applications and
  tag/search/config references with the target tag.
- All mutation paths remain previewable and undoable through the existing agent
  transaction wrapper.

## Open Questions

- Should the structured `definition` input create definitions under Schema by
  default when `parent_id` is omitted, or require an explicit parent in v1?
- Should tag config support every current config key in v1, or only the keys the
  current UI already exposes and tests directly?
