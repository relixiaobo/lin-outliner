import Type, { type Static, type TSchema } from 'typebox';
import { OUTLINE_ERROR_CODES } from './errors';
import {
  OUTLINE_DESCRIPTOR_VERSION,
  OUTLINE_PROTOCOL_VERSION,
  OUTLINE_STORAGE_VERSION,
} from './version';

const closed = { additionalProperties: false } as const;
const Identifier = Type.String({ minLength: 1, maxLength: 256 });
const Digest = Type.String({ pattern: '^[a-f0-9]{64}$' });
const BindingName = Type.String({ pattern: '^[A-Za-z][A-Za-z0-9_-]{0,63}$' });
const LocalDate = Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' });
const Timestamp = Type.String({ format: 'date-time' });
const JsonValue = Type.Unknown();

export const OUTLINE_QUERY_OPS = [
  'HAS_TAG', 'TODO', 'DONE', 'NOT_DONE', 'FIELD_IS', 'FIELD_IS_NOT',
  'IS_EMPTY', 'IS_NOT_EMPTY', 'FIELD_CONTAINS', 'LT', 'GT',
  'CREATED_LAST_DAYS', 'EDITED_LAST_DAYS', 'DONE_LAST_DAYS', 'HAS_FIELD',
  'LINKS_TO', 'STRING_MATCH', 'REGEXP_MATCH', 'CHILD_OF', 'IS_TYPE',
  'FOR_DATE', 'FOR_RELATIVE_DATE', 'DATE_OVERLAPS', 'DESCENDANT_OF',
  'DESCENDANT_OF_WITH_REFS', 'PARENTS_DESCENDANTS',
  'GRANDPARENTS_DESCENDANTS', 'PARENTS_DESCENDANTS_WITH_REFS',
  'GRANDPARENTS_DESCENDANTS_WITH_REFS', 'SIBLING_NAMED', 'IN_LIBRARY',
  'ON_DAY_NODE', 'EDITED_BY', 'OWNED_BY', 'OVERDUE', 'HAS_MEDIA',
  'HAS_AUDIO', 'HAS_VIDEO', 'HAS_IMAGE', 'FIELD_IS_SET', 'FIELD_IS_NOT_SET',
  'FIELD_IS_DEFINED', 'FIELD_IS_NOT_DEFINED',
] as const;

const QueryOpSchema = Type.Unsafe<(typeof OUTLINE_QUERY_OPS)[number]>({
  type: 'string',
  enum: [...OUTLINE_QUERY_OPS],
});

const QueryOperandSchema = Type.Object({
  text: Type.Optional(Type.String({ maxLength: 65_536 })),
  targetId: Type.Optional(Identifier),
}, closed);

export const QueryExpressionSchema = Type.Cyclic({
  QueryExpression: Type.Union([
    Type.Object({
      kind: Type.Literal('rule'),
      op: QueryOpSchema,
      text: Type.Optional(Type.String({ maxLength: 65_536 })),
      fieldDefId: Type.Optional(Identifier),
      tagDefId: Type.Optional(Identifier),
      targetId: Type.Optional(Identifier),
      operands: Type.Optional(Type.Array(QueryOperandSchema, { maxItems: 256 })),
    }, closed),
    Type.Object({
      kind: Type.Literal('group'),
      logic: Type.Union([Type.Literal('AND'), Type.Literal('OR'), Type.Literal('NOT')]),
      children: Type.Array(Type.Ref('QueryExpression'), { minItems: 1, maxItems: 1_024 }),
    }, closed),
  ]),
}, 'QueryExpression');

export const SelectorSchema = Type.Cyclic({
  Selector: Type.Union([
    Type.Object({ by: Type.Literal('id'), id: Identifier }, closed),
    Type.Object({
      by: Type.Literal('alias'),
      alias: Type.Union([
        Type.Literal('home'), Type.Literal('inbox'), Type.Literal('schema'),
        Type.Literal('trash'), Type.Literal('daily-notes'), Type.Literal('today'),
      ]),
    }, closed),
    Type.Object({ by: Type.Literal('date'), date: LocalDate }, closed),
    Type.Object({
      by: Type.Literal('query'),
      query: QueryExpressionSchema,
      within: Type.Optional(Type.Ref('Selector')),
      includeTrash: Type.Optional(Type.Boolean()),
      order: Type.Optional(Type.Union([
        Type.Literal('document'), Type.Literal('created'),
        Type.Literal('updated'), Type.Literal('text'),
      ])),
      limit: Type.Integer({ minimum: 1, maximum: 10_000 }),
    }, closed),
  ]),
}, 'Selector');

export const TargetSpecSchema = Type.Object({
  selector: SelectorSchema,
  cardinality: Type.Union([
    Type.Literal('one'), Type.Literal('zero-or-one'), Type.Literal('many'),
  ]),
  max: Type.Optional(Type.Integer({ minimum: 1, maximum: 10_000 })),
}, { ...closed, $id: 'TargetSpec' });

export const TargetRefSchema = Type.Union([
  Type.Object({ target: TargetSpecSchema }, closed),
  Type.Object({ binding: BindingName }, closed),
], { $id: 'TargetRef' });

export const ProjectionSchema = Type.Object({
  kind: Type.Union([
    Type.Literal('summary'), Type.Literal('node'), Type.Literal('outline'),
    Type.Literal('backlinks'), Type.Literal('view'), Type.Literal('export'),
  ]),
  targets: TargetRefSchema,
  depth: Type.Optional(Type.Integer({ minimum: 0, maximum: 1_024 })),
  include: Type.Optional(Type.Array(Type.Union([
    Type.Literal('description'), Type.Literal('children'), Type.Literal('tags'),
    Type.Literal('fields'), Type.Literal('references'), Type.Literal('media'),
    Type.Literal('view'), Type.Literal('trash'),
  ]), { uniqueItems: true, maxItems: 8 })),
  page: Type.Optional(Type.Object({
    limit: Type.Integer({ minimum: 1, maximum: 10_000 }),
    cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 4_096 })),
  }, closed)),
  format: Type.Optional(Type.Union([
    Type.Literal('json'), Type.Literal('jsonl'),
    Type.Literal('markdown'), Type.Literal('opml'),
  ])),
}, { ...closed, $id: 'Projection' });

export const RichTextSchema = Type.Object({
  text: Type.String({ maxLength: 4_194_304 }),
  marks: Type.Array(Type.Object({
    start: Type.Integer({ minimum: 0 }),
    end: Type.Integer({ minimum: 0 }),
    type: Type.Union([
      Type.Literal('bold'), Type.Literal('italic'), Type.Literal('strike'),
      Type.Literal('code'), Type.Literal('highlight'), Type.Literal('headingMark'),
      Type.Literal('link'),
    ]),
    attrs: Type.Optional(Type.Record(Type.String(), Type.String())),
  }, closed), { maxItems: 65_536 }),
  inlineRefs: Type.Array(Type.Object({
    offset: Type.Integer({ minimum: 0 }),
    target: Type.Union([
      Type.Object({ kind: Type.Literal('node'), nodeId: Identifier }, closed),
      Type.Object({
        kind: Type.Literal('local-file'),
        path: Type.String({ minLength: 1, maxLength: 32_768 }),
        entryKind: Type.Union([Type.Literal('file'), Type.Literal('directory')]),
      }, closed),
    ]),
    displayName: Type.Optional(Type.String({ maxLength: 4_096 })),
    mimeType: Type.Optional(Type.String({ maxLength: 256 })),
    sizeBytes: Type.Optional(Type.Integer({ minimum: 0 })),
  }, closed), { maxItems: 65_536 }),
}, closed);

const RichTextPatchOpSchema = Type.Union([
  Type.Object({
    type: Type.Literal('replace'),
    from: Type.Integer({ minimum: 0 }),
    to: Type.Integer({ minimum: 0 }),
    content: RichTextSchema,
    deletedInlineRefs: Type.Optional(RichTextSchema.properties.inlineRefs),
  }, closed),
  Type.Object({
    type: Type.Literal('replace_all'),
    content: RichTextSchema,
  }, closed),
  Type.Object({
    type: Type.Literal('add_mark'),
    from: Type.Integer({ minimum: 0 }),
    to: Type.Integer({ minimum: 0 }),
    markType: RichTextSchema.properties.marks.items.properties.type,
    attrs: Type.Optional(Type.Record(Type.String(), Type.String())),
  }, closed),
  Type.Object({
    type: Type.Literal('remove_mark'),
    from: Type.Integer({ minimum: 0 }),
    to: Type.Integer({ minimum: 0 }),
    markType: RichTextSchema.properties.marks.items.properties.type,
  }, closed),
]);

export const RichTextPatchSchema = Type.Object({
  ops: Type.Array(RichTextPatchOpSchema, { minItems: 1, maxItems: 100_000 }),
}, { ...closed, $id: 'RichTextPatch' });

const NodeDraftMetadataSchema = Type.Object({
  width: Type.Optional(Type.Union([Type.Number({ minimum: 0 }), Type.Null()])),
  height: Type.Optional(Type.Union([Type.Number({ minimum: 0 }), Type.Null()])),
  alt: Type.Optional(Type.Union([Type.String({ maxLength: 4_096 }), Type.Null()])),
  capture: Type.Optional(JsonValue),
  query: Type.Optional(QueryExpressionSchema),
}, closed);

export const NodeDraftSchema = Type.Cyclic({
  NodeDraft: Type.Object({
    id: Type.Optional(Identifier),
    type: Type.Optional(Type.Union([
      Type.Literal('plain'), Type.Literal('codeBlock'), Type.Literal('image'),
      Type.Literal('attachment'), Type.Literal('reference'), Type.Literal('search'),
      Type.Literal('tagDef'), Type.Literal('fieldDef'), Type.Literal('fieldEntry'),
    ])),
    content: RichTextSchema,
    description: Type.Optional(Type.String({ maxLength: 4_194_304 })),
    codeLanguage: Type.Optional(Type.String({ maxLength: 128 })),
    checkbox: Type.Optional(Type.Boolean()),
    done: Type.Optional(Type.Boolean()),
    tags: Type.Optional(Type.Array(Identifier, { uniqueItems: true, maxItems: 1_024 })),
    fields: Type.Optional(Type.Array(Type.Object({
      fieldDefId: Identifier,
      values: Type.Array(Type.Ref('NodeDraft'), { maxItems: 10_000 }),
    }, closed), { maxItems: 1_024 })),
    referenceTargetId: Type.Optional(Identifier),
    assetLeaseId: Type.Optional(Identifier),
    mediaUrl: Type.Optional(Type.String({ maxLength: 32_768 })),
    metadata: Type.Optional(NodeDraftMetadataSchema),
    children: Type.Array(Type.Ref('NodeDraft'), { maxItems: 100_000 }),
  }, closed),
}, 'NodeDraft');

const ResolveChangeSchema = Type.Object({
  op: Type.Literal('resolve'),
  target: TargetSpecSchema,
  bind: BindingName,
}, closed);

const EnsureChangeSchema = Type.Union([
  Type.Object({ op: Type.Literal('ensure'), resource: Type.Literal('date'), date: LocalDate, bind: BindingName }, closed),
  Type.Object({ op: Type.Literal('ensure'), resource: Type.Literal('tag-search'), tag: TargetRefSchema, bind: BindingName }, closed),
  Type.Object({
    op: Type.Literal('ensure'),
    resource: Type.Literal('definition'),
    definitionType: Type.Literal('tag'),
    id: Type.Optional(Identifier),
    name: Type.String({ maxLength: 1_024 }),
    extends: Type.Optional(TargetRefSchema),
    bind: BindingName,
  }, closed),
  Type.Object({
    op: Type.Literal('ensure'),
    resource: Type.Literal('definition'),
    definitionType: Type.Literal('field'),
    id: Type.Optional(Identifier),
    name: Type.String({ maxLength: 1_024 }),
    fieldType: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    bind: BindingName,
  }, closed),
]);

const CreateChangeSchema = Type.Object({
  op: Type.Literal('create'),
  parents: TargetRefSchema,
  index: Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])),
  nodes: Type.Array(NodeDraftSchema, { minItems: 1, maxItems: 100_000 }),
  bind: Type.Optional(BindingName),
}, closed);

const TextPatchSchema = Type.Union([
  Type.Object({
    kind: Type.Literal('text-patch'),
    field: Type.Literal('content'),
    patch: RichTextPatchSchema,
  }, closed),
  Type.Object({
    kind: Type.Literal('text-patch'),
    field: Type.Literal('description'),
    from: Type.Integer({ minimum: 0 }),
    to: Type.Integer({ minimum: 0 }),
    value: Type.String({ maxLength: 4_194_304 }),
  }, closed),
]);

const FieldTypeSchema = Type.Union([
  Type.Literal('plain'), Type.Literal('options'), Type.Literal('options_from_supertag'),
  Type.Literal('date'), Type.Literal('number'), Type.Literal('url'),
  Type.Literal('email'), Type.Literal('checkbox'),
]);

const FieldSlotCommon = {
  entryId: Type.Optional(Identifier),
};

const FieldSlotMutationSchema = Type.Union([
  Type.Object({ action: Type.Literal('accept-default'), ...FieldSlotCommon }, closed),
  Type.Object({
    action: Type.Literal('append-text'),
    text: Type.String({ maxLength: 4_194_304 }),
    id: Type.Optional(Identifier),
    collect: Type.Optional(Type.Boolean()),
    ...FieldSlotCommon,
  }, closed),
  Type.Object({
    action: Type.Literal('append-reference'),
    target: TargetRefSchema,
    id: Type.Optional(Identifier),
    ...FieldSlotCommon,
  }, closed),
  Type.Object({
    action: Type.Literal('select-option'),
    option: TargetRefSchema,
    id: Type.Optional(Identifier),
    ...FieldSlotCommon,
  }, closed),
  Type.Object({
    action: Type.Literal('remove-value'),
    value: TargetRefSchema,
    ...FieldSlotCommon,
  }, closed),
  Type.Object({
    action: Type.Literal('append-nodes'),
    nodes: Type.Array(NodeDraftSchema, { minItems: 1, maxItems: 100_000 }),
    firstTags: Type.Optional(Type.Array(TargetRefSchema, { uniqueItems: true, maxItems: 1_024 })),
    id: Type.Optional(Identifier),
    ...FieldSlotCommon,
  }, closed),
  Type.Object({
    action: Type.Literal('append-field'),
    name: Type.String({ minLength: 1, maxLength: 1_024 }),
    fieldType: FieldTypeSchema,
    id: Type.Optional(Identifier),
    ...FieldSlotCommon,
  }, closed),
  Type.Object({
    action: Type.Literal('append-image'),
    assetLeaseId: Type.Optional(Identifier),
    mediaUrl: Type.Optional(Type.String({ maxLength: 32_768 })),
    width: Type.Optional(Type.Union([Type.Number({ minimum: 0 }), Type.Null()])),
    height: Type.Optional(Type.Union([Type.Number({ minimum: 0 }), Type.Null()])),
    alt: Type.Optional(Type.Union([Type.String({ maxLength: 4_096 }), Type.Null()])),
    name: Type.Optional(Type.Union([Type.String({ maxLength: 4_096 }), Type.Null()])),
    id: Type.Optional(Identifier),
    ...FieldSlotCommon,
  }, closed),
  Type.Object({
    action: Type.Literal('append-attachment'),
    assetLeaseId: Identifier,
    id: Type.Optional(Identifier),
    ...FieldSlotCommon,
  }, closed),
  Type.Object({ action: Type.Literal('commit'), ...FieldSlotCommon }, closed),
]);

const ScalarValueSchema = Type.Union([
  Type.String({ maxLength: 4_194_304 }),
  Type.Number(),
  Type.Boolean(),
  Type.Null(),
]);

const FieldInstructionSchema = Type.Union([
  Type.Object({
    kind: Type.Literal('field'),
    action: Type.Literal('define'),
    name: Type.String({ minLength: 1, maxLength: 1_024 }),
    fieldType: FieldTypeSchema,
    index: Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])),
    value: Type.Optional(ScalarValueSchema),
  }, closed),
  Type.Object({
    kind: Type.Literal('field'),
    action: Type.Literal('convert'),
    name: Type.String({ maxLength: 1_024 }),
    fieldType: FieldTypeSchema,
  }, closed),
  Type.Object({
    kind: Type.Literal('field'),
    action: Type.Literal('register-option'),
    name: Type.String({ minLength: 1, maxLength: 1_024 }),
  }, closed),
  Type.Object({
    kind: Type.Literal('field'),
    action: Type.Literal('attach'),
    field: TargetRefSchema,
    index: Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])),
  }, closed),
  Type.Object({
    kind: Type.Literal('field'),
    action: Type.Literal('set'),
    field: TargetRefSchema,
    value: ScalarValueSchema,
  }, closed),
  Type.Object({
    kind: Type.Literal('field'),
    action: Type.Union([Type.Literal('clear'), Type.Literal('remove')]),
    field: TargetRefSchema,
  }, closed),
  Type.Object({
    kind: Type.Literal('field'),
    action: Type.Literal('reuse'),
    field: TargetRefSchema,
    sourceField: TargetRefSchema,
  }, closed),
  Type.Object({
    kind: Type.Literal('field'),
    action: Type.Literal('select'),
    field: TargetRefSchema,
    option: TargetRefSchema,
  }, closed),
]);

const TagDefinitionPatchSchema = Type.Object({
  color: Type.Optional(Type.Union([Type.String({ maxLength: 128 }), Type.Null()])),
  extends: Type.Optional(Type.Union([Identifier, Type.Null()])),
  childSupertag: Type.Optional(Type.Union([Identifier, Type.Null()])),
  showCheckbox: Type.Optional(Type.Boolean()),
  doneStateEnabled: Type.Optional(Type.Boolean()),
  doneMapChecked: Type.Optional(Type.Array(Identifier, { uniqueItems: true, maxItems: 10_000 })),
  doneMapUnchecked: Type.Optional(Type.Array(Identifier, { uniqueItems: true, maxItems: 10_000 })),
}, closed);

const FieldDefinitionPatchSchema = Type.Object({
  fieldType: Type.Optional(FieldTypeSchema),
  sourceSupertag: Type.Optional(Type.Union([Identifier, Type.Null()])),
  nullable: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
  hideField: Type.Optional(Type.Union([
    Type.Literal('never'), Type.Literal('empty'), Type.Literal('not_empty'),
    Type.Literal('value_is_default'), Type.Literal('always'), Type.Null(),
  ])),
  autoInitialize: Type.Optional(Type.Union([Type.String({ maxLength: 128 }), Type.Null()])),
  autocollectOptions: Type.Optional(Type.Boolean()),
  minValue: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
  maxValue: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
}, closed);

const DefinitionInstructionSchema = Type.Union([
  Type.Object({
    kind: Type.Literal('definition'),
    definitionType: Type.Literal('tag'),
    patch: TagDefinitionPatchSchema,
  }, closed),
  Type.Object({
    kind: Type.Literal('definition'),
    definitionType: Type.Literal('field'),
    patch: FieldDefinitionPatchSchema,
  }, closed),
]);

const ViewSystemFieldSchema = Type.Union([
  Type.Literal('sys:name'), Type.Literal('sys:createdAt'), Type.Literal('sys:updatedAt'),
  Type.Literal('sys:done'), Type.Literal('sys:doneAt'), Type.Literal('sys:tags'),
  Type.Literal('sys:refCount'),
]);
const ViewFieldSchema = Type.Union([ViewSystemFieldSchema, TargetRefSchema]);
const ViewModeSchema = Type.Union([
  Type.Literal('list'), Type.Literal('table'), Type.Literal('cards'), Type.Literal('calendar'),
]);
const SortDirectionSchema = Type.Union([Type.Literal('asc'), Type.Literal('desc')]);
const FilterOperatorSchema = Type.Union([
  Type.Literal('is'), Type.Literal('is_not'), Type.Literal('contains'), Type.Literal('not_contains'),
  Type.Literal('is_empty'), Type.Literal('is_not_empty'), Type.Literal('gt'), Type.Literal('lt'),
  Type.Literal('before'), Type.Literal('after'),
]);
const FilterValueLogicSchema = Type.Union([Type.Literal('all'), Type.Literal('any')]);
const DisplayPlacementSchema = Type.Union([
  Type.Literal('title'), Type.Literal('body'), Type.Literal('footer'), Type.Literal('hidden'),
]);

const ViewInstructionSchema = Type.Union([
  Type.Object({ kind: Type.Literal('view'), property: Type.Literal('mode'), action: Type.Literal('set'), mode: ViewModeSchema }, closed),
  Type.Object({ kind: Type.Literal('view'), property: Type.Literal('toolbar'), action: Type.Literal('set'), visible: Type.Boolean() }, closed),
  Type.Object({ kind: Type.Literal('view'), property: Type.Literal('group'), action: Type.Literal('set'), field: Type.Union([ViewFieldSchema, Type.Null()]) }, closed),
  Type.Object({ kind: Type.Literal('view'), property: Type.Literal('sort'), action: Type.Literal('add'), field: ViewFieldSchema, direction: SortDirectionSchema }, closed),
  Type.Object({ kind: Type.Literal('view'), property: Type.Literal('sort'), action: Type.Literal('set'), ruleId: Identifier, field: ViewFieldSchema, direction: SortDirectionSchema }, closed),
  Type.Object({ kind: Type.Literal('view'), property: Type.Literal('sort'), action: Type.Literal('remove'), ruleId: Identifier }, closed),
  Type.Object({ kind: Type.Literal('view'), property: Type.Literal('sort'), action: Type.Literal('clear') }, closed),
  Type.Object({
    kind: Type.Literal('view'),
    property: Type.Literal('filter'),
    action: Type.Literal('add'),
    field: ViewFieldSchema,
    operator: FilterOperatorSchema,
    values: Type.Array(Type.String({ maxLength: 65_536 }), { maxItems: 10_000 }),
    valueLogic: FilterValueLogicSchema,
  }, closed),
  Type.Object({
    kind: Type.Literal('view'),
    property: Type.Literal('filter'),
    action: Type.Literal('set'),
    ruleId: Identifier,
    field: Type.Optional(Type.Union([ViewFieldSchema, Type.Null()])),
    operator: Type.Optional(Type.Union([FilterOperatorSchema, Type.Null()])),
    values: Type.Optional(Type.Union([Type.Array(Type.String({ maxLength: 65_536 }), { maxItems: 10_000 }), Type.Null()])),
    valueLogic: Type.Optional(Type.Union([FilterValueLogicSchema, Type.Null()])),
  }, closed),
  Type.Object({ kind: Type.Literal('view'), property: Type.Literal('filter'), action: Type.Literal('remove'), ruleId: Identifier }, closed),
  Type.Object({ kind: Type.Literal('view'), property: Type.Literal('filter'), action: Type.Literal('clear') }, closed),
  Type.Object({ kind: Type.Literal('view'), property: Type.Literal('display-field'), action: Type.Literal('add'), field: ViewFieldSchema }, closed),
  Type.Object({
    kind: Type.Literal('view'),
    property: Type.Literal('display-field'),
    action: Type.Literal('set'),
    displayFieldId: Identifier,
    field: Type.Optional(Type.Union([ViewFieldSchema, Type.Null()])),
    visible: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
    width: Type.Optional(Type.Union([Type.Number({ minimum: 0 }), Type.Null()])),
    order: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    label: Type.Optional(Type.Union([Type.String({ maxLength: 4_096 }), Type.Null()])),
    placement: Type.Optional(Type.Union([DisplayPlacementSchema, Type.Null()])),
    move: Type.Optional(Type.Union([Type.Literal('left'), Type.Literal('right')])),
  }, closed),
  Type.Object({ kind: Type.Literal('view'), property: Type.Literal('display-field'), action: Type.Literal('remove'), displayFieldId: Identifier }, closed),
]);

const SearchInstructionSchema = Type.Union([
  Type.Object({
    kind: Type.Literal('search'),
    action: Type.Literal('set'),
    title: Type.String({ minLength: 1, maxLength: 4_194_304 }),
    query: QueryExpressionSchema,
  }, closed),
  Type.Object({ kind: Type.Literal('search'), action: Type.Literal('refresh') }, closed),
]);

export const UpdateInstructionSchema = Type.Union([
  Type.Object({ kind: Type.Literal('content'), value: RichTextSchema }, closed),
  Type.Object({ kind: Type.Literal('description'), value: Type.Union([Type.String({ maxLength: 4_194_304 }), Type.Null()]) }, closed),
  TextPatchSchema,
  Type.Object({ kind: Type.Literal('code'), language: Type.String({ maxLength: 128 }) }, closed),
  Type.Object({ kind: Type.Literal('checkbox'), visible: Type.Boolean() }, closed),
  Type.Object({ kind: Type.Literal('done'), value: Type.Boolean() }, closed),
  Type.Object({ kind: Type.Literal('tag'), action: Type.Union([Type.Literal('add'), Type.Literal('remove')]), tag: TargetRefSchema }, closed),
  FieldInstructionSchema,
  Type.Object({
    kind: Type.Literal('field-slot'),
    field: TargetRefSchema,
    mutation: FieldSlotMutationSchema,
  }, closed),
  DefinitionInstructionSchema,
  Type.Object({
    kind: Type.Literal('reference'),
    action: Type.Union([
      Type.Literal('add'), Type.Literal('retarget'), Type.Literal('inline'), Type.Literal('restore'),
    ]),
    target: TargetRefSchema,
  }, closed),
  ViewInstructionSchema,
  SearchInstructionSchema,
  Type.Object({ kind: Type.Literal('icon'), value: Type.Union([Type.String({ maxLength: 4_096 }), Type.Null()]), iconKind: Type.Optional(Type.String({ maxLength: 128 })) }, closed),
  Type.Object({ kind: Type.Literal('banner'), assetLeaseId: Type.Union([Identifier, Type.Null()]), position: Type.Optional(Type.Object({ x: Type.Optional(Type.Number()), y: Type.Optional(Type.Number()) }, closed)) }, closed),
  Type.Object({ kind: Type.Literal('image'), assetLeaseId: Type.Optional(Identifier), mediaUrl: Type.Optional(Type.String({ maxLength: 32_768 })), width: Type.Optional(Type.Number({ minimum: 0 })), height: Type.Optional(Type.Number({ minimum: 0 })) }, closed),
]);

const UpdateChangeSchema = Type.Object({
  op: Type.Literal('update'),
  targets: TargetRefSchema,
  changes: Type.Array(UpdateInstructionSchema, { minItems: 1, maxItems: 100_000 }),
}, closed);

const MoveChangeSchema = Type.Object({
  op: Type.Literal('move'),
  targets: TargetRefSchema,
  destination: TargetRefSchema,
  index: Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])),
}, closed);

const DuplicateChangeSchema = Type.Object({
  op: Type.Literal('duplicate'),
  targets: TargetRefSchema,
  destination: TargetRefSchema,
  index: Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])),
  bind: Type.Optional(BindingName),
}, closed);

const MergeChangeSchema = Type.Object({
  op: Type.Literal('merge'),
  sources: TargetRefSchema,
  target: TargetRefSchema,
}, closed);

const TemplateChangeSchema = Type.Object({
  op: Type.Literal('template'),
  action: Type.Literal('apply'),
  tag: TargetRefSchema,
}, closed);

const LifecycleChangeSchema = Type.Object({
  op: Type.Literal('lifecycle'),
  action: Type.Union([Type.Literal('trash'), Type.Literal('restore'), Type.Literal('purge')]),
  targets: TargetRefSchema,
  contents: Type.Optional(Type.Boolean()),
}, closed);

export const ChangeSchema = Type.Union([
  ResolveChangeSchema,
  EnsureChangeSchema,
  CreateChangeSchema,
  UpdateChangeSchema,
  MoveChangeSchema,
  DuplicateChangeSchema,
  MergeChangeSchema,
  TemplateChangeSchema,
  LifecycleChangeSchema,
], { $id: 'Change' });

export const ChangeSetSchema = Type.Object({
  protocolVersion: Type.Literal(OUTLINE_PROTOCOL_VERSION),
  kind: Type.Literal('outline.changeset'),
  base: Type.Optional(Type.Object({
    revision: Type.Optional(Type.Integer({ minimum: 0 })),
    nodes: Type.Optional(Type.Record(Type.String(), Digest)),
  }, closed)),
  idempotencyKey: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  source: Type.Optional(Type.Object({
    kind: Type.Union([
      Type.Literal('cli'), Type.Literal('skill'), Type.Literal('import'),
      Type.Literal('automation'), Type.Literal('external'),
    ]),
    label: Type.Optional(Type.String({ maxLength: 4_096 })),
    uri: Type.Optional(Type.String({ maxLength: 32_768 })),
    fingerprint: Type.Optional(Type.String({ maxLength: 4_096 })),
  }, closed)),
  operations: Type.Array(ChangeSchema, { minItems: 1, maxItems: 100_000 }),
  return: Type.Optional(Type.Array(ProjectionSchema, { maxItems: 32 })),
}, { ...closed, $id: 'ChangeSet' });

const OutlineWarningSchema = Type.Object({
  code: Type.String({ minLength: 1, maxLength: 128 }),
  message: Type.String({ minLength: 1, maxLength: 16_384 }),
  details: Type.Optional(JsonValue),
}, closed);

export const DiffSchema = Type.Object({
  protocolVersion: Type.Literal(OUTLINE_PROTOCOL_VERSION),
  kind: Type.Literal('outline.diff'),
  diffHash: Digest,
  changeSetHash: Digest,
  baseRevision: Type.Integer({ minimum: 0 }),
  normalizedChangeSet: ChangeSetSchema,
  bindings: Type.Record(Type.String({ pattern: '^[A-Za-z][A-Za-z0-9_-]{0,63}$' }), Type.Array(Identifier, { maxItems: 100_000 })),
  affected: Type.Array(Type.Object({
    id: Identifier,
    effect: Type.Union([
      Type.Literal('create'), Type.Literal('update'), Type.Literal('move'),
      Type.Literal('trash'), Type.Literal('restore'), Type.Literal('purge'),
    ]),
    beforeDigest: Type.Union([Digest, Type.Null()]),
    afterDigest: Type.Union([Digest, Type.Null()]),
  }, closed), { maxItems: 100_000 }),
  destructive: Type.Array(Type.Object({
    kind: Type.Union([
      Type.Literal('purge'), Type.Literal('empty-trash'),
      Type.Literal('replace'), Type.Literal('merge'),
    ]),
    targetCount: Type.Integer({ minimum: 0 }),
  }, closed), { maxItems: 100_000 }),
  warnings: Type.Array(OutlineWarningSchema, { maxItems: 10_000 }),
  resultEstimate: Type.Object({
    nodeCount: Type.Integer({ minimum: 0 }),
    encodedBytes: Type.Integer({ minimum: 0 }),
  }, closed),
}, { ...closed, $id: 'Diff' });

export const ProjectionResultSchema = Type.Object({
  projection: ProjectionSchema,
  revision: Type.Integer({ minimum: 0 }),
  anchors: Type.Object({
    workspaceId: Identifier,
    rootId: Identifier,
    libraryId: Identifier,
    dailyNotesId: Identifier,
    schemaId: Identifier,
    searchesId: Identifier,
    recentsId: Identifier,
    trashId: Identifier,
    todayId: Identifier,
  }, closed),
  nodes: Type.Array(JsonValue, { maxItems: 10_000 }),
  cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 4_096 })),
  truncated: Type.Optional(Type.Boolean()),
}, { ...closed, $id: 'ProjectionResult' });

export const OperationSchema = Type.Object({
  protocolVersion: Type.Literal(OUTLINE_PROTOCOL_VERSION),
  kind: Type.Literal('outline.operation'),
  operationId: Identifier,
  changeSetHash: Digest,
  diffHash: Digest,
  origin: Type.Union([
    Type.Literal('desktop'), Type.Literal('local-user'),
    Type.Literal('built-in-agent'), Type.Literal('external-client'),
  ]),
  causation: Type.Optional(Type.Object({ threadId: Identifier, turnId: Identifier, itemId: Identifier }, closed)),
  source: Type.Optional(ChangeSetSchema.properties.source),
  summary: Type.String({ minLength: 1, maxLength: 16_384 }),
  affectedNodeIds: Type.Array(Identifier, { maxItems: 1_000 }),
  affectedNodeCount: Type.Integer({ minimum: 0 }),
  affectedNodeIdsHash: Digest,
  affectedNodeIdsTruncated: Type.Optional(Type.Literal(true)),
  affectedNodeIdsCursor: Type.Optional(Type.String({ minLength: 1, maxLength: 4_096 })),
  revisionBefore: Type.Integer({ minimum: 0 }),
  revisionAfter: Type.Integer({ minimum: 0 }),
  createdAt: Timestamp,
  recovery: Type.Object({
    recoveryPatchId: Identifier,
    state: Type.Union([
      Type.Literal('available'), Type.Literal('conflicted'),
      Type.Literal('reverted'), Type.Literal('expired'),
    ]),
    retainedUntilAtLeast: Timestamp,
  }, closed),
  revertsOperationId: Type.Optional(Identifier),
  result: Type.Optional(Type.Array(ProjectionResultSchema, { maxItems: 32 })),
}, { ...closed, $id: 'Operation' });

export const OperationLogPageSchema = Type.Object({
  operations: Type.Array(OperationSchema, { maxItems: 1_000 }),
  affectedNodeIds: Type.Optional(Type.Object({
    operationId: Identifier,
    nodeIds: Type.Array(Identifier, { maxItems: 1_000 }),
    offset: Type.Integer({ minimum: 0 }),
    totalCount: Type.Integer({ minimum: 0 }),
    fullSetHash: Digest,
  }, closed)),
  cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 4_096 })),
}, { ...closed, $id: 'OperationLogPage' });

export const RevertConflictDiffSchema = Type.Object({
  protocolVersion: Type.Literal(OUTLINE_PROTOCOL_VERSION),
  kind: Type.Literal('outline.revert-conflict-diff'),
  operationId: Identifier,
  currentRevision: Type.Integer({ minimum: 0 }),
  changedPreconditions: Type.Array(Type.Object({
    id: Identifier,
    expectedAfterDigest: Type.Union([Digest, Type.Null()]),
    actualDigest: Type.Union([Digest, Type.Null()]),
  }, closed), { minItems: 1, maxItems: 100_000 }),
}, { ...closed, $id: 'RevertConflictDiff' });

export const EventSchema = Type.Object({
  protocolVersion: Type.Literal(OUTLINE_PROTOCOL_VERSION),
  kind: Type.Literal('outline.event'),
  type: Type.Union([
    Type.Literal('projection.changed'), Type.Literal('operation.committed'),
    Type.Literal('operation.reverted'), Type.Literal('operation.recovery-expired'),
    Type.Literal('resync.required'),
  ]),
  instanceId: Identifier,
  sequence: Type.Integer({ minimum: 0 }),
  revision: Type.Integer({ minimum: 0 }),
  cursor: Type.String({ minLength: 1, maxLength: 4_096 }),
  operation: Type.Optional(OperationSchema),
  changes: Type.Optional(Type.Object({
    todayId: Identifier,
    changedNodes: Type.Array(JsonValue, { maxItems: 100_000 }),
    removedIds: Type.Array(Identifier, { maxItems: 100_000 }),
  }, closed)),
  recovery: Type.Optional(Type.Object({
    operationIds: Type.Array(Identifier, { minItems: 1, maxItems: 100_000 }),
    recoveryPatchIds: Type.Array(Identifier, { minItems: 1, maxItems: 100_000 }),
  }, closed)),
  projection: Type.Optional(ProjectionResultSchema),
}, { ...closed, $id: 'Event' });

export const EventFilterSchema = Type.Object({
  types: Type.Optional(Type.Array(EventSchema.properties.type, { uniqueItems: true, maxItems: 5 })),
  origin: Type.Optional(OperationSchema.properties.origin),
}, { ...closed, $id: 'EventFilter' });

export const WatchRequestSchema = Type.Object({
  cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 4_096 })),
  filter: Type.Optional(EventFilterSchema),
  projection: Type.Optional(ProjectionSchema),
}, { ...closed, $id: 'WatchRequest' });

export const OutlineErrorSchema = Type.Object({
  code: Type.Union(OUTLINE_ERROR_CODES.map((value) => Type.Literal(value))),
  category: Type.Union([
    Type.Literal('usage'), Type.Literal('selection'), Type.Literal('conflict'),
    Type.Literal('confirmation'), Type.Literal('unavailable'),
    Type.Literal('protocol'), Type.Literal('durability'), Type.Literal('internal'),
  ]),
  message: Type.String({ minLength: 1, maxLength: 16_384 }),
  retryable: Type.Boolean(),
  details: Type.Optional(JsonValue),
  next: Type.Optional(Type.Array(Type.String({ maxLength: 4_096 }), { maxItems: 32 })),
}, { ...closed, $id: 'OutlineError' });

export const OutlineRequestSchema = Type.Object({
  protocolVersion: Type.Literal(OUTLINE_PROTOCOL_VERSION),
  requestId: Identifier,
  command: Type.String({ minLength: 1, maxLength: 128 }),
  input: JsonValue,
}, { ...closed, $id: 'OutlineRequest' });

export const OutlineResponseSchema = Type.Union([
  Type.Object({
    protocolVersion: Type.Literal(OUTLINE_PROTOCOL_VERSION),
    requestId: Identifier,
    ok: Type.Literal(true),
    command: Type.String({ minLength: 1, maxLength: 128 }),
    revision: Type.Optional(Type.Integer({ minimum: 0 })),
    data: JsonValue,
  }, closed),
  Type.Object({
    protocolVersion: Type.Literal(OUTLINE_PROTOCOL_VERSION),
    requestId: Identifier,
    ok: Type.Literal(false),
    command: Type.String({ minLength: 1, maxLength: 128 }),
    error: OutlineErrorSchema,
  }, closed),
], { $id: 'OutlineResponse' });

const StreamBase = {
  protocolVersion: Type.Literal(OUTLINE_PROTOCOL_VERSION),
  requestId: Identifier,
  sequence: Type.Integer({ minimum: 0 }),
};

export const OutlineStreamRecordSchema = Type.Union([
  Type.Object({ ...StreamBase, type: Type.Literal('hello'), cursor: Type.Optional(Type.String()) }, closed),
  Type.Object({ ...StreamBase, type: Type.Literal('data'), data: JsonValue }, closed),
  Type.Object({ ...StreamBase, type: Type.Literal('event'), event: EventSchema, cursor: Type.String() }, closed),
  Type.Object({ ...StreamBase, type: Type.Literal('error'), error: OutlineErrorSchema }, closed),
  Type.Object({ ...StreamBase, type: Type.Literal('end'), cursor: Type.Optional(Type.String()) }, closed),
], { $id: 'OutlineStreamRecord' });

export const RuntimeDescriptorSchema = Type.Object({
  descriptorVersion: Type.Literal(OUTLINE_DESCRIPTOR_VERSION),
  transport: Type.Literal('unix-http'),
  socketPath: Type.String({ minLength: 1, maxLength: 32_768 }),
  bearerToken: Type.String({ minLength: 32, maxLength: 4_096 }),
  pid: Type.Integer({ minimum: 1 }),
  instanceId: Identifier,
  protocolMajors: Type.Tuple([Type.Literal(OUTLINE_PROTOCOL_VERSION)]),
  runtimeVersion: Type.String({ minLength: 1, maxLength: 128 }),
  storageVersion: Type.Literal(OUTLINE_STORAGE_VERSION),
  createdAt: Timestamp,
}, { ...closed, $id: 'RuntimeDescriptor' });

export const RuntimeStatusSchema = Type.Union([
  Type.Object({ running: Type.Literal(false) }, closed),
  Type.Object({
    running: Type.Literal(true),
    runtime: Type.Object({
      instanceId: Identifier,
      runtimeVersion: Type.String({ minLength: 1, maxLength: 128 }),
      storageVersion: Type.Literal(OUTLINE_STORAGE_VERSION),
      revision: Type.Integer({ minimum: 0 }),
      transactionLog: Type.Object({
        health: Type.Union([
          Type.Literal('healthy'), Type.Literal('degraded'), Type.Literal('blocked'),
        ]),
        sequence: Type.Integer({ minimum: 0 }),
        eventSequence: Type.Integer({ minimum: 0 }),
        snapshotSequence: Type.Integer({ minimum: 0 }),
        validBytes: Type.Integer({ minimum: 0 }),
        totalBytes: Type.Integer({ minimum: 0 }),
        tornTail: Type.Boolean(),
        stale: Type.Boolean(),
        inconsistent: Type.Boolean(),
        maintenancePending: Type.Boolean(),
      }, closed),
      recovery: Type.Object({
        available: Type.Integer({ minimum: 0 }),
        conflicted: Type.Integer({ minimum: 0 }),
        reverted: Type.Integer({ minimum: 0 }),
        expired: Type.Integer({ minimum: 0 }),
        retainedBytes: Type.Integer({ minimum: 0 }),
        budgetBytes: Type.Integer({ minimum: 0 }),
        orphanBlobCount: Type.Integer({ minimum: 0 }),
      }, closed),
    }, closed),
  }, closed),
], { $id: 'RuntimeStatus' });

export const AssetMetadataSchema = Type.Object({
  mimeType: Type.String({ minLength: 1, maxLength: 256 }),
  byteSize: Type.Integer({ minimum: 0 }),
  sha256: Digest,
  originalFilename: Type.Optional(Type.String({ maxLength: 4_096 })),
  imageWidth: Type.Optional(Type.Integer({ minimum: 0 })),
  imageHeight: Type.Optional(Type.Integer({ minimum: 0 })),
  thumbnailAssetId: Type.Optional(Identifier),
  pdfPageCount: Type.Optional(Type.Integer({ minimum: 0 })),
  audioDurationMs: Type.Optional(Type.Integer({ minimum: 0 })),
  videoDurationMs: Type.Optional(Type.Integer({ minimum: 0 })),
}, { ...closed, $id: 'AssetMetadata' });

export const AssetRecordSchema = Type.Object({
  protocolVersion: Type.Literal(OUTLINE_PROTOCOL_VERSION),
  kind: Type.Literal('outline.asset'),
  assetId: Identifier,
  metadata: AssetMetadataSchema,
  createdAt: Timestamp,
}, { ...closed, $id: 'AssetRecord' });

export const AssetLeaseSchema = Type.Object({
  protocolVersion: Type.Literal(OUTLINE_PROTOCOL_VERSION),
  leaseId: Identifier,
  assetId: Identifier,
  metadata: AssetMetadataSchema,
  expiresAt: Timestamp,
}, { ...closed, $id: 'AssetLease' });

export const OUTLINE_PUBLIC_SCHEMAS = Object.freeze({
  Selector: SelectorSchema,
  TargetSpec: TargetSpecSchema,
  TargetRef: TargetRefSchema,
  Projection: ProjectionSchema,
  ProjectionResult: ProjectionResultSchema,
  NodeDraft: NodeDraftSchema,
  RichTextPatch: RichTextPatchSchema,
  Change: ChangeSchema,
  ChangeSet: ChangeSetSchema,
  Diff: DiffSchema,
  Operation: OperationSchema,
  OperationLogPage: OperationLogPageSchema,
  RevertConflictDiff: RevertConflictDiffSchema,
  Event: EventSchema,
  EventFilter: EventFilterSchema,
  OutlineError: OutlineErrorSchema,
  OutlineRequest: OutlineRequestSchema,
  OutlineResponse: OutlineResponseSchema,
  OutlineStreamRecord: OutlineStreamRecordSchema,
  RuntimeDescriptor: RuntimeDescriptorSchema,
  RuntimeStatus: RuntimeStatusSchema,
  AssetMetadata: AssetMetadataSchema,
  AssetRecord: AssetRecordSchema,
  AssetLease: AssetLeaseSchema,
} satisfies Readonly<Record<string, TSchema>>);

export type QueryExpression = Static<typeof QueryExpressionSchema>;
export type Selector = Static<typeof SelectorSchema>;
export type TargetSpec = Static<typeof TargetSpecSchema>;
export type TargetRef = Static<typeof TargetRefSchema>;
export type Projection = Static<typeof ProjectionSchema>;
export type ProjectionResult = Static<typeof ProjectionResultSchema>;
export type NodeDraft = Static<typeof NodeDraftSchema>;
export type UpdateInstruction = Static<typeof UpdateInstructionSchema>;
export type Change = Static<typeof ChangeSchema>;
export type ChangeSet = Static<typeof ChangeSetSchema>;
export type Diff = Static<typeof DiffSchema>;
export type Operation = Static<typeof OperationSchema>;
export type OperationLogPage = Static<typeof OperationLogPageSchema>;
export type RevertConflictDiff = Static<typeof RevertConflictDiffSchema>;
export type OutlineEvent = Static<typeof EventSchema>;
export type EventFilter = Static<typeof EventFilterSchema>;
export type WatchRequest = Static<typeof WatchRequestSchema>;
export type OutlineRequest = Static<typeof OutlineRequestSchema>;
export type OutlineResponse = Static<typeof OutlineResponseSchema>;
export type OutlineStreamRecord = Static<typeof OutlineStreamRecordSchema>;
export type RuntimeDescriptor = Static<typeof RuntimeDescriptorSchema>;
export type RuntimeStatus = Static<typeof RuntimeStatusSchema>;
export type AssetLease = Static<typeof AssetLeaseSchema>;
export type AssetMetadata = Static<typeof AssetMetadataSchema>;
export type AssetRecord = Static<typeof AssetRecordSchema>;
