import Type, { type Static, type TSchema } from 'typebox';
import {
  AssetLeaseSchema,
  AssetRecordSchema,
  ChangeSetSchema,
  DiffSchema,
  EventSchema,
  WatchRequestSchema,
  OperationSchema,
  OperationLogPageSchema,
  ProjectionResultSchema,
  ProjectionSchema,
  RuntimeStatusSchema,
  SelectorSchema,
  TargetSpecSchema,
} from './schemas';

export type OutlineCapabilityKind = 'local' | 'read' | 'mutate' | 'observe' | 'asset';

export interface OutlineCapability<TRequest extends TSchema = TSchema, TResult extends TSchema = TSchema> {
  readonly name: string;
  readonly kind: OutlineCapabilityKind;
  readonly runtimeRequired: boolean;
  readonly streaming: boolean;
  readonly destructive: boolean;
  readonly auditCategory: string;
  readonly summary: string;
  readonly requestSchema: TRequest;
  readonly resultSchema: TResult;
  readonly coverage: readonly string[];
}

const closed = { additionalProperties: false } as const;
const EmptyInput = Type.Object({}, closed);
const EmptyResult = Type.Object({}, closed);
const SelectorInput = Type.Object({ selector: SelectorSchema, projection: Type.Optional(ProjectionSchema) }, closed);
const MutationInput = Type.Object({
  changeSet: ChangeSetSchema,
  preview: Type.Optional(Type.Boolean()),
  expectDiff: Type.Optional(Type.String({ pattern: '^[a-f0-9]{64}$' })),
  acknowledgeDestructive: Type.Optional(Type.Boolean()),
}, closed);
const MutationResult = Type.Union([DiffSchema, OperationSchema]);

function capability<TRequest extends TSchema, TResult extends TSchema>(
  value: OutlineCapability<TRequest, TResult>,
): OutlineCapability<TRequest, TResult> {
  return Object.freeze(value);
}

const FIXED_CAPABILITIES = [
  capability({ name: 'version', kind: 'local', runtimeRequired: false, streaming: false, destructive: false, auditCategory: 'metadata', summary: 'Print CLI, app, and protocol versions.', requestSchema: EmptyInput, resultSchema: Type.Object({ cliVersion: Type.String(), appVersion: Type.String(), protocolMajors: Type.Array(Type.Integer()), storageVersion: Type.Integer() }, closed), coverage: [] }),
  capability({ name: 'status', kind: 'local', runtimeRequired: false, streaming: false, destructive: false, auditCategory: 'metadata', summary: 'Inspect Runtime presence and storage health without starting it.', requestSchema: EmptyInput, resultSchema: RuntimeStatusSchema, coverage: [] }),
  capability({ name: 'capabilities', kind: 'local', runtimeRequired: false, streaming: false, destructive: false, auditCategory: 'metadata', summary: 'Print the executable public capability registry.', requestSchema: Type.Object({ runtime: Type.Optional(Type.Boolean()) }, closed), resultSchema: Type.Array(Type.Unknown()), coverage: [] }),
  capability({ name: 'schema', kind: 'local', runtimeRequired: false, streaming: false, destructive: false, auditCategory: 'metadata', summary: 'Print exact public JSON Schemas.', requestSchema: Type.Object({ name: Type.Optional(Type.String()) }, closed), resultSchema: Type.Unknown(), coverage: [] }),
  capability({ name: 'find', kind: 'read', runtimeRequired: true, streaming: false, destructive: false, auditCategory: 'read.search', summary: 'Find bounded Nodes with the structured query grammar.', requestSchema: Type.Object({ target: TargetSpecSchema, projection: Type.Optional(ProjectionSchema) }, closed), resultSchema: ProjectionResultSchema, coverage: ['search_nodes'] }),
  capability({ name: 'show', kind: 'read', runtimeRequired: true, streaming: false, destructive: false, auditCategory: 'read.node', summary: 'Read one deterministic target with a bounded Projection.', requestSchema: SelectorInput, resultSchema: ProjectionResultSchema, coverage: ['get_projection', 'backlinks'] }),
  capability({ name: 'export', kind: 'read', runtimeRequired: true, streaming: true, destructive: false, auditCategory: 'read.export', summary: 'Export a bounded target as JSON, JSONL, Markdown, or OPML.', requestSchema: SelectorInput, resultSchema: Type.Unknown(), coverage: [] }),
  capability({ name: 'watch', kind: 'observe', runtimeRequired: true, streaming: true, destructive: false, auditCategory: 'observe', summary: 'Stream ordered resumable Runtime events.', requestSchema: WatchRequestSchema, resultSchema: EventSchema, coverage: ['document_events'] }),
  capability({ name: 'diff', kind: 'mutate', runtimeRequired: true, streaming: false, destructive: false, auditCategory: 'mutation.preview', summary: 'Normalize and preview a ChangeSet without writing.', requestSchema: Type.Object({ changeSet: ChangeSetSchema }, closed), resultSchema: DiffSchema, coverage: [] }),
  capability({ name: 'apply', kind: 'mutate', runtimeRequired: true, streaming: false, destructive: false, auditCategory: 'mutation.apply', summary: 'Apply one exact reviewed Diff atomically.', requestSchema: Type.Object({ diff: DiffSchema, acknowledgeDestructive: Type.Optional(Type.Boolean()) }, closed), resultSchema: OperationSchema, coverage: [] }),
  capability({ name: 'log', kind: 'read', runtimeRequired: true, streaming: false, destructive: false, auditCategory: 'history.read', summary: 'Read paginated durable Operation history.', requestSchema: Type.Object({ cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 4_096 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000 })), operationId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })), idempotencyKey: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })), nodeId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })), origin: Type.Optional(OperationSchema.properties.origin), threadId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })), turnId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })), itemId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })) }, closed), resultSchema: OperationLogPageSchema, coverage: ['operation_history'] }),
  capability({ name: 'revert', kind: 'mutate', runtimeRequired: true, streaming: false, destructive: false, auditCategory: 'history.revert', summary: 'Guard and exactly revert a retained Operation.', requestSchema: Type.Object({ operationId: Type.String({ minLength: 1 }) }, closed), resultSchema: OperationSchema, coverage: [] }),
  capability({ name: 'undo', kind: 'mutate', runtimeRequired: true, streaming: false, destructive: false, auditCategory: 'history.undo', summary: 'Revert the latest applicable Operation.', requestSchema: EmptyInput, resultSchema: OperationSchema, coverage: ['undo'] }),
  capability({ name: 'redo', kind: 'mutate', runtimeRequired: true, streaming: false, destructive: false, auditCategory: 'history.redo', summary: 'Revert the latest applicable revert Operation.', requestSchema: EmptyInput, resultSchema: OperationSchema, coverage: ['redo'] }),
  capability({ name: 'asset ingest', kind: 'asset', runtimeRequired: true, streaming: false, destructive: false, auditCategory: 'asset.ingest', summary: 'Stage verified asset bytes under a recovery-aware lease.', requestSchema: Type.Union([
    Type.Object({ source: Type.Literal('path'), path: Type.String({ minLength: 1, maxLength: 32_768 }) }, closed),
    Type.Object({ source: Type.Literal('stdin') }, closed),
    Type.Object({
      source: Type.Literal('bytes'),
      data: Type.String({ minLength: 1, maxLength: 139_810_136 }),
      mimeType: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
      originalFilename: Type.Optional(Type.String({ maxLength: 4_096 })),
    }, closed),
  ]), resultSchema: AssetLeaseSchema, coverage: ['ingest_asset', 'ingest_local_file', 'ingest_thread_resource'] }),
  capability({ name: 'asset show', kind: 'asset', runtimeRequired: true, streaming: false, destructive: false, auditCategory: 'asset.read', summary: 'Read logical asset metadata.', requestSchema: Type.Object({ assetId: Type.String({ minLength: 1 }) }, closed), resultSchema: AssetRecordSchema, coverage: ['lookup_asset'] }),
  capability({ name: 'asset export', kind: 'asset', runtimeRequired: true, streaming: true, destructive: false, auditCategory: 'asset.export', summary: 'Stream verified asset bytes.', requestSchema: Type.Object({ assetId: Type.String({ minLength: 1 }) }, closed), resultSchema: Type.Unknown(), coverage: [] }),
] as const;

const PORCELAIN_COMMANDS = [
  ['add', 'structure.create', [
    'create_node', 'create_rich_text_node', 'create_tagged_node', 'create_tag_and_tagged_node',
    'create_nodes_from_tree', 'paste_nodes_into_node', 'split_node',
  ]],
  ['set', 'content.update', [
    'apply_node_text_patch', 'update_node_description', 'set_node_checkbox_visible',
    'set_code_block', 'set_code_language', 'set_node_icon', 'set_node_banner',
  ]],
  ['move', 'structure.move', ['move_node', 'batch_move_nodes', 'batch_move_nodes_up', 'batch_move_nodes_down']],
  ['duplicate', 'structure.duplicate', ['batch_duplicate_nodes']],
  ['merge', 'structure.merge', ['merge_node_into']],
  ['indent', 'structure.indent', ['indent_node', 'batch_indent_nodes']],
  ['outdent', 'structure.outdent', ['outdent_node', 'batch_outdent_nodes']],
  ['done set', 'done.set', ['toggle_done', 'batch_toggle_done']],
  ['done cycle', 'done.cycle', ['cycle_done_state', 'batch_cycle_done_state']],
  ['tag add', 'tag.add', ['apply_tag', 'batch_apply_tag']],
  ['tag remove', 'tag.remove', ['remove_tag']],
  ['field define', 'field.define', ['create_inline_field_after_node', 'create_inline_field']],
  ['field set', 'field.set', ['update_field_slot', 'set_field_free_text_value']],
  ['field clear', 'field.clear', ['clear_field_value']],
  ['field remove', 'field.remove', ['remove_field_value']],
  ['field reuse', 'field.reuse', ['reuse_field_definition']],
  ['field select', 'field.select', [
    'register_collected_option', 'create_collected_field_option', 'select_field_option',
  ]],
  ['definition create', 'definition.create', ['create_tag', 'create_field_definition', 'create_field_def']],
  ['definition configure', 'definition.configure', ['set_tag_config', 'set_field_config']],
  ['definition merge', 'definition.merge', ['merge_definitions']],
  ['reference add', 'reference.add', ['add_reference', 'add_reference_conversion']],
  ['reference set', 'reference.retarget', ['set_reference_target', 'replace_node_with_reference', 'replace_node_with_reference_conversion']],
  ['reference inline', 'reference.inline', ['replace_node_with_inline_reference', 'convert_reference_to_inline_node']],
  ['reference restore', 'reference.restore', ['restore_inline_reference_node_to_reference']],
  ['view set', 'view.set', ['set_view_toolbar_visible', 'set_view_mode']],
  ['view group set', 'view.group', ['set_group_field']],
  ['view sort add', 'view.sort.add', ['add_sort_rule']],
  ['view sort set', 'view.sort.set', ['update_sort_rule']],
  ['view sort remove', 'view.sort.remove', ['remove_sort_rule']],
  ['view sort clear', 'view.sort.clear', ['clear_sort_rules']],
  ['view filter add', 'view.filter.add', ['add_filter_rule']],
  ['view filter set', 'view.filter.set', ['update_filter_rule']],
  ['view filter remove', 'view.filter.remove', ['remove_filter_rule']],
  ['view filter clear', 'view.filter.clear', ['clear_filter_rules']],
  ['view display add', 'view.display.add', ['add_display_field']],
  ['view display set', 'view.display.set', ['update_display_field']],
  ['view display remove', 'view.display.remove', ['remove_display_field']],
  ['search create', 'search.create', ['create_search_node']],
  ['search ensure-tag', 'search.ensure-tag', ['ensure_tag_search']],
  ['search set', 'search.set', ['set_search_node', 'set_search_query_outline']],
  ['search refresh', 'search.refresh', ['refresh_search_node_results']],
  ['template apply', 'template.apply', ['preview_tag_template_backfill', 'apply_template_to_tagged_nodes']],
  ['daily ensure', 'daily.ensure', ['ensure_date_node']],
  ['capture add', 'capture.create', ['create_capture']],
  ['media add', 'media.create', ['create_image_node', 'create_attachment_node']],
  ['media set', 'media.update', ['set_node_image']],
  ['trash', 'lifecycle.trash', ['trash_node', 'batch_trash_nodes']],
  ['restore', 'lifecycle.restore', ['restore_node']],
  ['purge', 'lifecycle.purge', ['delete_node']],
] as const;

const PORCELAIN_CAPABILITIES = PORCELAIN_COMMANDS.map(([name, auditCategory, coverage]) => capability({
  name,
  kind: 'mutate',
  runtimeRequired: true,
  streaming: false,
  destructive: name === 'purge' || name === 'merge' || name === 'definition merge',
  auditCategory,
  summary: `Lower ${name} intent into the public ChangeSet contract.`,
  requestSchema: MutationInput,
  resultSchema: MutationResult,
  coverage,
}));

export const OUTLINE_CAPABILITIES = Object.freeze([
  ...FIXED_CAPABILITIES,
  ...PORCELAIN_CAPABILITIES,
]);

const capabilityByName = new Map(OUTLINE_CAPABILITIES.map((entry) => [entry.name, entry]));

export function outlineCapability(name: string): OutlineCapability | undefined {
  return capabilityByName.get(name);
}

export function outlineCapabilityManifest() {
  return OUTLINE_CAPABILITIES.map((entry) => ({
    name: entry.name,
    kind: entry.kind,
    runtimeRequired: entry.runtimeRequired,
    streaming: entry.streaming,
    destructive: entry.destructive,
    auditCategory: entry.auditCategory,
    summary: entry.summary,
    coverage: [...entry.coverage],
    requestSchema: entry.requestSchema,
    resultSchema: entry.resultSchema,
  }));
}

export type OutlineCapabilityRequest<Name extends string> = Static<
  Extract<(typeof OUTLINE_CAPABILITIES)[number], { name: Name }>['requestSchema']
>;
