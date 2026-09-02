import Type, { type TSchema } from 'typebox';
import { outlineRecipeVariants } from './recipes';
import {
  CaptureProvenanceSchema,
  FilterOperatorSchema,
  FilterValueLogicSchema,
  IdentifierSchema,
  LocalDateSchema,
  NodeDraftSchema,
  NodeIdentifierSchema,
  QueryExpressionSchema,
  RichTextSchema,
  TagDefinitionPatchSchema,
  ViewSystemFieldSchema,
  SortDirectionSchema,
  DisplayPlacementSchema,
  ExactLocatorInputSchema,
  BoundedSelectionInputSchema,
} from './schemas';

const closed = { additionalProperties: false } as const;
const OptionalBind = Type.Optional(Type.String({ pattern: '^[A-Za-z][A-Za-z0-9_-]{0,63}$' }));
const ScalarValueSchema = Type.Union([
  Type.String({ maxLength: 4_194_304 }),
  Type.Number(),
  Type.Boolean(),
  Type.Null(),
]);

export const PublicFieldTypeSchema = Type.Union([
  Type.Literal('text'), Type.Literal('select'), Type.Literal('select-from-tag'),
  Type.Literal('date'), Type.Literal('number'), Type.Literal('url'),
  Type.Literal('email'), Type.Literal('checkbox'),
]);

export const PUBLIC_FIELD_TYPES = Object.freeze({
  text: 'plain',
  select: 'options',
  'select-from-tag': 'options_from_supertag',
  date: 'date',
  number: 'number',
  url: 'uri',
  email: 'email',
  checkbox: 'checkbox',
} as const);

export type PublicFieldType = keyof typeof PUBLIC_FIELD_TYPES;

export function publicFieldTypeFromCore(type: (typeof PUBLIC_FIELD_TYPES)[PublicFieldType]): PublicFieldType {
  const match = Object.entries(PUBLIC_FIELD_TYPES)
    .find(([, coreType]) => coreType === type)?.[0];
  if (!match) throw new Error(`Unknown Core Field type: ${type}`);
  return match as PublicFieldType;
}

const PublicFieldConfigSchema = Type.Object({
  nullable: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
  hide: Type.Optional(Type.Union([
    Type.Literal('never'), Type.Literal('empty'), Type.Literal('not-empty'),
    Type.Literal('default'), Type.Literal('always'), Type.Null(),
  ])),
  autoInitialize: Type.Optional(Type.Union([Type.String({ maxLength: 128 }), Type.Null()])),
  collectOptions: Type.Optional(Type.Boolean()),
  min: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
  max: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
  sourceTag: Type.Optional(Type.Union([ExactLocatorInputSchema, Type.Null()])),
}, closed);

const PublicViewModeSchema = Type.Union([
  Type.Literal('outline'), Type.Literal('table'), Type.Literal('cards'), Type.Literal('calendar'),
]);

const CreateFieldKeySchema = Type.String({ pattern: '^[A-Za-z][A-Za-z0-9_-]{0,63}$' });

const CreateNodeSchema = Type.Cyclic({
  CreateNode: Type.Object({
    text: Type.Union([Type.String({ maxLength: 4_194_304 }), RichTextSchema]),
    description: Type.Optional(Type.String({ maxLength: 4_194_304 })),
    codeLanguage: Type.Optional(Type.String({ maxLength: 128 })),
    checkbox: Type.Optional(Type.Boolean()),
    done: Type.Optional(Type.Boolean()),
    tags: Type.Optional(Type.Array(ExactLocatorInputSchema, { uniqueItems: true, maxItems: 1_024 })),
    reference: Type.Optional(ExactLocatorInputSchema),
    fields: Type.Optional(Type.Record(CreateFieldKeySchema, ScalarValueSchema, { maxProperties: 256 })),
    children: Type.Optional(Type.Array(Type.Ref('CreateNode'), { maxItems: 100_000 })),
  }, closed),
}, 'CreateNode');

const CreatePlacementSchema = Type.Union([
  Type.Object({ parent: ExactLocatorInputSchema, position: Type.Optional(Type.Literal('first')) }, closed),
  Type.Object({ parent: ExactLocatorInputSchema, position: Type.Optional(Type.Literal('last')) }, closed),
  Type.Object({ parent: ExactLocatorInputSchema, position: Type.Literal('index'), index: Type.Integer({ minimum: 0 }) }, closed),
  Type.Object({ sibling: ExactLocatorInputSchema, position: Type.Literal('before') }, closed),
  Type.Object({ sibling: ExactLocatorInputSchema, position: Type.Literal('after') }, closed),
]);

const CreateViewFieldSchema = Type.Union([ViewSystemFieldSchema, CreateFieldKeySchema]);
const CreateViewSchema = Type.Object({
  mode: Type.Optional(PublicViewModeSchema),
  toolbar: Type.Optional(Type.Boolean()),
  group: Type.Optional(Type.Union([CreateViewFieldSchema, Type.Null()])),
  sort: Type.Optional(Type.Array(Type.Object({
    field: CreateViewFieldSchema,
    direction: Type.Optional(SortDirectionSchema),
  }, closed), { maxItems: 1_000 })),
  filters: Type.Optional(Type.Array(Type.Object({
    field: CreateViewFieldSchema,
    operator: Type.Optional(FilterOperatorSchema),
    values: Type.Optional(Type.Array(Type.String({ maxLength: 65_536 }), { maxItems: 10_000 })),
    valueLogic: Type.Optional(FilterValueLogicSchema),
  }, closed), { maxItems: 1_000 })),
  display: Type.Optional(Type.Array(Type.Union([
    CreateViewFieldSchema,
    Type.Object({
      field: CreateViewFieldSchema,
      visible: Type.Optional(Type.Boolean()),
      width: Type.Optional(Type.Number({ minimum: 0 })),
      label: Type.Optional(Type.Union([Type.String({ maxLength: 4_096 }), Type.Null()])),
      placement: Type.Optional(DisplayPlacementSchema),
    }, closed),
  ]), { maxItems: 1_000 })),
}, closed);

export const CreateInputSchema = Type.Object({
  at: CreatePlacementSchema,
  fields: Type.Optional(Type.Array(Type.Union([
    Type.Object({
      key: CreateFieldKeySchema,
      name: Type.String({ minLength: 1, maxLength: 1_024 }),
      type: Type.Optional(PublicFieldTypeSchema),
      config: Type.Optional(PublicFieldConfigSchema),
    }, closed),
    Type.Object({ key: CreateFieldKeySchema, field: ExactLocatorInputSchema }, closed),
  ]), { maxItems: 256 })),
  node: CreateNodeSchema,
  view: Type.Optional(CreateViewSchema),
  bind: OptionalBind,
}, closed);

const EditInputSchema = Type.Object({
  target: BoundedSelectionInputSchema,
  node: Type.Optional(Type.Object({
    text: Type.Optional(Type.String({ maxLength: 4_194_304 })),
    description: Type.Optional(Type.Union([Type.String({ maxLength: 4_194_304 }), Type.Null()])),
    codeLanguage: Type.Optional(Type.Union([Type.String({ maxLength: 128 }), Type.Null()])),
    checkbox: Type.Optional(Type.Boolean()),
    done: Type.Optional(Type.Boolean()),
    icon: Type.Optional(Type.Union([Type.String({ maxLength: 4_096 }), Type.Null()])),
    iconKind: Type.Optional(Type.String({ maxLength: 128 })),
  }, { ...closed, minProperties: 1 })),
  tags: Type.Optional(Type.Object({
    add: Type.Optional(Type.Array(ExactLocatorInputSchema, { uniqueItems: true, maxItems: 1_024 })),
    remove: Type.Optional(Type.Array(ExactLocatorInputSchema, { uniqueItems: true, maxItems: 1_024 })),
  }, { ...closed, minProperties: 1 })),
  fields: Type.Optional(Type.Array(Type.Union([
    Type.Object({ field: ExactLocatorInputSchema, action: Type.Optional(Type.Literal('set')), value: ScalarValueSchema }, closed),
    Type.Object({ field: ExactLocatorInputSchema, action: Type.Union([Type.Literal('clear'), Type.Literal('remove')]) }, closed),
    Type.Object({ field: ExactLocatorInputSchema, action: Type.Literal('select'), option: ExactLocatorInputSchema }, closed),
  ]), { maxItems: 1_024 })),
  references: Type.Optional(Type.Array(Type.Object({
    action: Type.Union([
      Type.Literal('add'), Type.Literal('retarget'), Type.Literal('replace'),
      Type.Literal('inline'), Type.Literal('restore'),
    ]),
    target: ExactLocatorInputSchema,
  }, closed), { maxItems: 1_024 })),
  sources: Type.Optional(Type.Array(Type.Union([
    Type.Object({
      action: Type.Literal('add'),
      text: Type.String({ maxLength: 32_768 }),
      id: Type.Optional(NodeIdentifierSchema),
      after: Type.Optional(Type.Union([ExactLocatorInputSchema, Type.Null()])),
    }, closed),
    Type.Object({
      action: Type.Literal('replace'),
      value: ExactLocatorInputSchema,
      text: Type.String({ maxLength: 32_768 }),
    }, closed),
    Type.Object({
      action: Type.Literal('reorder'),
      value: ExactLocatorInputSchema,
      after: Type.Union([ExactLocatorInputSchema, Type.Null()]),
    }, closed),
    Type.Object({ action: Type.Literal('remove'), value: ExactLocatorInputSchema }, closed),
    Type.Object({ action: Type.Literal('clear') }, closed),
  ]), { maxItems: 1_024 })),
}, { ...closed, minProperties: 2 });

const DefineFieldInputSchema = Type.Object({
  kind: Type.Literal('field'),
  name: Type.String({ minLength: 1, maxLength: 1_024 }),
  type: Type.Optional(PublicFieldTypeSchema),
  config: Type.Optional(PublicFieldConfigSchema),
  id: Type.Optional(IdentifierSchema),
  bind: OptionalBind,
}, closed);
const DefineTagInputSchema = Type.Object({
  kind: Type.Literal('tag'),
  name: Type.String({ minLength: 1, maxLength: 1_024 }),
  id: Type.Optional(IdentifierSchema),
  bind: OptionalBind,
}, closed);
const DefineCreateInputSchema = Type.Union([DefineFieldInputSchema, DefineTagInputSchema]);
const DefineEnsureInputSchema = Type.Union([DefineFieldInputSchema, DefineTagInputSchema]);
const DefineEditInputSchema = Type.Union([
  Type.Object({
    target: ExactLocatorInputSchema,
    kind: Type.Literal('field'),
    type: Type.Optional(PublicFieldTypeSchema),
    config: Type.Optional(PublicFieldConfigSchema),
  }, { ...closed, minProperties: 3 }),
  Type.Object({
    target: ExactLocatorInputSchema,
    kind: Type.Literal('tag'),
    config: TagDefinitionPatchSchema,
  }, closed),
]);

const ViewFieldInputSchema = Type.Union([ViewSystemFieldSchema, ExactLocatorInputSchema]);
export const ViewSortSpecSchema = Type.Object({
  field: ViewFieldInputSchema,
  direction: Type.Optional(SortDirectionSchema),
}, closed);
export const ViewFilterSpecSchema = Type.Object({
  field: ViewFieldInputSchema,
  operator: Type.Optional(FilterOperatorSchema),
  values: Type.Optional(Type.Array(Type.String({ maxLength: 65_536 }), { maxItems: 10_000 })),
  valueLogic: Type.Optional(FilterValueLogicSchema),
}, closed);
export const ViewDisplaySpecSchema = Type.Object({
  field: ViewFieldInputSchema,
  visible: Type.Optional(Type.Boolean()),
  width: Type.Optional(Type.Number({ minimum: 0 })),
  order: Type.Optional(Type.Number()),
  label: Type.Optional(Type.Union([Type.String({ maxLength: 4_096 }), Type.Null()])),
  placement: Type.Optional(DisplayPlacementSchema),
}, closed);
export const ViewCreateSpecSchema = Type.Object({
  mode: Type.Optional(PublicViewModeSchema),
  toolbar: Type.Optional(Type.Boolean()),
  group: Type.Optional(Type.Union([ViewFieldInputSchema, Type.Null()])),
  sort: Type.Optional(Type.Array(ViewSortSpecSchema, { maxItems: 1_000 })),
  filters: Type.Optional(Type.Array(ViewFilterSpecSchema, { maxItems: 1_000 })),
  display: Type.Optional(Type.Array(ViewDisplaySpecSchema, { maxItems: 1_000 })),
}, closed);
export const ViewSetSpecSchema = Type.Object({
  mode: Type.Optional(PublicViewModeSchema),
  toolbar: Type.Optional(Type.Boolean()),
  group: Type.Optional(Type.Union([ViewFieldInputSchema, Type.Null()])),
  replace: Type.Optional(Type.Object({
    sort: Type.Optional(Type.Array(ViewSortSpecSchema, { maxItems: 1_000 })),
    filters: Type.Optional(Type.Array(ViewFilterSpecSchema, { maxItems: 1_000 })),
    display: Type.Optional(Type.Array(ViewDisplaySpecSchema, { maxItems: 1_000 })),
  }, { ...closed, minProperties: 1 })),
}, { ...closed, minProperties: 1 });

const TargetOnlySchema = Type.Object({ target: BoundedSelectionInputSchema }, closed);
const ExactTargetOnlySchema = Type.Object({ target: ExactLocatorInputSchema }, closed);

const ExactDestinationPlacementInputSchema = Type.Union([
  Type.Object({ kind: Type.Literal('first'), parent: ExactLocatorInputSchema }, closed),
  Type.Object({ kind: Type.Literal('last'), parent: ExactLocatorInputSchema }, closed),
  Type.Object({ kind: Type.Literal('index'), parent: ExactLocatorInputSchema, index: Type.Integer({ minimum: 0 }) }, closed),
  Type.Object({ kind: Type.Literal('before'), sibling: ExactLocatorInputSchema }, closed),
  Type.Object({ kind: Type.Literal('after'), sibling: ExactLocatorInputSchema }, closed),
]);

const ExactPlacementInputSchema = Type.Union([
  ExactDestinationPlacementInputSchema,
  Type.Object({ kind: Type.Literal('previous') }, closed),
  Type.Object({ kind: Type.Literal('next') }, closed),
]);

const TextReplaceInputSchema = Type.Object({
  target: BoundedSelectionInputSchema,
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
  target: BoundedSelectionInputSchema,
  placement: ExactPlacementInputSchema,
}, closed);

const DuplicateInputSchema = Type.Object({
  target: BoundedSelectionInputSchema,
  placement: ExactPlacementInputSchema,
  bind: OptionalBind,
}, closed);

const MergeInputSchema = Type.Object({ source: BoundedSelectionInputSchema, target: ExactLocatorInputSchema }, closed);
const ViewSetInputSchema = Type.Object({ target: ExactLocatorInputSchema, view: ViewSetSpecSchema }, closed);
const SearchCreateInputSchema = Type.Union([
  Type.Object({
    parent: Type.Optional(ExactLocatorInputSchema),
    title: Type.String({ minLength: 1, maxLength: 4_194_304 }),
    query: QueryExpressionSchema,
    view: Type.Optional(ViewCreateSpecSchema),
    bind: OptionalBind,
  }, closed),
  Type.Object({
    parent: Type.Optional(ExactLocatorInputSchema),
    title: Type.String({ minLength: 1, maxLength: 4_194_304 }),
    match: Type.String({ minLength: 1, maxLength: 65_536 }),
    view: Type.Optional(ViewCreateSpecSchema),
    bind: OptionalBind,
  }, closed),
]);
const SearchSetInputSchema = Type.Union([
  Type.Object({
    target: ExactLocatorInputSchema,
    title: Type.Optional(Type.String({ minLength: 1, maxLength: 4_194_304 })),
    query: Type.Optional(QueryExpressionSchema),
    view: Type.Optional(ViewSetSpecSchema),
  }, { ...closed, minProperties: 2 }),
  Type.Object({
    target: ExactLocatorInputSchema,
    title: Type.Optional(Type.String({ minLength: 1, maxLength: 4_194_304 })),
    match: Type.Optional(Type.String({ minLength: 1, maxLength: 65_536 })),
    view: Type.Optional(ViewSetSpecSchema),
  }, { ...closed, minProperties: 2 }),
]);
const DailyEnsureInputSchema = Type.Object({ date: LocalDateSchema, bind: OptionalBind }, closed);

const CaptureAddInputSchema = Type.Union([
  Type.Object({
    parent: ExactLocatorInputSchema,
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
  create: contract(CreateInputSchema, 'create PARENT TEXT | create --input FILE|-', [parent, option('first', undefined, 'Insert first under PARENT.'), option('last', undefined, 'Insert last under PARENT.', { default: 'true' }), option('index', 'INDEX', 'Insert at a zero-based child index under PARENT.'), option('before', 'SIBLING', 'Insert immediately before one exact sibling.'), option('after', 'SIBLING', 'Insert immediately after one exact sibling.'), bind]),
  edit: contract(EditInputSchema, 'edit TARGET --text TEXT | edit --input FILE|-', [target, option('text', 'TEXT', 'Set Node text.'), option('description', 'TEXT|null', 'Set or clear the description.'), option('done', 'BOOLEAN', 'Set completion state.'), option('checkbox', 'BOOLEAN', 'Set checkbox visibility.')]),
  'replace text': contract(TextReplaceInputSchema, 'replace text TARGET --find TEXT --with TEXT | replace text --input FILE|-', [target, option('matching', 'TEXT', 'Select a bounded many target with text shorthand.'), option('query', 'JSON|FILE', 'Select with the canonical structured query.'), option('within', 'SELECTOR', 'Bound query selection below one exact Selector.'), option('include-trash', undefined, 'Include trashed Nodes.'), option('order', 'ORDER', 'Use document, created, updated, or text query order.', { default: 'document' }), option('max', 'N', 'Required maximum Node count for query selection.'), option('find', 'TEXT', 'Literal text to replace.'), option('with', 'TEXT', 'Replacement text.'), option('field', 'content|description|both', 'Select transformed fields.', { default: 'content' }), option('occurrence', 'first|all', 'Replace the first or all matches.', { default: 'all' }), option('case-sensitive', 'BOOLEAN', 'Use case-sensitive matching.', { default: 'true' }), option('max-replacements', 'N', 'Bound total replacements.', { default: '1000' })]),
  'define create': contract(DefineCreateInputSchema, 'define create --input FILE|-', []),
  'define ensure': contract(DefineEnsureInputSchema, 'define ensure --input FILE|-', []),
  'define edit': contract(DefineEditInputSchema, 'define edit --input FILE|-', []),
  'search edit': contract(SearchSetInputSchema, 'search edit TARGET [--title TITLE] [--query JSON|FILE]', [target, option('title', 'TITLE', 'Set the Search title.'), option('match', 'TEXT', 'Set a text query.'), option('query', 'JSON|FILE', 'Set the canonical query.'), option('view', 'MODE', 'Set the View mode.'), option('replace', 'JSON|FILE', 'Replace View collections explicitly.')]),
  'capture create': contract(CaptureAddInputSchema, 'capture create (--parent TARGET | --date YYYY-MM-DD) --title TITLE --metadata FILE', [parent, option('date', 'YYYY-MM-DD', 'Ensure and capture below this local date.'), option('title', 'TITLE', 'Capture title.'), option('description', 'TEXT', 'Capture description.'), option('metadata', 'JSON|FILE', 'Capture provenance.'), option('tree', 'FILE|-', 'Typed captured child tree.'), bind]),
  move: contract(MoveInputSchema, 'move TARGET DESTINATION | move TARGET --before|--after SIBLING | move TARGET --previous|--next', [target, option('destination', 'TARGET', 'Destination parent for first, last, or index placement.'), option('first', undefined, 'Place first under DESTINATION.'), option('last', undefined, 'Place last under DESTINATION.', { default: 'true' }), option('index', 'INDEX', 'Place at a zero-based index under DESTINATION.'), option('before', 'SIBLING', 'Place immediately before one exact sibling.'), option('after', 'SIBLING', 'Place immediately after one exact sibling.'), option('previous', undefined, 'Move the selected sibling block one position earlier.'), option('next', undefined, 'Move the selected sibling block one position later.')]),
  duplicate: contract(DuplicateInputSchema, 'duplicate TARGET DESTINATION | duplicate TARGET --before|--after SIBLING | duplicate TARGET --previous|--next', [target, option('destination', 'TARGET', 'Destination parent for first, last, or index placement.'), option('first', undefined, 'Place copies first under DESTINATION.'), option('last', undefined, 'Place copies last under DESTINATION.', { default: 'true' }), option('index', 'INDEX', 'Place copies at a zero-based index under DESTINATION.'), option('before', 'SIBLING', 'Place copies immediately before one exact sibling.'), option('after', 'SIBLING', 'Place copies immediately after one exact sibling.'), option('previous', undefined, 'Place each copy immediately before its source.'), option('next', undefined, 'Place each copy immediately after its source.'), bind]),
  merge: contract(MergeInputSchema, 'merge SOURCE TARGET', [option('source', 'TARGET', 'Source Node or bounded set.'), target]),
  'view set': contract(ViewSetInputSchema, 'view set TARGET MODE | view set --input FILE|-', [target, option('mode', 'MODE', 'Set outline, table, cards, or calendar mode.'), option('toolbar', 'BOOLEAN', 'Set toolbar visibility.'), option('group', 'FIELD|null', 'Set the grouping field.'), option('replace', 'JSON|FILE', 'Explicitly replace sort, filter, or display collections.')]),
  'search create': contract(SearchCreateInputSchema, 'search create [PARENT] TITLE (--match TEXT | --query JSON|FILE) | search create --input FILE|-', [parent, option('title', 'TITLE', 'Saved Search title.'), option('match', 'TEXT', 'Ergonomic STRING_MATCH shorthand.'), option('query', 'JSON|FILE', 'Canonical structured query.'), option('view', 'MODE', 'Initial view mode.'), option('sort', 'FIELD:DIRECTION', 'Append one initial sort rule.'), option('filter', 'JSON', 'Append one initial filter rule.'), option('group', 'FIELD|null', 'Set initial grouping.'), option('display', 'FIELD', 'Append one initial display field.'), option('toolbar', 'BOOLEAN', 'Set initial toolbar visibility.'), bind], ['outline search create --title "Modules" --match "module" --view table --sort sys:updatedAt:desc']),
  'template apply': contract(Type.Object({ tag: ExactLocatorInputSchema }, closed), 'template apply TAG', [option('tag', 'TAG', 'Tag definition target.')]),
  'daily ensure': contract(DailyEnsureInputSchema, 'daily ensure YYYY-MM-DD', [option('date', 'YYYY-MM-DD', 'Local calendar date.'), bind]),
  trash: contract(TargetOnlySchema, 'trash TARGET', [target]),
  restore: contract(TargetOnlySchema, 'restore TARGET', [target]),
  purge: contract(ExactTargetOnlySchema, 'purge TARGET [--contents]', [target, option('contents', undefined, 'Purge the contents of Trash.')]),
} satisfies Readonly<Record<string, PorcelainBaseContract>>);

type PorcelainCommandKey = keyof typeof PORCELAIN_BASE_CONTRACTS;

const PORCELAIN_SUMMARIES = {
  create: 'Create one complete Node tree with optional reusable fields and View.',
  edit: 'Converge Node content, metadata, tags, fields, and references in one request.',
  'replace text': 'Replace bounded literal text through exact review.',
  'define create': 'Create one reusable Field or Tag definition.',
  'define ensure': 'Reuse or create one compatible reusable Field or Tag definition.',
  'define edit': 'Converge one reusable Field or Tag definition configuration.',
  'search edit': 'Converge a Saved Search query, title, and View.',
  'capture create': 'Create one provenanced capture tree.',
  move: 'Move a bounded Node selection below one destination.',
  duplicate: 'Duplicate a bounded Node selection below one destination.',
  merge: 'Merge source Nodes into one target after exact Diff review.',
  'view set': 'Apply one complete declarative view patch with explicit collection replacement.',
  'search create': 'Create a complete Saved Search and its initial materialized view.',
  'template apply': 'Preview or apply template backfill to all matching tagged Nodes.',
  'daily ensure': 'Ensure one local-date Daily Note exists.',
  trash: 'Move a bounded Node selection to Trash.',
  restore: 'Restore a bounded Node selection from Trash.',
  purge: 'Permanently purge selected Nodes or Empty Trash after exact Diff review.',
} satisfies Record<PorcelainCommandKey, string>;

const PORCELAIN_EXAMPLES = {
  create: ['outline create @inbox "Project brief"', 'outline example create collection'],
  edit: ['outline edit node:brief --description "Ready for review"', 'outline example edit complete'],
  'replace text': ['outline replace text node:brief --find "draft" --with "final" --preview --idempotency-key cli:review-replace', 'outline replace text --input replace.json --idempotency-key cli:review-replace --expect-diff SHA256 --yes'],
  'define create': ['outline example define create-field', 'outline define create --input definition.json'],
  'define ensure': ['outline example define ensure-field', 'outline define ensure --input definition.json'],
  'define edit': ['outline define edit --input definition-patch.json', 'outline example define edit-field'],
  'search edit': ['outline search edit node:modules --match "runtime"', 'outline search edit --input search.json'],
  'capture create': ['outline capture create --date 2026-08-24 --title "Reading note" --metadata provenance.json', 'outline capture create --input complete-capture.json'],
  move: ['outline move node:task node:project --index 0', 'outline move --input move.json'],
  duplicate: ['outline duplicate node:template node:project', 'outline duplicate --input duplicate.json'],
  merge: ['outline merge node:duplicate node:canonical --preview --idempotency-key cli:review-merge', 'outline merge node:duplicate node:canonical --idempotency-key cli:review-merge --expect-diff SHA256 --yes'],
  'view set': ['outline view set node:projects table --toolbar true --group field:status', 'outline view set --input complete-view.json'],
  'search create': ['outline search create --title "Modules" --match "module" --view table --sort sys:updatedAt:desc', 'outline search create --input complete-search.json'],
  'template apply': ['outline template apply tag:project --preview', 'outline template apply --input template-backfill.json --preview'],
  'daily ensure': ['outline daily ensure 2026-08-24', 'outline daily ensure --input ensure-date.json'],
  trash: ['outline trash node:obsolete', 'outline trash --input trash-many.json'],
  restore: ['outline restore node:obsolete', 'outline restore --input restore-many.json'],
  purge: ['outline purge @trash --contents --preview --idempotency-key cli:review-purge', 'outline purge @trash --contents --idempotency-key cli:review-purge --expect-diff SHA256 --yes'],
} satisfies Record<PorcelainCommandKey, readonly [string, string, ...string[]]>;

const CREATE_COMMANDS = new Set<PorcelainCommandKey>([
  'create', 'duplicate', 'search create', 'define create', 'capture create',
]);
const ENSURE_COMMANDS = new Set<PorcelainCommandKey>(['daily ensure', 'define ensure']);
const DESTRUCTIVE_COMMANDS = new Set<PorcelainCommandKey>(['replace text', 'merge', 'purge']);
const REPLACE_COMMANDS = new Set<PorcelainCommandKey>();
const IDEMPOTENT_COMMANDS = new Set<PorcelainCommandKey>([
  'edit', 'replace text', 'move', 'view set', 'template apply', 'daily ensure',
  'trash', 'restore', 'define ensure', 'define edit', 'search edit',
]);
const EXACT_TARGET_COMMANDS = new Set<PorcelainCommandKey>([
  'view set', 'template apply', 'purge', 'define edit', 'search edit',
]);

const PORCELAIN_DEFAULTS: Partial<Record<PorcelainCommandKey, readonly string[]>> = {
  'replace text': ['Field defaults to content, occurrence to all, case-sensitive matching to true, and max replacements to 1000.', 'Matches use UTF-16 offsets. Rich-text marks and references outside replacement ranges are preserved; a replacement that would consume an inline reference is rejected.'],
  'search create': ['Parent defaults to @saved-searches.', 'Omitted view properties use the Saved Search defaults.'],
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
  const recipeExamples = outlineRecipeVariants(name).map((recipe) => `outline example ${recipe.command} ${recipe.variant}`);
  const directExamples = PORCELAIN_EXAMPLES[name].filter((example) => (
    !example.includes('--input') && !/\b[A-Za-z0-9_-]+\.json\b/u.test(example)
  ));
  const examples = [...new Set([...directExamples, ...recipeExamples])].slice(0, 3);
  return Object.freeze({
    ...base,
    summary: PORCELAIN_SUMMARIES[name],
    behavior,
    idempotent,
    positionals: Object.freeze([`Exact positional forms: ${base.usage}.`]),
    selectors: 'Exact TARGET and PARENT values are Node IDs, typed IDs, stable @aliases, or @date:YYYY-MM-DD strings. Bulk-capable structured targets use a bounded TargetSpec.',
    cardinality: EXACT_TARGET_COMMANDS.has(name)
      ? 'This command requires one exact target. Structured many selectors are rejected.'
      : 'Exact locator strings lower to cardinality one. Structured many selectors require an explicit max bound.',
    input: recipeExamples.length > 0
      ? `Use argv for common shorthand. Use --input FILE|- with the validated structured stdin from ${recipeExamples[0]}. Full schema discovery is reserved for integrations and debugging.`
      : `Use argv for common shorthand. --input FILE|- accepts one ${name}-specific JSON object; full schema discovery is reserved for integrations and debugging.`,
    output: 'Preview returns one normalized Diff. Apply returns one Operation or semantic no-change result; created or ensured IDs are included in the bounded return Projection.',
    defaults: Object.freeze([
      ...(PORCELAIN_DEFAULTS[name] ?? []),
      ...(behavior === 'patch' ? ['Omitted patch properties preserve current state.'] : []),
      ...(name === 'view set' || name === 'search edit' ? ['Only the explicitly named replace object replaces sort, filter, or display collections.'] : []),
    ]),
    destructive,
    examples: Object.freeze(examples),
  });
}

const PUBLIC_PORCELAIN_COMMAND_NAMES = [
  'create', 'edit', 'replace text', 'move', 'duplicate', 'merge',
  'define create', 'define ensure', 'define edit',
  'view set', 'search create', 'search edit',
  'template apply', 'daily ensure', 'capture create', 'trash', 'restore', 'purge',
] as const;

export const PORCELAIN_CONTRACTS = Object.freeze(Object.fromEntries(
  PUBLIC_PORCELAIN_COMMAND_NAMES.map((name) => {
    const base = PORCELAIN_BASE_CONTRACTS[name];
    return [
    name,
    finalizePorcelainContract(name as PorcelainCommandKey, base),
    ];
  }),
) as { readonly [Name in (typeof PUBLIC_PORCELAIN_COMMAND_NAMES)[number]]: PorcelainContract });

export type PorcelainCommandName = (typeof PUBLIC_PORCELAIN_COMMAND_NAMES)[number];

export function porcelainContract(name: string): PorcelainContract | undefined {
  return PORCELAIN_CONTRACTS[name as PorcelainCommandName];
}
