import Type, { type TSchema } from 'typebox';
import {
  FieldDefinitionPatchSchema,
  FieldTypeSchema,
  FilterOperatorSchema,
  FilterValueLogicSchema,
  IdentifierSchema,
  LocalDateSchema,
  NodeDraftSchema,
  QueryExpressionSchema,
  RichTextSchema,
  TagDefinitionPatchSchema,
  TargetRefSchema,
  TargetSpecSchema,
  DestinationPlacementSchema,
  PlacementSchema,
  ViewCreateSpecificationSchema,
  ViewDisplaySpecificationSchema,
  ViewFilterSpecificationSchema,
  ViewSetSpecificationSchema,
  ViewSortSpecificationSchema,
  ViewFieldSchema,
} from './schemas';

const closed = { additionalProperties: false } as const;
const OptionalBind = Type.Optional(Type.String({ pattern: '^[A-Za-z][A-Za-z0-9_-]{0,63}$' }));
const ScalarValueSchema = Type.Union([
  Type.String({ maxLength: 4_194_304 }),
  Type.Number(),
  Type.Boolean(),
  Type.Null(),
]);

export const ViewSortSpecSchema = ViewSortSpecificationSchema;
export const ViewFilterSpecSchema = ViewFilterSpecificationSchema;
export const ViewDisplaySpecSchema = ViewDisplaySpecificationSchema;
export const ViewCreateSpecSchema = ViewCreateSpecificationSchema;
export const ViewSetSpecSchema = ViewSetSpecificationSchema;

const TargetOnlySchema = Type.Object({ target: TargetRefSchema }, closed);
const TargetFieldSchema = Type.Object({ target: TargetRefSchema, field: TargetRefSchema }, closed);
const TargetTagSchema = Type.Object({ target: TargetRefSchema, tag: TargetRefSchema }, closed);

const AddInputSchema = Type.Object({
  placement: DestinationPlacementSchema,
  nodes: Type.Array(NodeDraftSchema, { minItems: 1, maxItems: 100_000 }),
  bind: OptionalBind,
}, closed);

const SetInputSchema = Type.Object({
  target: TargetRefSchema,
  content: Type.Optional(RichTextSchema),
  description: Type.Optional(Type.Union([Type.String({ maxLength: 4_194_304 }), Type.Null()])),
  codeLanguage: Type.Optional(Type.String({ maxLength: 128 })),
  checkbox: Type.Optional(Type.Boolean()),
  icon: Type.Optional(Type.Union([Type.String({ maxLength: 4_096 }), Type.Null()])),
  iconKind: Type.Optional(Type.String({ maxLength: 128 })),
  bannerLeaseId: Type.Optional(Type.Union([IdentifierSchema, Type.Null()])),
  image: Type.Optional(Type.Object({
    assetLeaseId: Type.Optional(IdentifierSchema),
    mediaUrl: Type.Optional(Type.String({ maxLength: 32_768 })),
    width: Type.Optional(Type.Number({ minimum: 0 })),
    height: Type.Optional(Type.Number({ minimum: 0 })),
  }, closed)),
}, { ...closed, minProperties: 2 });

const TextReplaceInputSchema = Type.Object({
  target: TargetSpecSchema,
  find: Type.String({ minLength: 1, maxLength: 65_536 }),
  replacement: Type.String({ maxLength: 4_194_304 }),
  field: Type.Optional(Type.Union([
    Type.Literal('content'), Type.Literal('description'), Type.Literal('both'),
  ])),
  occurrence: Type.Optional(Type.Union([Type.Literal('first'), Type.Literal('all')])),
  caseSensitive: Type.Optional(Type.Boolean()),
  maxReplacements: Type.Integer({ minimum: 1, maximum: 100_000 }),
}, closed);

const MoveInputSchema = Type.Object({
  target: TargetRefSchema,
  placement: PlacementSchema,
}, closed);

const DuplicateInputSchema = Type.Object({
  target: TargetRefSchema,
  placement: PlacementSchema,
  bind: OptionalBind,
}, closed);

const MergeInputSchema = Type.Object({ source: TargetRefSchema, target: TargetRefSchema }, closed);
const DoneSetInputSchema = Type.Object({ target: TargetRefSchema, value: Type.Boolean() }, closed);
const FieldDefineInputSchema = Type.Union([
  Type.Object({
    target: TargetRefSchema,
    name: Type.String({ minLength: 1, maxLength: 1_024 }),
    fieldType: Type.Optional(FieldTypeSchema),
    value: Type.Optional(ScalarValueSchema),
    index: Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])),
  }, closed),
  Type.Object({
    target: TargetRefSchema,
    field: TargetRefSchema,
    value: Type.Optional(ScalarValueSchema),
    index: Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])),
  }, closed),
]);
const FieldSetInputSchema = Type.Object({ target: TargetRefSchema, field: TargetRefSchema, value: ScalarValueSchema }, closed);
const FieldReuseInputSchema = Type.Object({ target: TargetRefSchema, sourceField: TargetRefSchema, field: TargetRefSchema }, closed);
const FieldSelectInputSchema = Type.Object({ target: TargetRefSchema, field: TargetRefSchema, option: TargetRefSchema }, closed);

const DefinitionCreateInputSchema = Type.Union([
  Type.Object({
    definitionType: Type.Literal('tag'),
    name: Type.String({ minLength: 1, maxLength: 1_024 }),
    id: Type.Optional(IdentifierSchema),
    config: Type.Optional(TagDefinitionPatchSchema),
    template: Type.Optional(Type.Array(NodeDraftSchema, { maxItems: 100_000 })),
    bind: OptionalBind,
  }, closed),
  Type.Object({
    definitionType: Type.Literal('field'),
    name: Type.String({ minLength: 1, maxLength: 1_024 }),
    id: Type.Optional(IdentifierSchema),
    config: Type.Optional(FieldDefinitionPatchSchema),
    options: Type.Optional(Type.Array(NodeDraftSchema, { maxItems: 100_000 })),
    bind: OptionalBind,
  }, closed),
]);

const DefinitionConfigureInputSchema = Type.Union([
  Type.Object({ target: TargetRefSchema, definitionType: Type.Literal('tag'), patch: TagDefinitionPatchSchema }, closed),
  Type.Object({ target: TargetRefSchema, definitionType: Type.Literal('field'), patch: FieldDefinitionPatchSchema }, closed),
]);

const ReferenceInputSchema = Type.Object({ target: TargetRefSchema, reference: TargetRefSchema }, closed);
const ViewSetInputSchema = Type.Object({ target: TargetRefSchema, view: ViewSetSpecSchema }, closed);
const ViewGroupInputSchema = Type.Object({ target: TargetRefSchema, field: Type.Union([ViewFieldSchema, Type.Null()]) }, closed);
const ViewSortAddInputSchema = Type.Object({ target: TargetRefSchema, sort: ViewSortSpecSchema }, closed);
const ViewSortSetInputSchema = Type.Object({ target: TargetRefSchema, ruleId: IdentifierSchema, sort: ViewSortSpecSchema }, closed);
const ViewRuleInputSchema = Type.Object({ target: TargetRefSchema, ruleId: IdentifierSchema }, closed);
const ViewFilterAddInputSchema = Type.Object({ target: TargetRefSchema, filter: ViewFilterSpecSchema }, closed);
const ViewFilterSetInputSchema = Type.Object({
  target: TargetRefSchema,
  ruleId: IdentifierSchema,
  patch: Type.Object({
    field: Type.Optional(Type.Union([ViewFieldSchema, Type.Null()])),
    operator: Type.Optional(Type.Union([FilterOperatorSchema, Type.Null()])),
    values: Type.Optional(Type.Union([Type.Array(Type.String({ maxLength: 65_536 }), { maxItems: 10_000 }), Type.Null()])),
    valueLogic: Type.Optional(Type.Union([FilterValueLogicSchema, Type.Null()])),
  }, { ...closed, minProperties: 1 }),
}, closed);
const ViewDisplayAddInputSchema = Type.Object({ target: TargetRefSchema, display: ViewDisplaySpecSchema }, closed);
const ViewDisplaySetInputSchema = Type.Object({ target: TargetRefSchema, displayFieldId: IdentifierSchema, patch: Type.Partial(ViewDisplaySpecSchema, { minProperties: 1 }) }, closed);
const ViewDisplayRemoveInputSchema = Type.Object({ target: TargetRefSchema, displayFieldId: IdentifierSchema }, closed);
const SearchCreateInputSchema = Type.Union([
  Type.Object({
    parent: Type.Optional(TargetRefSchema),
    title: Type.String({ minLength: 1, maxLength: 4_194_304 }),
    query: QueryExpressionSchema,
    view: Type.Optional(ViewCreateSpecSchema),
    bind: OptionalBind,
  }, closed),
  Type.Object({
    parent: Type.Optional(TargetRefSchema),
    title: Type.String({ minLength: 1, maxLength: 4_194_304 }),
    match: Type.String({ minLength: 1, maxLength: 65_536 }),
    view: Type.Optional(ViewCreateSpecSchema),
    bind: OptionalBind,
  }, closed),
]);
const SearchSetInputSchema = Type.Union([
  Type.Object({
    target: TargetRefSchema,
    title: Type.Optional(Type.String({ minLength: 1, maxLength: 4_194_304 })),
    query: Type.Optional(QueryExpressionSchema),
    view: Type.Optional(ViewSetSpecSchema),
  }, { ...closed, minProperties: 2 }),
  Type.Object({
    target: TargetRefSchema,
    title: Type.Optional(Type.String({ minLength: 1, maxLength: 4_194_304 })),
    match: Type.Optional(Type.String({ minLength: 1, maxLength: 65_536 })),
    view: Type.Optional(ViewSetSpecSchema),
  }, { ...closed, minProperties: 2 }),
]);
const SearchEnsureTagInputSchema = Type.Object({ tag: TargetRefSchema, bind: OptionalBind }, closed);
const DailyEnsureInputSchema = Type.Object({ date: LocalDateSchema, bind: OptionalBind }, closed);

const CaptureProvenanceSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  captureId: Type.String({ minLength: 1, maxLength: 256 }),
  createdBy: Type.Union([Type.Literal('launcher'), Type.Literal('agent'), Type.Literal('import')]),
  capturedAt: Type.String({ format: 'date-time' }),
  origin: Type.String({ minLength: 1, maxLength: 128 }),
  providerId: Type.String({ minLength: 1, maxLength: 256 }),
  app: Type.Object({
    name: Type.String({ minLength: 1, maxLength: 4_096 }),
    bundleId: Type.Optional(Type.String({ maxLength: 4_096 })),
    windowTitle: Type.Optional(Type.String({ maxLength: 32_768 })),
  }, closed),
  source: Type.Record(Type.String(), Type.Unknown()),
  status: Type.Union([Type.Literal('saved'), Type.Literal('partial')]),
  intent: Type.String({ minLength: 1, maxLength: 128 }),
  warnings: Type.Array(Type.Unknown(), { maxItems: 10_000 }),
}, closed);

const CaptureAddInputSchema = Type.Union([
  Type.Object({
    parent: TargetRefSchema,
    title: Type.String({ minLength: 1, maxLength: 4_194_304 }),
    description: Type.Optional(Type.String({ maxLength: 4_194_304 })),
    provenance: CaptureProvenanceSchema,
    children: Type.Optional(Type.Array(NodeDraftSchema, { maxItems: 100_000 })),
    bind: OptionalBind,
  }, closed),
  Type.Object({
    date: LocalDateSchema,
    title: Type.String({ minLength: 1, maxLength: 4_194_304 }),
    description: Type.Optional(Type.String({ maxLength: 4_194_304 })),
    provenance: CaptureProvenanceSchema,
    children: Type.Optional(Type.Array(NodeDraftSchema, { maxItems: 100_000 })),
    bind: OptionalBind,
  }, closed),
]);

const MediaSourceSchema = Type.Union([
  Type.Object({ kind: Type.Literal('path'), path: Type.String({ minLength: 1, maxLength: 32_768 }) }, closed),
  Type.Object({ kind: Type.Literal('stdin') }, closed),
]);
const MediaMetadataSchema = Type.Object({
  width: Type.Optional(Type.Number({ minimum: 0 })),
  height: Type.Optional(Type.Number({ minimum: 0 })),
  alt: Type.Optional(Type.String({ maxLength: 4_096 })),
}, closed);
const MediaAddInputSchema = Type.Union([
  Type.Object({ parent: TargetRefSchema, mediaType: Type.Union([Type.Literal('image'), Type.Literal('attachment')]), name: Type.Optional(Type.String({ maxLength: 4_096 })), source: MediaSourceSchema, metadata: Type.Optional(MediaMetadataSchema), bind: OptionalBind }, closed),
  Type.Object({ parent: TargetRefSchema, mediaType: Type.Union([Type.Literal('image'), Type.Literal('attachment')]), name: Type.Optional(Type.String({ maxLength: 4_096 })), assetLeaseId: IdentifierSchema, metadata: Type.Optional(MediaMetadataSchema), bind: OptionalBind }, closed),
  Type.Object({ parent: TargetRefSchema, mediaType: Type.Literal('image'), name: Type.Optional(Type.String({ maxLength: 4_096 })), mediaUrl: Type.String({ minLength: 1, maxLength: 32_768 }), metadata: Type.Optional(MediaMetadataSchema), bind: OptionalBind }, closed),
]);

const MediaSetInputSchema = Type.Object({
  target: TargetRefSchema,
  assetLeaseId: Type.Optional(IdentifierSchema),
  mediaUrl: Type.Optional(Type.String({ maxLength: 32_768 })),
  width: Type.Optional(Type.Number({ minimum: 0 })),
  height: Type.Optional(Type.Number({ minimum: 0 })),
}, closed);

export interface CommandOptionHelp {
  readonly name: string;
  readonly value?: string;
  readonly description: string;
  readonly default?: string;
  readonly repeatable?: boolean;
}

export interface CommandHelpContract {
  readonly usage: string;
  readonly summary: string;
  readonly behavior: string;
  readonly idempotent: boolean;
  readonly positionals: readonly string[];
  readonly options: readonly CommandOptionHelp[];
  readonly selectors: string;
  readonly cardinality: string;
  readonly input: string;
  readonly output: string;
  readonly defaults: readonly string[];
  readonly destructive: boolean;
  readonly examples: readonly string[];
}

export interface PorcelainContract extends CommandHelpContract {
  readonly inputSchema: TSchema;
}

interface PorcelainBaseContract {
  readonly inputSchema: TSchema;
  readonly usage: string;
  readonly options: readonly CommandOptionHelp[];
  readonly examples?: readonly string[];
}

const target = option('target', 'TARGET', 'Exact ID, semantic alias, or structured bounded target.');
const parent = option('parent', 'PARENT', 'Exact parent ID, semantic alias, or structured target.');
const bind = option('bind', 'NAME', 'Bind created or ensured Node IDs in the lowered ChangeSet.');
const value = option('value', 'VALUE', 'Typed scalar or JSON value.');
function option(
  name: string,
  valueName: string | undefined,
  description: string,
  metadata: Partial<Pick<CommandOptionHelp, 'default' | 'repeatable'>> = {},
): CommandOptionHelp {
  return { name, ...(valueName ? { value: valueName } : {}), description, ...metadata };
}

export const PORCELAIN_COMMON_OPTIONS = Object.freeze([
  option('input', 'FILE|-', 'Read this command\'s structured input payload.'),
  option('preview', undefined, 'Return the normalized Diff without writing.'),
  option('expect-diff', 'SHA256', 'Apply only the exact reviewed Diff.'),
  option('idempotency-key', 'KEY', 'Bind retries to one settled result.'),
]);
const PORCELAIN_DESTRUCTIVE_OPTIONS = Object.freeze([
  option('yes', undefined, 'Acknowledge the exact destructive Diff named by --expect-diff; never sufficient alone.'),
]);

export function porcelainHelpOptions(contract: PorcelainContract): readonly PorcelainOptionHelp[] {
  return [
    ...contract.options,
    ...PORCELAIN_COMMON_OPTIONS,
    ...(contract.destructive ? PORCELAIN_DESTRUCTIVE_OPTIONS : []),
  ];
}

export type PorcelainOptionHelp = CommandOptionHelp;

function contract(inputSchema: TSchema, usage: string, options: readonly CommandOptionHelp[], examples?: readonly string[]): PorcelainBaseContract {
  return Object.freeze({ inputSchema, usage, options: Object.freeze(options), ...(examples ? { examples: Object.freeze(examples) } : {}) });
}

const PORCELAIN_BASE_CONTRACTS = Object.freeze({
  add: contract(AddInputSchema, 'add PARENT TEXT | add --before|--after SIBLING TEXT | add --input FILE|-', [parent, option('tree', 'FILE|-', 'Create a complete typed Node tree.'), option('type', 'TYPE', 'Set the root Node type.'), option('description', 'TEXT', 'Set the root description.'), option('first', undefined, 'Insert first under PARENT.'), option('last', undefined, 'Insert last under PARENT.', { default: 'true' }), option('index', 'INDEX', 'Insert at a zero-based child index under PARENT.'), option('before', 'SIBLING', 'Insert immediately before one exact sibling; PARENT is not required.'), option('after', 'SIBLING', 'Insert immediately after one exact sibling; PARENT is not required.'), bind]),
  set: contract(SetInputSchema, 'set TARGET [PROPERTY OPTIONS]', [target, option('text', 'TEXT', 'Replace plain content.'), option('content', 'TEXT', 'Replace plain content.'), option('description', 'TEXT|null', 'Patch the description.'), option('code', 'LANGUAGE', 'Set code-block language.'), option('checkbox', 'BOOLEAN', 'Set checkbox visibility.'), option('icon', 'VALUE|null', 'Set the Node icon.'), option('icon-kind', 'KIND', 'Set the icon kind.'), option('banner', 'LEASE|null', 'Set the banner asset lease.'), option('image', 'LEASE', 'Set the image asset lease.'), option('media-url', 'URL', 'Set an external media URL.'), option('width', 'NUMBER', 'Set media width.'), option('height', 'NUMBER', 'Set media height.')]),
  'text replace': contract(TextReplaceInputSchema, 'text replace TARGET --find TEXT --replace TEXT | text replace --matching TEXT --max N --find TEXT --replace TEXT | text replace --input FILE|-', [target, option('matching', 'TEXT', 'Select a bounded many target with STRING_MATCH shorthand.'), option('query', 'JSON|FILE', 'Select with the canonical structured query.'), option('within', 'SELECTOR', 'Bound query selection below one exact Selector.'), option('include-trash', undefined, 'Include trashed Nodes in query selection.'), option('order', 'ORDER', 'Use document, created, updated, or text query order.', { default: 'document' }), option('max', 'N', 'Required maximum Node count for --matching or --query.'), option('find', 'TEXT', 'Literal text to replace.'), option('replace', 'TEXT', 'Replacement text; an empty string deletes matches.'), option('field', 'content|description|both', 'Select transformed fields.', { default: 'content' }), option('occurrence', 'first|all', 'Replace the first or all non-overlapping matches in each selected field.', { default: 'all' }), option('case-sensitive', 'BOOLEAN', 'Use case-sensitive literal matching.', { default: 'true' }), option('max-replacements', 'N', 'Bound total replacements across every selected Node.', { default: '1000' })]),
  move: contract(MoveInputSchema, 'move TARGET DESTINATION | move TARGET --before|--after SIBLING | move TARGET --previous|--next', [target, option('destination', 'TARGET', 'Destination parent for first, last, or index placement.'), option('first', undefined, 'Place first under DESTINATION.'), option('last', undefined, 'Place last under DESTINATION.', { default: 'true' }), option('index', 'INDEX', 'Place at a zero-based index under DESTINATION.'), option('before', 'SIBLING', 'Place immediately before one exact sibling.'), option('after', 'SIBLING', 'Place immediately after one exact sibling.'), option('previous', undefined, 'Move the selected sibling block one position earlier.'), option('next', undefined, 'Move the selected sibling block one position later.')]),
  duplicate: contract(DuplicateInputSchema, 'duplicate TARGET DESTINATION | duplicate TARGET --before|--after SIBLING | duplicate TARGET --previous|--next', [target, option('destination', 'TARGET', 'Destination parent for first, last, or index placement.'), option('first', undefined, 'Place copies first under DESTINATION.'), option('last', undefined, 'Place copies last under DESTINATION.', { default: 'true' }), option('index', 'INDEX', 'Place copies at a zero-based index under DESTINATION.'), option('before', 'SIBLING', 'Place copies immediately before one exact sibling.'), option('after', 'SIBLING', 'Place copies immediately after one exact sibling.'), option('previous', undefined, 'Place each copy immediately before its source.'), option('next', undefined, 'Place each copy immediately after its source.'), bind]),
  merge: contract(MergeInputSchema, 'merge SOURCE TARGET', [option('source', 'TARGET', 'Source Node or bounded set.'), target]),
  indent: contract(TargetOnlySchema, 'indent TARGET', [target]),
  outdent: contract(TargetOnlySchema, 'outdent TARGET', [target]),
  'done set': contract(DoneSetInputSchema, 'done set TARGET BOOLEAN', [target, value]),
  'done cycle': contract(TargetOnlySchema, 'done cycle TARGET', [target]),
  'tag add': contract(TargetTagSchema, 'tag add TARGET TAG', [target, option('tag', 'TAG', 'Tag definition target.')]),
  'tag remove': contract(TargetTagSchema, 'tag remove TARGET TAG', [target, option('tag', 'TAG', 'Tag definition target.')]),
  'field define': contract(FieldDefineInputSchema, 'field define TARGET NAME [--value VALUE]', [target, option('name', 'NAME', 'New field name.'), option('field-type', 'TYPE', 'New field type.'), option('field', 'FIELD', 'Attach an existing field definition.'), value, option('index', 'INDEX', 'Field slot index.')]),
  'field set': contract(FieldSetInputSchema, 'field set TARGET FIELD VALUE', [target, option('field', 'FIELD', 'Field definition target.'), value]),
  'field clear': contract(TargetFieldSchema, 'field clear TARGET FIELD', [target, option('field', 'FIELD', 'Field definition target.')]),
  'field remove': contract(TargetFieldSchema, 'field remove TARGET FIELD', [target, option('field', 'FIELD', 'Field definition target.')]),
  'field reuse': contract(FieldReuseInputSchema, 'field reuse TARGET SOURCE_FIELD TARGET_FIELD', [target, option('source-field', 'FIELD', 'Existing field slot definition.'), option('field', 'FIELD', 'Replacement field definition.')]),
  'field select': contract(FieldSelectInputSchema, 'field select TARGET FIELD OPTION', [target, option('field', 'FIELD', 'Field definition target.'), option('option', 'OPTION', 'Option Node target.')]),
  'definition create': contract(DefinitionCreateInputSchema, 'definition create TYPE NAME | definition create --input FILE|-', [option('type', 'tag|field', 'Definition kind.'), option('name', 'NAME', 'Definition name.'), option('field-type', 'TYPE', 'Field definition type.'), option('id', 'ID', 'Explicit client Node ID.'), option('config', 'JSON|FILE', 'Complete initial definition configuration.'), option('template', 'FILE|-', 'Initial tag template tree.'), option('options', 'FILE|-', 'Initial field option tree.'), bind]),
  'definition configure': contract(DefinitionConfigureInputSchema, 'definition configure TARGET TYPE --patch JSON|FILE', [target, option('type', 'tag|field', 'Definition kind.'), option('patch', 'JSON|FILE', 'Patch with omitted properties preserved.')]),
  'definition merge': contract(MergeInputSchema, 'definition merge SOURCE TARGET', [option('source', 'TARGET', 'Source definitions.'), target]),
  'reference add': contract(ReferenceInputSchema, 'reference add TARGET REFERENCE', [target, option('reference', 'TARGET', 'Referenced Node target.')]),
  'reference set': contract(ReferenceInputSchema, 'reference set TARGET REFERENCE', [target, option('reference', 'TARGET', 'New referenced Node target.')]),
  'reference replace': contract(ReferenceInputSchema, 'reference replace TARGET REFERENCE', [target, option('reference', 'TARGET', 'Referenced Node that replaces the content Node.')]),
  'reference inline': contract(ReferenceInputSchema, 'reference inline TARGET [REFERENCE]', [target, option('reference', 'TARGET', 'Required referenced Node target when TARGET is a content Node; omit only to convert an existing tree reference.')]),
  'reference restore': contract(ReferenceInputSchema, 'reference restore TARGET REFERENCE', [target, option('reference', 'TARGET', 'Referenced Node target.')]),
  'view set': contract(ViewSetInputSchema, 'view set TARGET MODE | view set --input FILE|-', [target, option('mode', 'MODE', 'Set list, table, cards, or calendar mode.'), option('toolbar', 'BOOLEAN', 'Set toolbar visibility.'), option('group', 'FIELD|null', 'Set the grouping field.'), option('replace', 'JSON|FILE', 'Explicitly replace sort, filter, or display collections.')]),
  'view group set': contract(ViewGroupInputSchema, 'view group set TARGET FIELD|null', [target, option('field', 'FIELD|null', 'Grouping field.')]),
  'view sort add': contract(ViewSortAddInputSchema, 'view sort add TARGET --field FIELD', [target, option('field', 'FIELD', 'Sort field.'), option('direction', 'asc|desc', 'Sort direction.', { default: 'asc' })]),
  'view sort set': contract(ViewSortSetInputSchema, 'view sort set TARGET --rule ID --field FIELD', [target, option('rule', 'ID', 'Sort-rule Node ID.'), option('field', 'FIELD', 'Sort field.'), option('direction', 'asc|desc', 'Sort direction.')]),
  'view sort remove': contract(ViewRuleInputSchema, 'view sort remove TARGET --rule ID', [target, option('rule', 'ID', 'Sort-rule Node ID.')]),
  'view sort clear': contract(TargetOnlySchema, 'view sort clear TARGET', [target]),
  'view filter add': contract(ViewFilterAddInputSchema, 'view filter add TARGET --field FIELD', [target, option('field', 'FIELD', 'Filter field.'), option('operator', 'OP', 'Filter operator.', { default: 'contains' }), option('values', 'JSON', 'Filter value list.', { default: '[]' }), option('logic', 'all|any', 'Filter value logic.', { default: 'any' })]),
  'view filter set': contract(ViewFilterSetInputSchema, 'view filter set TARGET --rule ID [PATCH OPTIONS]', [target, option('rule', 'ID', 'Filter-rule Node ID.'), option('field', 'FIELD', 'Filter field.'), option('operator', 'OP', 'Filter operator.'), option('values', 'JSON', 'Filter value list.'), option('logic', 'all|any', 'Filter value logic.')]),
  'view filter remove': contract(ViewRuleInputSchema, 'view filter remove TARGET --rule ID', [target, option('rule', 'ID', 'Filter-rule Node ID.')]),
  'view filter clear': contract(TargetOnlySchema, 'view filter clear TARGET', [target]),
  'view display add': contract(ViewDisplayAddInputSchema, 'view display add TARGET --field FIELD', [target, option('field', 'FIELD', 'Display field.')]),
  'view display set': contract(ViewDisplaySetInputSchema, 'view display set TARGET --display-field ID --value JSON', [target, option('display-field', 'ID', 'Display-field Node ID.'), value]),
  'view display remove': contract(ViewDisplayRemoveInputSchema, 'view display remove TARGET --display-field ID', [target, option('display-field', 'ID', 'Display-field Node ID.')]),
  'search create': contract(SearchCreateInputSchema, 'search create [PARENT] TITLE (--match TEXT | --query JSON|FILE) | search create --input FILE|-', [parent, option('title', 'TITLE', 'Saved Search title.'), option('match', 'TEXT', 'Ergonomic STRING_MATCH shorthand.'), option('query', 'JSON|FILE', 'Canonical structured query.'), option('view', 'MODE', 'Initial view mode.'), option('sort', 'FIELD:DIRECTION', 'Append one initial sort rule.'), option('filter', 'JSON', 'Append one initial filter rule.'), option('group', 'FIELD|null', 'Set initial grouping.'), option('display', 'FIELD', 'Append one initial display field.'), option('toolbar', 'BOOLEAN', 'Set initial toolbar visibility.'), bind], ['outline search create --title "Modules" --match "module" --view table --sort sys:updatedAt:desc']),
  'search ensure-tag': contract(SearchEnsureTagInputSchema, 'search ensure-tag TAG', [option('tag', 'TAG', 'Tag definition target.'), bind]),
  'search set': contract(SearchSetInputSchema, 'search set TARGET [--title TITLE] [--query JSON|FILE]', [target, option('title', 'TITLE', 'Patch the Search title.'), option('match', 'TEXT', 'Set a STRING_MATCH query.'), option('query', 'JSON|FILE', 'Set the canonical structured query.'), option('view', 'MODE', 'Patch view mode.'), option('replace', 'JSON|FILE', 'Explicitly replace view collections.')]),
  'search refresh': contract(TargetOnlySchema, 'search refresh TARGET', [target]),
  'template apply': contract(Type.Object({ tag: TargetRefSchema }, closed), 'template apply TAG', [option('tag', 'TAG', 'Tag definition target.')]),
  'daily ensure': contract(DailyEnsureInputSchema, 'daily ensure YYYY-MM-DD', [option('date', 'YYYY-MM-DD', 'Local calendar date.'), bind]),
  'capture add': contract(CaptureAddInputSchema, 'capture add (--parent TARGET | --date YYYY-MM-DD) --title TITLE --metadata FILE', [parent, option('date', 'YYYY-MM-DD', 'Ensure and capture below this local date.'), option('title', 'TITLE', 'Capture title.'), option('description', 'TEXT', 'Capture description.'), option('metadata', 'JSON|FILE', 'Capture provenance.'), option('tree', 'FILE|-', 'Typed captured child tree.'), bind]),
  'media add': contract(MediaAddInputSchema, 'media add PARENT TYPE PATH|-', [parent, option('type', 'image|attachment', 'Media Node type.'), option('name', 'NAME', 'Media label.'), option('source', 'PATH|-', 'Stage a local path or stdin in this invocation.'), option('lease', 'LEASE', 'Use an explicitly staged asset lease.'), option('url', 'URL', 'Use an external image URL.'), option('metadata', 'JSON|FILE', 'Image dimensions and alt text.'), bind]),
  'media set': contract(MediaSetInputSchema, 'media set TARGET [PROPERTY OPTIONS]', [target, option('lease', 'LEASE', 'Set an asset lease.'), option('url', 'URL', 'Set an external media URL.'), option('width', 'NUMBER', 'Set media width.'), option('height', 'NUMBER', 'Set media height.')]),
  trash: contract(TargetOnlySchema, 'trash TARGET', [target]),
  restore: contract(TargetOnlySchema, 'restore TARGET', [target]),
  purge: contract(TargetOnlySchema, 'purge TARGET [--contents]', [target, option('contents', undefined, 'Purge the contents of Trash.')]),
} satisfies Readonly<Record<string, PorcelainBaseContract>>);

type PorcelainCommandKey = keyof typeof PORCELAIN_BASE_CONTRACTS;

const PORCELAIN_SUMMARIES = {
  add: 'Create one complete typed Node tree below a parent.',
  set: 'Patch content, description, code, checkbox, icon, banner, or image state.',
  'text replace': 'Replace literal text across one exact or bounded query-selected Node set.',
  move: 'Move a bounded Node selection below one destination.',
  duplicate: 'Duplicate a bounded Node selection below one destination.',
  merge: 'Merge source Nodes into one target after exact Diff review.',
  indent: 'Move one Node below its preceding sibling.',
  outdent: 'Move one Node after its parent.',
  'done set': 'Set done state on a bounded Node selection.',
  'done cycle': 'Cycle done state on one exact Node.',
  'tag add': 'Apply a tag definition to a bounded Node selection.',
  'tag remove': 'Remove a tag definition from a bounded Node selection.',
  'field define': 'Create or reuse a field on a target and optionally set its initial value.',
  'field set': 'Set one field value on a bounded Node selection.',
  'field clear': 'Clear one field value while retaining the field slot.',
  'field remove': 'Remove one field slot from a bounded Node selection.',
  'field reuse': 'Replace a local field definition with a reusable definition.',
  'field select': 'Select one option for a field on a bounded Node selection.',
  'definition create': 'Create a complete tag or field definition.',
  'definition configure': 'Patch type-specific definition configuration.',
  'definition merge': 'Merge source definitions into one target after exact Diff review.',
  'reference add': 'Add a reference from a bounded Node selection.',
  'reference set': 'Replace the target of an existing reference.',
  'reference replace': 'Replace one content Node with a tree reference and move the original subtree to Trash.',
  'reference inline': 'Convert a tree reference to inline form or replace one content Node with an explicit inline reference.',
  'reference restore': 'Restore an inlined Node to a reference.',
  'view set': 'Apply one complete declarative view patch with explicit collection replacement.',
  'view group set': 'Set or clear the view grouping field.',
  'view sort add': 'Append one sort rule to a view.',
  'view sort set': 'Patch one existing sort rule.',
  'view sort remove': 'Remove one existing sort rule.',
  'view sort clear': 'Clear all sort rules from a view.',
  'view filter add': 'Append one filter rule to a view.',
  'view filter set': 'Patch one existing filter rule.',
  'view filter remove': 'Remove one existing filter rule.',
  'view filter clear': 'Clear all filter rules from a view.',
  'view display add': 'Append one display field to a view.',
  'view display set': 'Patch one existing display field.',
  'view display remove': 'Remove one existing display field.',
  'search create': 'Create a complete Saved Search and its initial materialized view.',
  'search ensure-tag': 'Ensure the canonical Saved Search for one tag exists.',
  'search set': 'Atomically patch a Search query, title, and view, then refresh results.',
  'search refresh': 'Refresh materialized results for a Search.',
  'template apply': 'Preview or apply template backfill to all matching tagged Nodes.',
  'daily ensure': 'Ensure one local-date Daily Note exists.',
  'capture add': 'Ensure an optional date and create a provenanced typed capture tree.',
  'media add': 'Stage a local asset and create its media Node in one invocation.',
  'media set': 'Patch image or attachment metadata and source.',
  trash: 'Move a bounded Node selection to Trash.',
  restore: 'Restore a bounded Node selection from Trash.',
  purge: 'Permanently purge selected Nodes or Empty Trash after exact Diff review.',
} satisfies Record<PorcelainCommandKey, string>;

const PORCELAIN_EXAMPLES = {
  add: ['outline add @inbox "Project brief"', 'outline add --input complete-tree.json'],
  set: ['outline set node:brief --description "Ready for review"', 'outline set --input node-patch.json'],
  'text replace': ['outline text replace node:brief --find "draft" --replace "final" --preview --idempotency-key cli:review-replace', 'outline text replace --matching "keyword 1" --max 500 --find "keyword 1" --replace "keyword 2" --preview --idempotency-key cli:review-batch-replace', 'outline text replace --input replace.json --idempotency-key cli:review-replace --expect-diff SHA256 --yes'],
  move: ['outline move node:task node:project --index 0', 'outline move --input move.json'],
  duplicate: ['outline duplicate node:template node:project', 'outline duplicate --input duplicate.json'],
  merge: ['outline merge node:duplicate node:canonical --preview --idempotency-key cli:review-merge', 'outline merge node:duplicate node:canonical --idempotency-key cli:review-merge --expect-diff SHA256 --yes'],
  indent: ['outline indent node:task', 'outline indent --input indent.json'],
  outdent: ['outline outdent node:task', 'outline outdent --input outdent.json'],
  'done set': ['outline done set node:task true', 'outline done set --input done-many.json'],
  'done cycle': ['outline done cycle node:task', 'outline done cycle --input done-cycle.json'],
  'tag add': ['outline tag add node:task tag:priority', 'outline tag add --input tag-many.json'],
  'tag remove': ['outline tag remove node:task tag:priority', 'outline tag remove --input untag-many.json'],
  'field define': ['outline field define node:project Status --field-type select --value Active', 'outline field define --input field-with-value.json'],
  'field set': ['outline field set node:project field:status Active', 'outline field set --input field-many.json'],
  'field clear': ['outline field clear node:project field:status', 'outline field clear --input field-clear-many.json'],
  'field remove': ['outline field remove node:project field:status', 'outline field remove --input field-remove-many.json'],
  'field reuse': ['outline field reuse node:project field:local field:status', 'outline field reuse --input field-reuse.json'],
  'field select': ['outline field select node:project field:status option:active', 'outline field select --input field-select-many.json'],
  'definition create': ['outline definition create field Status --field-type select --options options.json', 'outline definition create --input complete-definition.json'],
  'definition configure': ['outline definition configure field:status field --patch field-patch.json', 'outline definition configure --input definition-patch.json'],
  'definition merge': ['outline definition merge tag:duplicate tag:canonical --preview --idempotency-key cli:review-definition-merge', 'outline definition merge tag:duplicate tag:canonical --idempotency-key cli:review-definition-merge --expect-diff SHA256 --yes'],
  'reference add': ['outline reference add node:brief node:source', 'outline reference add --input references-many.json'],
  'reference set': ['outline reference set node:reference node:new-target', 'outline reference set --input reference-retarget.json'],
  'reference replace': ['outline reference replace node:draft node:canonical', 'outline reference replace --input node-to-reference.json'],
  'reference inline': ['outline reference inline node:reference', 'outline reference inline node:draft node:canonical', 'outline reference inline --input reference-inline.json'],
  'reference restore': ['outline reference restore node:inline node:source', 'outline reference restore --input reference-restore.json'],
  'view set': ['outline view set node:projects table --toolbar true --group field:status', 'outline view set --input complete-view.json'],
  'view group set': ['outline view group set node:projects field:status', 'outline view group set node:projects null'],
  'view sort add': ['outline view sort add node:projects --field sys:updatedAt --direction desc', 'outline view sort add --input sort-rule.json'],
  'view sort set': ['outline view sort set node:projects --rule sort:1 --field field:priority --direction asc', 'outline view sort set --input sort-rule-patch.json'],
  'view sort remove': ['outline view sort remove node:projects --rule sort:1', 'outline view sort remove --input sort-rule-remove.json'],
  'view sort clear': ['outline view sort clear node:projects', 'outline view sort clear --input sort-clear.json'],
  'view filter add': ['outline view filter add node:projects --field field:status --values \'["Active"]\'', 'outline view filter add --input filter-rule.json'],
  'view filter set': ['outline view filter set node:projects --rule filter:1 --operator equals', 'outline view filter set --input filter-rule-patch.json'],
  'view filter remove': ['outline view filter remove node:projects --rule filter:1', 'outline view filter remove --input filter-rule-remove.json'],
  'view filter clear': ['outline view filter clear node:projects', 'outline view filter clear --input filter-clear.json'],
  'view display add': ['outline view display add node:projects --field field:owner', 'outline view display add --input display-field.json'],
  'view display set': ['outline view display set node:projects --display-field display:owner --value \'{"visible":true}\'', 'outline view display set --input display-field-patch.json'],
  'view display remove': ['outline view display remove node:projects --display-field display:owner', 'outline view display remove --input display-field-remove.json'],
  'search create': ['outline search create --title "Modules" --match "module" --view table --sort sys:updatedAt:desc', 'outline search create --input complete-search.json'],
  'search ensure-tag': ['outline search ensure-tag tag:project', 'outline search ensure-tag --input ensure-tag-search.json'],
  'search set': ['outline search set node:modules --match "runtime" --view table', 'outline search set --input complete-search-patch.json'],
  'search refresh': ['outline search refresh node:modules', 'outline search refresh --input refresh-search.json'],
  'template apply': ['outline template apply tag:project --preview', 'outline template apply --input template-backfill.json --preview'],
  'daily ensure': ['outline daily ensure 2026-08-24', 'outline daily ensure --input ensure-date.json'],
  'capture add': ['outline capture add --date 2026-08-24 --title "Reading note" --metadata provenance.json', 'outline capture add --input complete-capture.json'],
  'media add': ['outline media add @inbox image ./diagram.png', 'outline media add @inbox attachment -'],
  'media set': ['outline media set node:image --width 1280 --height 720', 'outline media set --input media-patch.json'],
  trash: ['outline trash node:obsolete', 'outline trash --input trash-many.json'],
  restore: ['outline restore node:obsolete', 'outline restore --input restore-many.json'],
  purge: ['outline purge @trash --contents --preview --idempotency-key cli:review-purge', 'outline purge @trash --contents --idempotency-key cli:review-purge --expect-diff SHA256 --yes'],
} satisfies Record<PorcelainCommandKey, readonly [string, string, ...string[]]>;

const CREATE_COMMANDS = new Set<PorcelainCommandKey>([
  'add', 'duplicate', 'field define', 'definition create', 'view sort add', 'view filter add',
  'view display add', 'search create', 'capture add', 'media add',
]);
const ENSURE_COMMANDS = new Set<PorcelainCommandKey>(['search ensure-tag', 'daily ensure']);
const DESTRUCTIVE_COMMANDS = new Set<PorcelainCommandKey>(['text replace', 'merge', 'definition merge', 'purge']);
const REPLACE_COMMANDS = new Set<PorcelainCommandKey>(['reference replace']);
const IDEMPOTENT_COMMANDS = new Set<PorcelainCommandKey>([
  'set', 'text replace', 'move', 'done set', 'tag add', 'tag remove', 'field define', 'field set', 'field clear',
  'field remove', 'field reuse', 'field select', 'definition configure', 'reference set', 'view set',
  'view group set', 'view sort set', 'view sort remove', 'view sort clear', 'view filter set',
  'view filter remove', 'view filter clear', 'view display set', 'view display remove', 'search ensure-tag',
  'search set', 'search refresh', 'template apply', 'daily ensure', 'media set', 'trash', 'restore',
]);
const EXACT_TARGET_COMMANDS = new Set<PorcelainCommandKey>([
  'indent', 'outdent', 'done cycle', 'reference replace', 'reference inline', 'reference restore', 'view sort set',
  'view sort remove', 'view filter set', 'view filter remove', 'view display set', 'view display remove',
]);

const PORCELAIN_DEFAULTS: Partial<Record<PorcelainCommandKey, readonly string[]>> = {
  'text replace': ['Field defaults to content, occurrence to all, case-sensitive matching to true, and max replacements to 1000.', 'Matches use UTF-16 offsets. Rich-text marks and references outside replacement ranges are preserved; a replacement that would consume an inline reference is rejected.'],
  'search create': ['Parent defaults to @saved-searches.', 'Omitted view properties use the Saved Search defaults.'],
  'view sort add': ['Sort direction defaults to asc.'],
  'view filter add': ['Operator defaults to contains, values to [], and value logic to any.'],
  'field define': ['Field type defaults to text when a new definition is created.'],
  'reference inline': ['REFERENCE may be omitted only when TARGET is already a tree reference. Structured input always includes reference.'],
  'daily ensure': ['The local calendar date is interpreted without a timezone conversion.'],
};

function finalizePorcelainContract<Name extends PorcelainCommandKey>(
  name: Name,
  base: (typeof PORCELAIN_BASE_CONTRACTS)[Name],
): PorcelainContract {
  const destructive = DESTRUCTIVE_COMMANDS.has(name);
  const behavior = destructive
    ? 'destructive'
    : CREATE_COMMANDS.has(name)
      ? 'create'
      : ENSURE_COMMANDS.has(name)
        ? 'ensure'
        : REPLACE_COMMANDS.has(name)
          ? 'replace'
          : 'patch';
  const idempotent = IDEMPOTENT_COMMANDS.has(name);
  return Object.freeze({
    ...base,
    summary: PORCELAIN_SUMMARIES[name],
    behavior,
    idempotent,
    positionals: Object.freeze([`Exact positional forms: ${base.usage}.`]),
    selectors: 'TARGET and PARENT accept a Node ID, typed ID, semantic @alias, or a FILE containing Selector, TargetSpec, or binding JSON.',
    cardinality: EXACT_TARGET_COMMANDS.has(name)
      ? 'This command requires one exact target. Structured many selectors are rejected.'
      : 'Structured selectors must declare one, zero-or-one, or many cardinality; many mutations require an explicit max bound.',
    input: `Use argv for common shorthand. Use --input FILE|- for one ${name}-specific JSON object; inspect it with outline schema ${name}.`,
    output: 'Preview returns one normalized Diff. Apply returns one Operation or semantic no-change result; created or ensured IDs are included in the bounded return Projection.',
    defaults: Object.freeze([
      ...(PORCELAIN_DEFAULTS[name] ?? []),
      ...(behavior === 'patch' ? ['Omitted patch properties preserve current state.'] : []),
      ...(name === 'view set' || name === 'search set' ? ['Only the explicitly named replace object replaces sort, filter, or display collections.'] : []),
    ]),
    destructive,
    examples: Object.freeze(PORCELAIN_EXAMPLES[name]),
  });
}

export const PORCELAIN_CONTRACTS = Object.freeze(Object.fromEntries(
  Object.entries(PORCELAIN_BASE_CONTRACTS).map(([name, base]) => [
    name,
    finalizePorcelainContract(name as PorcelainCommandKey, base),
  ]),
) as { readonly [Name in PorcelainCommandKey]: PorcelainContract });

export type PorcelainCommandName = keyof typeof PORCELAIN_CONTRACTS;

export function porcelainContract(name: string): PorcelainContract | undefined {
  return PORCELAIN_CONTRACTS[name as PorcelainCommandName];
}
