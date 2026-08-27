import Type, { type TObject, type TSchema } from 'typebox';

const closed = { additionalProperties: false } as const;
const QueryIdentifierSchema = Type.String({ minLength: 1, maxLength: 256 });
const QueryOperandSchema = Type.Union([
  Type.Object({
    text: Type.String({ minLength: 1, maxLength: 65_536 }),
    targetId: Type.Optional(QueryIdentifierSchema),
  }, closed),
  Type.Object({
    text: Type.Optional(Type.String({ minLength: 1, maxLength: 65_536 })),
    targetId: QueryIdentifierSchema,
  }, closed),
]);

export type QueryOperandRequirement = 'none' | 'required' | 'optional';
export type QueryValueRequirement = 'none' | 'required-text' | 'required-text-or-operands';
export type QueryOperatorCategory = 'text' | 'tag' | 'state' | 'field' | 'time' | 'link' | 'calendar' | 'structure' | 'location' | 'type' | 'media';

export interface QueryOperatorContract<Name extends string = string> {
  readonly name: Name;
  readonly executable: true;
  readonly category: QueryOperatorCategory;
  readonly operands: {
    readonly field: QueryOperandRequirement;
    readonly tag: QueryOperandRequirement;
    readonly target: QueryOperandRequirement;
    readonly value: QueryValueRequirement;
  };
  readonly valueFormat?: string;
  readonly summary: string;
  readonly example: Readonly<Record<string, unknown>>;
}

type OperandOverrides = Partial<QueryOperatorContract['operands']>;

function operator<const Name extends string>(
  name: Name,
  category: QueryOperatorCategory,
  summary: string,
  example: Readonly<Record<string, unknown>>,
  operands: OperandOverrides = {},
  valueFormat?: string,
): QueryOperatorContract<Name> {
  return Object.freeze({
    name,
    executable: true,
    category,
    operands: Object.freeze({
      field: 'none',
      tag: 'none',
      target: 'none',
      value: 'none',
      ...operands,
    }),
    ...(valueFormat ? { valueFormat } : {}),
    summary,
    example: Object.freeze({ kind: 'rule', op: name, ...example }),
  });
}

const freeText = 'Non-empty UTF-8 text.';
const fieldValue = 'One or more non-empty text values or referenced Node operands.';
const dateValue = 'YYYY-MM-DD, YYYY-MM-DDTHH:mm, or start/end with "/".';

export const OUTLINE_QUERY_OPERATORS = Object.freeze([
  operator('STRING_MATCH', 'text', 'Match indexed Node text, descriptions, tags, and field text.', { text: 'module' }, { value: 'required-text' }, freeText),
  operator('REGEXP_MATCH', 'text', 'Match Node title or description text with a regular expression.', { text: '/module/i' }, { value: 'required-text' }, 'A JavaScript regular expression body or /pattern/flags.'),
  operator('HAS_TAG', 'tag', 'Match Nodes carrying one exact tag definition.', { tagDefId: 'tag:task' }, { tag: 'required' }),
  operator('TODO', 'state', 'Match Nodes that display a checkbox.', {}),
  operator('DONE', 'state', 'Match completed Nodes.', {}),
  operator('NOT_DONE', 'state', 'Match checkbox Nodes that are not completed.', {}),
  operator('FIELD_IS', 'field', 'Match an exact field value.', { fieldDefId: 'field:status', text: 'Open' }, { field: 'required', value: 'required-text-or-operands' }, fieldValue),
  operator('FIELD_IS_NOT', 'field', 'Match Nodes with the field but without the specified value.', { fieldDefId: 'field:status', text: 'Closed' }, { field: 'required', value: 'required-text-or-operands' }, fieldValue),
  operator('FIELD_CONTAINS', 'field', 'Match field values containing text.', { fieldDefId: 'field:notes', text: 'module' }, { field: 'required', value: 'required-text-or-operands' }, freeText),
  operator('IS_EMPTY', 'field', 'Match Nodes where the field exists without a value.', { fieldDefId: 'field:owner' }, { field: 'required' }),
  operator('IS_NOT_EMPTY', 'field', 'Match Nodes where the field has a value.', { fieldDefId: 'field:owner' }, { field: 'required' }),
  operator('HAS_FIELD', 'field', 'Match any field, or one exact field when fieldDefId is supplied.', { fieldDefId: 'field:status' }, { field: 'optional' }),
  operator('FIELD_IS_SET', 'field', 'Match Nodes where the field has at least one value.', { fieldDefId: 'field:status' }, { field: 'required' }),
  operator('FIELD_IS_NOT_SET', 'field', 'Match Nodes where the field has no value, including an absent field.', { fieldDefId: 'field:status' }, { field: 'required' }),
  operator('FIELD_IS_DEFINED', 'field', 'Match Nodes where the field slot exists.', { fieldDefId: 'field:status' }, { field: 'required' }),
  operator('FIELD_IS_NOT_DEFINED', 'field', 'Match Nodes where the field slot does not exist.', { fieldDefId: 'field:status' }, { field: 'required' }),
  operator('LT', 'field', 'Match field values less than a scalar value.', { fieldDefId: 'field:price', text: '10' }, { field: 'required', value: 'required-text-or-operands' }, 'A number, date value, or field-compatible scalar.'),
  operator('GT', 'field', 'Match field values greater than a scalar value.', { fieldDefId: 'field:price', text: '10' }, { field: 'required', value: 'required-text-or-operands' }, 'A number, date value, or field-compatible scalar.'),
  operator('DATE_OVERLAPS', 'field', 'Match date-field ranges overlapping one or more supplied ranges.', { fieldDefId: 'field:due', text: '2026-08-24/2026-08-31' }, { field: 'required', value: 'required-text-or-operands' }, dateValue),
  operator('OVERDUE', 'field', 'Match unfinished Nodes with overdue date values, optionally in one field.', { fieldDefId: 'field:due' }, { field: 'optional' }),
  operator('CREATED_LAST_DAYS', 'time', 'Match Nodes created within the last number of days.', { text: '7' }, { value: 'required-text' }, 'A non-negative integer day count.'),
  operator('EDITED_LAST_DAYS', 'time', 'Match Nodes edited within the last number of days.', { text: '7' }, { value: 'required-text' }, 'A non-negative integer day count.'),
  operator('DONE_LAST_DAYS', 'time', 'Match Nodes completed within the last number of days.', { text: '7' }, { value: 'required-text' }, 'A non-negative integer day count.'),
  operator('LINKS_TO', 'link', 'Match Nodes containing a reference to one exact target.', { targetId: 'node:source' }, { target: 'required' }),
  operator('CHILD_OF', 'structure', 'Match direct children of a target, including referenced children.', { targetId: 'node:project' }, { target: 'required' }),
  operator('OWNED_BY', 'structure', 'Match direct children owned by one exact parent.', { targetId: 'node:project' }, { target: 'required' }),
  operator('DESCENDANT_OF', 'structure', 'Match descendants of one exact target.', { targetId: 'node:project' }, { target: 'required' }),
  operator('DESCENDANT_OF_WITH_REFS', 'structure', 'Match descendants and referenced content below one exact target.', { targetId: 'node:project' }, { target: 'required' }),
  operator('PARENTS_DESCENDANTS', 'structure', 'Match descendants of the Saved Search parent.', {}),
  operator('GRANDPARENTS_DESCENDANTS', 'structure', 'Match descendants of the Saved Search grandparent.', {}),
  operator('PARENTS_DESCENDANTS_WITH_REFS', 'structure', 'Match descendants and referenced content below the Saved Search parent.', {}),
  operator('GRANDPARENTS_DESCENDANTS_WITH_REFS', 'structure', 'Match descendants and referenced content below the Saved Search grandparent.', {}),
  operator('SIBLING_NAMED', 'structure', 'Match descendants of a Saved Search sibling with the exact supplied name.', { text: 'Projects' }, { value: 'required-text' }, freeText),
  operator('IN_LIBRARY', 'location', 'Match direct children of Library.', {}),
  operator('ON_DAY_NODE', 'calendar', 'Match direct children of a Daily Note day Node.', {}),
  operator('FOR_DATE', 'calendar', 'Match Nodes associated with an exact date or date range.', { text: '2026-08-24' }, { value: 'required-text-or-operands' }, dateValue),
  operator('FOR_RELATIVE_DATE', 'calendar', 'Match Nodes associated with a relative calendar range.', { text: 'this week' }, { value: 'required-text-or-operands' }, 'today, yesterday, tomorrow, this/last/next week, month, or year, or a resolvable calendar operand.'),
  operator('IS_TYPE', 'type', 'Match one or more Node type names.', { text: 'attachment' }, { value: 'required-text-or-operands' }, 'node, tag, field, search, calendar, day, week, year, image, attachment, or code.'),
  operator('HAS_MEDIA', 'media', 'Match image, audio, or video Nodes.', {}),
  operator('HAS_IMAGE', 'media', 'Match image Nodes.', {}),
  operator('HAS_AUDIO', 'media', 'Match attachment Nodes with an audio MIME type.', {}),
  operator('HAS_VIDEO', 'media', 'Match attachment Nodes with a video MIME type.', {}),
] as const);

export type OutlineQueryOperatorName = (typeof OUTLINE_QUERY_OPERATORS)[number]['name'];
export const OUTLINE_QUERY_OPS = Object.freeze(OUTLINE_QUERY_OPERATORS.map((entry) => entry.name));

export interface OutlineQueryOperand {
  readonly text?: string;
  readonly targetId?: string;
}

export interface OutlineQueryRule {
  readonly kind: 'rule';
  readonly op: OutlineQueryOperatorName;
  readonly text?: string;
  readonly fieldDefId?: string;
  readonly tagDefId?: string;
  readonly targetId?: string;
  readonly operands?: OutlineQueryOperand[];
}

const GeneratedQueryRuleSchema = Type.Union(
  OUTLINE_QUERY_OPERATORS.map((entry) => queryRuleSchema(entry)),
  { $id: 'QueryRule' },
);
export const QueryRuleSchema = Type.Unsafe<OutlineQueryRule>(GeneratedQueryRuleSchema);

export function queryOperatorContract(name: string): QueryOperatorContract | undefined {
  return OUTLINE_QUERY_OPERATORS.find((entry) => entry.name === name);
}

function queryRuleSchema(contract: QueryOperatorContract): TSchema {
  const base: Record<string, TSchema> = {
    kind: Type.Literal('rule'),
    op: Type.Literal(contract.name),
  };
  addIdentifierOperand(base, 'fieldDefId', contract.operands.field, 'Field definition Node ID.');
  addIdentifierOperand(base, 'tagDefId', contract.operands.tag, 'Tag definition Node ID.');
  addIdentifierOperand(base, 'targetId', contract.operands.target, 'Target Node ID.');

  if (contract.operands.value === 'required-text') {
    return objectSchema(contract, {
      ...base,
      text: valueTextSchema(contract),
      operands: Type.Optional(valueOperandsSchema(contract)),
    });
  }
  if (contract.operands.value === 'required-text-or-operands') {
    return Type.Union([
      objectSchema(contract, {
        ...base,
        text: valueTextSchema(contract),
        operands: Type.Optional(valueOperandsSchema(contract)),
      }),
      objectSchema(contract, {
        ...base,
        text: Type.Optional(valueTextSchema(contract)),
        operands: valueOperandsSchema(contract),
      }),
    ], { description: contract.summary });
  }
  return objectSchema(contract, base);
}

function addIdentifierOperand(
  properties: Record<string, TSchema>,
  property: 'fieldDefId' | 'tagDefId' | 'targetId',
  requirement: QueryOperandRequirement,
  description: string,
): void {
  if (requirement === 'none') return;
  const schema = Type.String({ minLength: 1, maxLength: 256, description });
  properties[property] = requirement === 'required' ? schema : Type.Optional(schema);
}

function valueTextSchema(contract: QueryOperatorContract) {
  return Type.String({
    minLength: 1,
    maxLength: 65_536,
    description: contract.valueFormat ?? freeText,
  });
}

function valueOperandsSchema(contract: QueryOperatorContract) {
  return Type.Array(QueryOperandSchema, {
    minItems: 1,
    maxItems: 256,
    description: contract.valueFormat ?? fieldValue,
  });
}

function objectSchema(contract: QueryOperatorContract, properties: Record<string, TSchema>): TObject {
  return Type.Object(properties, { ...closed, description: contract.summary });
}
