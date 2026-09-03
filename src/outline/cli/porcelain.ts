import type {
  AssetLease,
  Change,
  ChangeSet,
  DestinationPlacement,
  NodeDraft,
  OneTargetRef,
  Projection,
  ProjectionResult,
  Placement,
  Selector,
  TargetRef,
  TargetSpec,
  UpdateInstruction,
} from '../contract/schemas';
import { CaptureProvenanceSchema } from '../contract/schemas';
import { OutlineContractError, outlineError } from '../contract/errors';
import { PUBLIC_FIELD_TYPES, porcelainContract, porcelainHelpOptions } from '../contract/porcelain';
import { checkOutlineSchema, outlineSchemaValidationDetails } from '../contract/validation';
import { createChangeSet, parseSelectorToken, splitOptionTerminator, type StructuredReader } from './arguments';
import { canonicalJson } from '../contract/canonical';

type PublicViewField = Extract<
  UpdateInstruction,
  { kind: 'view'; property: 'sort'; action: 'add' }
>['field'];

export interface PorcelainBuildContext {
  readonly read: StructuredReader;
  readonly lookup: (selector: Selector) => Promise<Record<string, unknown>>;
  readonly project: (projection: Projection) => Promise<ProjectionResult>;
  readonly ingestAsset: (source: string) => Promise<AssetLease>;
}

export interface PorcelainRequest {
  readonly changeSet: ChangeSet;
  readonly preview?: boolean;
  readonly expectDiff?: string;
  readonly acknowledgeDestructive?: boolean;
}

const COMMON_BOOLEAN_OPTIONS = new Set(['preview', 'yes']);

export async function buildPorcelainRequest(
  command: string,
  args: readonly string[],
  context: PorcelainBuildContext,
): Promise<PorcelainRequest> {
  const parsed = parseOptions(command, args);
  const input = option(parsed, 'input');
  const idempotencyKey = option(parsed, 'idempotency-key') ?? `cli:${crypto.randomUUID()}`;
  const preview = flag(parsed, 'preview');
  const expectDiff = option(parsed, 'expect-diff');
  const yes = flag(parsed, 'yes');
  if (preview && expectDiff) throw usageError('--preview cannot be combined with --expect-diff.');
  if (preview && yes) throw usageError('--preview cannot be combined with --yes.');
  if (yes && !expectDiff) throw usageError('--yes requires --expect-diff for porcelain commands.');
  if (expectDiff && !option(parsed, 'idempotency-key')) {
    throw usageError('--expect-diff requires the same --idempotency-key returned by the reviewed preview.');
  }

  let changeSet: ChangeSet;
  let structuredInput: Record<string, unknown> | undefined;
  if (input) {
    if (parsed.positional.length > 0) throw usageError(`${command} cannot combine --input with positional arguments.`);
    const payload = parseJson(await context.read(input), `${command} input`);
    const contract = porcelainContract(command)!;
    if (!checkOutlineSchema(contract.inputSchema, payload)) {
      throw schemaUsageError(
        `Input does not match the public schema for command: ${command}`,
        contract.inputSchema,
        payload,
      );
    }
    structuredInput = normalizeStructuredInput(command, payload as Record<string, unknown>);
  }
  if (command === 'replace text') {
    const replacementInput = structuredInput ?? await textReplaceInputFromArgv(parsed, context);
    const plan = await planTextReplacement(replacementInput, context);
    changeSet = createChangeSet(plan.changes, idempotencyKey);
    changeSet.base = { revision: plan.revision };
  } else if (structuredInput) {
    changeSet = createChangeSet(await buildChangesFromInput(command, structuredInput, context), idempotencyKey);
  } else {
    changeSet = createChangeSet(await buildChanges(command, parsed, context), idempotencyKey);
  }
  if (changeSet.idempotencyKey && changeSet.idempotencyKey !== idempotencyKey) {
    throw usageError('--idempotency-key does not match the ChangeSet input.');
  }
  changeSet.idempotencyKey = idempotencyKey;
  attachDefaultReturn(command, changeSet);
  assertOnlyCommonOptionsConsumed(parsed);
  return {
    changeSet,
    ...(preview ? { preview: true } : {}),
    ...(expectDiff ? { expectDiff } : {}),
    ...(yes ? { acknowledgeDestructive: true } : {}),
  };
}

function normalizeStructuredInput(
  command: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const normalized = { ...input };
  if (input.placement !== undefined) normalized.placement = structuredPlacement(input.placement);
  if (command === 'create' && input.at !== undefined) normalized.at = structuredCreatePlacement(input.at);
  if (input.target !== undefined) normalized.target = structuredTarget(input.target);

  if (command === 'merge') {
    normalized.source = structuredTarget(input.source);
  }
  if ((command === 'search create' || command === 'capture create') && input.parent !== undefined) {
    normalized.parent = exactTarget(input.parent);
  }
  if ((command === 'search create' || command === 'search edit') && isRecord(input.view)) {
    normalized.view = structuredViewConfiguration(input.view);
  }
  if (command === 'view set' && isRecord(input.view)) normalized.view = structuredViewConfiguration(input.view);
  if (command === 'define edit' && typeof input.target === 'string') {
    normalized.target = exactTarget(input.target);
  }
  if (command === 'create' && Array.isArray(input.fields)) {
    normalized.fields = input.fields.map((field) => isRecord(field) && typeof field.field === 'string'
      ? { ...field, field: exactTarget(field.field) }
      : field);
  }
  return normalized;
}

function structuredCreatePlacement(value: unknown): DestinationPlacement {
  if (!isRecord(value) || typeof value.position !== 'string') {
    if (isRecord(value) && typeof value.parent === 'string' && value.position === undefined) {
      return { kind: 'last', parent: exactTarget(value.parent) };
    }
    throw usageError('create.at must name a parent/sibling and position.');
  }
  if (value.position === 'before' || value.position === 'after') {
    return { kind: value.position, sibling: exactTarget(value.sibling) };
  }
  if (value.position === 'first' || value.position === 'last') {
    return { kind: value.position, parent: exactTarget(value.parent) };
  }
  if (value.position === 'index') {
    return { kind: 'index', parent: exactTarget(value.parent), index: Number(value.index) };
  }
  throw usageError(`Unknown create position: ${String(value.position)}.`);
}

function structuredViewConfiguration(value: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...value };
  if (value.mode === 'outline') normalized.mode = 'list';
  if (value.group !== undefined && value.group !== null) normalized.group = structuredViewField(value.group);
  for (const key of ['sort', 'filters', 'display'] as const) {
    if (Array.isArray(value[key])) normalized[key] = value[key].map(structuredViewFieldContainer);
  }
  if (isRecord(value.replace)) {
    normalized.replace = structuredViewConfiguration(value.replace);
  }
  return normalized;
}

function structuredViewFieldContainer(value: unknown): unknown {
  if (!isRecord(value) || value.field === undefined || value.field === null) return value;
  return { ...value, field: structuredViewField(value.field) };
}

function structuredViewField(value: unknown): PublicViewField {
  if (typeof value !== 'string') throw usageError('View field must be a system field or exact field locator string.');
  return value.startsWith('sys:') ? value as PublicViewField : exactTarget(value);
}

function structuredTarget(value: unknown): TargetRef {
  if (typeof value === 'string') return exactTarget(value);
  if (isRecord(value) && isRecord(value.selector) && typeof value.cardinality === 'string') {
    return { target: value as unknown as TargetSpec };
  }
  throw usageError('Structured target must be an exact locator string or bounded TargetSpec.');
}

function exactTarget(value: unknown): OneTargetRef {
  if (typeof value !== 'string') throw usageError('Exact target must be a Node ID, typed ID, or stable @alias string.');
  return { target: { selector: parseSelectorToken(value), cardinality: 'one' } };
}

function structuredPlacement(value: unknown): DestinationPlacement | Placement {
  if (!isRecord(value) || typeof value.kind !== 'string') throw usageError('Structured placement is invalid.');
  if (value.kind === 'previous' || value.kind === 'next') return { kind: value.kind };
  if (value.kind === 'before' || value.kind === 'after') {
    return { kind: value.kind, sibling: exactTarget(value.sibling) };
  }
  if (value.kind === 'first' || value.kind === 'last') {
    return { kind: value.kind, parent: exactTarget(value.parent) };
  }
  if (value.kind === 'index') {
    return { kind: 'index', parent: exactTarget(value.parent), index: Number(value.index) };
  }
  throw usageError(`Unknown structured placement kind: ${String(value.kind)}.`);
}

async function buildChangesFromInput(
  command: string,
  input: Record<string, unknown>,
  context: PorcelainBuildContext,
): Promise<readonly Change[]> {
  if (command === 'create') return buildCreateChanges(input, context);
  if (command === 'edit') return [editChangeFromInput(input)];
  if (command === 'define create') return [await defineCreateChange(input, context)];
  if (command === 'define ensure') return [await defineEnsureChange(input, context)];
  if (command === 'define edit') return [await defineEditChange(input, context)];
  if (command === 'move' || command === 'duplicate') {
    if (command === 'duplicate') return [{
      op: 'duplicate',
      targets: input.target as TargetRef,
      placement: input.placement as Placement,
      bind: String(input.bind ?? 'copies'),
    }];
    return [{
      op: 'move',
      targets: input.target as TargetRef,
      placement: input.placement as Placement,
    }];
  }
  if (command === 'merge') {
    return [{ op: 'merge', sources: input.source as TargetRef, target: input.target as TargetRef }];
  }
  if (command === 'view set') return [viewChangeFromInput(input)];
  if (command === 'search create') return searchCreateChanges(input);
  if (command === 'search edit') return [searchSetChange(input)];
  if (command === 'template apply') return [{ op: 'template', action: 'apply', tag: input.tag as TargetRef }];
  if (command === 'daily ensure') return [{
    op: 'ensure', resource: 'date', date: String(input.date), bind: String(input.bind ?? 'date'),
  }];
  if (command === 'capture create') return captureChanges(input);
  if (command === 'trash' || command === 'restore' || command === 'purge') return [{
    op: 'lifecycle', action: command, targets: input.target as TargetRef,
  }];
  throw usageError(`Structured input lowering is not implemented for command: ${command}`);
}

function editChangeFromInput(input: Record<string, unknown>): Change {
  const instructions: UpdateInstruction[] = [];
  const node = isRecord(input.node) ? input.node : undefined;
  if (node) {
    if (Object.hasOwn(node, 'text')) instructions.push({ kind: 'content', value: richText(String(node.text)) });
    if (Object.hasOwn(node, 'description')) instructions.push({ kind: 'description', value: node.description as string | null });
    if (Object.hasOwn(node, 'codeLanguage')) {
      instructions.push({ kind: 'code', language: node.codeLanguage === null ? '' : String(node.codeLanguage) });
    }
    if (typeof node.checkbox === 'boolean') instructions.push({ kind: 'checkbox', visible: node.checkbox });
    if (typeof node.done === 'boolean') instructions.push({ kind: 'done', value: node.done });
    if (Object.hasOwn(node, 'icon')) instructions.push({
      kind: 'icon',
      value: node.icon as string | null,
      ...(typeof node.iconKind === 'string' ? { iconKind: node.iconKind } : {}),
    });
  }
  const tags = isRecord(input.tags) ? input.tags : undefined;
  for (const tag of Array.isArray(tags?.add) ? tags.add : []) {
    instructions.push({ kind: 'tag', action: 'add', tag: exactTarget(tag) });
  }
  for (const tag of Array.isArray(tags?.remove) ? tags.remove : []) {
    instructions.push({ kind: 'tag', action: 'remove', tag: exactTarget(tag) });
  }
  for (const entry of Array.isArray(input.fields) ? input.fields : []) {
    const field = entry as Record<string, unknown>;
    const action = String(field.action ?? 'set');
    if (action === 'set') instructions.push({
      kind: 'field', action: 'set', field: exactTarget(field.field),
      value: field.value as string | number | boolean | null,
    });
    else if (action === 'clear' || action === 'remove') instructions.push({
      kind: 'field', action, field: exactTarget(field.field),
    });
    else if (action === 'select') instructions.push({
      kind: 'field', action: 'select', field: exactTarget(field.field), option: exactTarget(field.option),
    });
  }
  for (const entry of Array.isArray(input.references) ? input.references : []) {
    const reference = entry as Record<string, unknown>;
    instructions.push({
      kind: 'reference',
      action: reference.action as 'add' | 'retarget' | 'replace' | 'inline' | 'restore',
      target: exactTarget(reference.target),
    });
  }
  const sources = Array.isArray(input.sources) ? input.sources : [];
  if (sources.length > 0) {
    const target = input.target as TargetRef;
    if ('binding' in target || target.target.cardinality !== 'one' || target.target.max !== undefined) {
      throw usageError('edit.sources requires one exact owner target.');
    }
  }
  for (const entry of sources) {
    const source = entry as Record<string, unknown>;
    const action = String(source.action);
    if (action === 'add') instructions.push({
      kind: 'source',
      action: 'add',
      sourceText: String(source.text),
      ...(source.id ? { valueId: String(source.id) } : {}),
      ...(Object.hasOwn(source, 'after') ? {
        after: source.after === null ? null : exactTarget(source.after),
      } : {}),
    });
    else if (action === 'replace') instructions.push({
      kind: 'source', action: 'replace', value: exactTarget(source.value), sourceText: String(source.text),
    });
    else if (action === 'reorder') instructions.push({
      kind: 'source', action: 'reorder', value: exactTarget(source.value),
      after: source.after === null ? null : exactTarget(source.after),
    });
    else if (action === 'remove') instructions.push({
      kind: 'source', action: 'remove', value: exactTarget(source.value),
    });
    else instructions.push({ kind: 'source', action: 'clear' });
  }
  if (instructions.length === 0) throw usageError('edit requires at least one desired-state property.');
  return { op: 'update', targets: input.target as TargetRef, changes: instructions };
}

async function buildCreateChanges(
  input: Record<string, unknown>,
  context: PorcelainBuildContext,
): Promise<readonly Change[]> {
  const placement = input.at as DestinationPlacement;
  await validateExactPlacement(placement, context);
  const ownerBind = String(input.bind ?? 'created');
  const usedBindings = new Set([ownerBind]);
  const fieldRefs = new Map<string, TargetRef>();
  const changes: Change[] = [];
  const declarations = (input.fields ?? []) as Array<Record<string, unknown>>;

  for (const [index, field] of declarations.entries()) {
    const key = String(field.key);
    if (fieldRefs.has(key)) throw usageError(`create.fields/${index}/key is duplicated: ${key}`);
    if (field.field) {
      const reference = field.field as OneTargetRef;
      if ('binding' in reference) throw usageError(`create.fields/${index}/field must be an exact persisted field.`);
      const node = await context.lookup(reference.target.selector);
      if (node.type !== 'fieldDef') {
        throw usageError(`create.fields/${index}/field does not resolve to a field definition.`);
      }
      const bind = nextInternalBinding('field', usedBindings);
      changes.push({
        op: 'ensure',
        resource: 'definition',
        definitionType: 'field',
        id: requiredString(node.id, `create.fields/${index}/field ID`),
        name: requiredString(
          isRecord(node.content) ? node.content.text : node.text,
          `create.fields/${index}/field name`,
        ),
        bind,
      });
      fieldRefs.set(key, { binding: bind });
      continue;
    }
    const bind = nextInternalBinding('field', usedBindings);
    changes.push({
      op: 'ensure',
      resource: 'definition',
      definitionType: 'field',
      name: String(field.name),
      config: await publicFieldConfig(field, context),
      bind,
    });
    fieldRefs.set(key, { binding: bind });
  }

  const node = await createNodeDraft(input.node as Record<string, unknown>, fieldRefs, context, '/node');
  changes.push({ op: 'create', placement, nodes: [node], bind: ownerBind });
  if (isRecord(input.view)) {
    changes.push({
      op: 'update',
      targets: { binding: ownerBind },
      changes: [{
        kind: 'view',
        property: 'configuration',
        action: 'set',
        view: createSemanticView(input.view, fieldRefs, declarations.map((field) => String(field.key))),
      }],
    });
  }
  return changes;
}

async function publicFieldConfig(
  declaration: Record<string, unknown>,
  context: PorcelainBuildContext,
  defaultType = true,
): Promise<Record<string, unknown>> {
  const type = declaration.type === undefined
    ? undefined
    : String(declaration.type) as keyof typeof PUBLIC_FIELD_TYPES;
  const input = isRecord(declaration.config) ? declaration.config : {};
  const result: Record<string, unknown> = {
    ...(type ? { fieldType: PUBLIC_FIELD_TYPES[type] } : defaultType ? { fieldType: 'plain' } : {}),
  };
  if (Object.hasOwn(input, 'nullable')) result.nullable = input.nullable;
  if (Object.hasOwn(input, 'hide')) {
    const hide = input.hide;
    result.hideField = hide === 'not-empty' ? 'not_empty' : hide === 'default' ? 'value_is_default' : hide;
  }
  if (Object.hasOwn(input, 'autoInitialize')) result.autoInitialize = input.autoInitialize;
  if (Object.hasOwn(input, 'collectOptions')) result.autocollectOptions = input.collectOptions;
  if (Object.hasOwn(input, 'min')) result.minValue = input.min;
  if (Object.hasOwn(input, 'max')) result.maxValue = input.max;
  if (typeof input.sourceTag === 'string') {
    const target = await context.lookup(parseSelectorToken(input.sourceTag));
    if (target.type !== 'tagDef') throw usageError('create field config sourceTag must resolve to a tag definition.');
    result.sourceSupertag = requiredString(target.id, 'source tag ID');
  } else if (input.sourceTag === null) result.sourceSupertag = null;
  return result;
}

async function defineCreateChange(
  input: Record<string, unknown>,
  context: PorcelainBuildContext,
): Promise<Change> {
  if (input.kind === 'field') {
    return {
      op: 'create',
      resource: 'definition',
      definitionType: 'field',
      name: String(input.name),
      ...(input.id ? { id: String(input.id) } : {}),
      config: await publicFieldConfig(input, context),
      bind: String(input.bind ?? 'definition'),
    };
  }
  return {
    op: 'create',
    resource: 'definition',
    definitionType: 'tag',
    name: String(input.name),
    ...(input.id ? { id: String(input.id) } : {}),
    bind: String(input.bind ?? 'definition'),
  };
}

async function defineEnsureChange(
  input: Record<string, unknown>,
  context: PorcelainBuildContext,
): Promise<Change> {
  if (input.kind === 'field') {
    return {
      op: 'ensure',
      resource: 'definition',
      definitionType: 'field',
      name: String(input.name),
      ...(input.id ? { id: String(input.id) } : {}),
      config: await publicFieldConfig(input, context),
      bind: String(input.bind ?? 'definition'),
    };
  }
  return {
    op: 'ensure',
    resource: 'definition',
    definitionType: 'tag',
    name: String(input.name),
    ...(input.id ? { id: String(input.id) } : {}),
    bind: String(input.bind ?? 'definition'),
  };
}

async function defineEditChange(
  input: Record<string, unknown>,
  context: PorcelainBuildContext,
): Promise<Change> {
  const definitionType = input.kind as 'field' | 'tag';
  const patch = definitionType === 'field'
    ? await publicFieldConfig(input, context, false)
    : input.config as Record<string, unknown>;
  return {
    op: 'update',
    targets: input.target as TargetRef,
    changes: [{ kind: 'definition', definitionType, patch } as Extract<UpdateInstruction, { kind: 'definition' }>],
  };
}

async function createNodeDraft(
  input: Record<string, unknown>,
  fieldRefs: ReadonlyMap<string, TargetRef>,
  context: PorcelainBuildContext,
  path: string,
): Promise<NodeDraft> {
  const values = isRecord(input.fields) ? input.fields : {};
  const fields = Object.entries(values).map(([key, value]) => {
    const field = fieldRefs.get(key);
    if (!field) throw usageError(`${path}/fields references undeclared field key: ${key}`);
    return { field, values: [draft(typeof value === 'string' ? value : canonicalJson(value))] };
  });
  const content = typeof input.text === 'string'
    ? richText(input.text)
    : input.text as NodeDraft['content'];
  const tags = await Promise.all((Array.isArray(input.tags) ? input.tags : []).map(async (tag, index) => {
    const reference = exactTarget(tag);
    if ('binding' in reference) throw usageError(`${path}/tags/${index} must reference a persisted Tag.`);
    const node = await context.lookup(reference.target.selector);
    if (node.type !== 'tagDef') throw usageError(`${path}/tags/${index} does not resolve to a Tag definition.`);
    return requiredString(node.id, `${path}/tags/${index} ID`);
  }));
  let referenceTargetId: string | undefined;
  if (input.reference !== undefined) {
    if (input.codeLanguage !== undefined) throw usageError(`${path} cannot be both a code block and a reference.`);
    const reference = exactTarget(input.reference);
    if ('binding' in reference) throw usageError(`${path}/reference must target a persisted Node.`);
    const target = await context.lookup(reference.target.selector);
    referenceTargetId = requiredString(target.id, `${path}/reference target ID`);
  }
  return {
    content,
    children: Array.isArray(input.children)
      ? await Promise.all(input.children.map((child, index) => createNodeDraft(
          child as Record<string, unknown>, fieldRefs, context, `${path}/children/${index}`,
        )))
      : [],
    ...(input.description !== undefined ? { description: String(input.description) } : {}),
    ...(referenceTargetId
      ? { type: 'reference' as const, referenceTargetId }
      : input.codeLanguage !== undefined
        ? { type: 'codeBlock' as const, codeLanguage: String(input.codeLanguage) }
        : {}),
    ...(input.checkbox !== undefined ? { checkbox: input.checkbox === true } : {}),
    ...(input.done !== undefined ? { done: input.done === true } : {}),
    ...(tags.length > 0 ? { tags } : {}),
    ...(fields.length > 0 ? { fields } : {}),
  };
}

function createSemanticView(
  input: Record<string, unknown>,
  fieldRefs: ReadonlyMap<string, TargetRef>,
  declaredKeys: readonly string[],
): Extract<UpdateInstruction, { kind: 'view'; property: 'configuration' }>['view'] {
  const field = (value: unknown): PublicViewField => {
    if (typeof value !== 'string') throw usageError('create.view field must be a declared key or system field.');
    if (value.startsWith('sys:')) return value as PublicViewField;
    const reference = fieldRefs.get(value);
    if (!reference) throw usageError(`create.view references undeclared field key: ${value}`);
    return reference;
  };
  const displayInput = Array.isArray(input.display) ? input.display : declaredKeys;
  return {
    ...(input.mode !== undefined ? { mode: input.mode === 'outline' ? 'list' : input.mode as 'table' | 'cards' | 'calendar' } : {}),
    ...(input.toolbar !== undefined ? { toolbar: input.toolbar === true } : {}),
    ...(input.group !== undefined ? { group: input.group === null ? null : field(input.group) } : {}),
    replace: {
      ...(Array.isArray(input.sort) ? { sort: input.sort.map((entry) => ({
        field: field((entry as Record<string, unknown>).field),
        ...((entry as Record<string, unknown>).direction !== undefined
          ? { direction: (entry as Record<string, unknown>).direction as 'asc' | 'desc' }
          : {}),
      })) } : {}),
      ...(Array.isArray(input.filters) ? { filters: input.filters.map((entry) => ({
        ...(entry as Record<string, unknown>), field: field((entry as Record<string, unknown>).field),
      })) } : {}),
      display: displayInput.map((entry) => {
        const value = typeof entry === 'string' ? { field: entry } : entry as Record<string, unknown>;
        return { ...value, field: field(value.field) };
      }),
    },
  };
}

async function validateExactPlacement(
  placement: DestinationPlacement,
  context: PorcelainBuildContext,
): Promise<void> {
  const reference = 'parent' in placement ? placement.parent : placement.sibling;
  if ('binding' in reference) throw usageError('create.at must reference one persisted target.');
  if (reference.target.cardinality !== 'one') {
    throw usageError('create.at must resolve exactly one target.');
  }
  await context.lookup(reference.target.selector);
}

function nextInternalBinding(prefix: string, used: Set<string>): string {
  let index = 0;
  while (used.has(`${prefix}${index}`)) index += 1;
  const binding = `${prefix}${index}`;
  used.add(binding);
  return binding;
}

function viewChangeFromInput(input: Record<string, unknown>): Change {
  return {
    op: 'update',
    targets: input.target as TargetRef,
    changes: [{
      kind: 'view',
      property: 'configuration',
      action: 'set',
      view: input.view as Extract<UpdateInstruction, { kind: 'view'; property: 'configuration' }>['view'],
    }],
  };
}

function searchCreateChanges(input: Record<string, unknown>): readonly Change[] {
  const query = queryFromInput(input);
  const bind = String(input.bind ?? 'search');
  const changes: Change[] = [{
    op: 'create',
    placement: { kind: 'last', parent: (input.parent as TargetRef | undefined) ?? oneAlias('saved-searches') },
    nodes: [draft(String(input.title), { type: 'search', metadata: { query } })],
    bind,
  }];
  if (input.view) changes.push({
    op: 'update', targets: { binding: bind }, changes: [{
      kind: 'view', property: 'configuration', action: 'set', view: createViewToSet(input.view as Record<string, unknown>),
    }],
  });
  return changes;
}

function searchSetChange(input: Record<string, unknown>): Change {
  if (input.query && input.match) throw usageError('search edit accepts --query or --match, not both.');
  const changes: UpdateInstruction[] = [];
  if (input.title !== undefined || input.query !== undefined || input.match !== undefined) changes.push({
    kind: 'search', action: 'set',
    ...(input.title !== undefined ? { title: String(input.title) } : {}),
    ...(input.query !== undefined || input.match !== undefined ? { query: queryFromInput(input) } : {}),
  });
  if (input.view) changes.push({
    kind: 'view', property: 'configuration', action: 'set',
    view: input.view as Extract<UpdateInstruction, { kind: 'view'; property: 'configuration' }>['view'],
  });
  if (changes.length === 0) throw usageError('search edit requires title, query, match, or view.');
  return { op: 'update', targets: input.target as TargetRef, changes };
}

function captureChanges(input: Record<string, unknown>): readonly Change[] {
  if (Boolean(input.parent) === Boolean(input.date)) throw usageError('capture create requires exactly one of parent or date.');
  if (!checkOutlineSchema(CaptureProvenanceSchema, input.provenance)) {
    throw schemaUsageError(
      'capture create provenance does not match CaptureProvenance.',
      CaptureProvenanceSchema,
      input.provenance,
    );
  }
  const bind = String(input.bind ?? 'capture');
  const changes: Change[] = [];
  let parent = input.parent as TargetRef | undefined;
  if (input.date) {
    changes.push({ op: 'ensure', resource: 'date', date: String(input.date), bind: 'captureDate' });
    parent = { binding: 'captureDate' };
  }
  changes.push({
    op: 'create', placement: { kind: 'last', parent: parent! }, bind,
    nodes: [draft(String(input.title), {
      ...(input.description !== undefined ? { description: String(input.description) } : {}),
      metadata: { capture: input.provenance },
      children: (input.children ?? []) as NodeDraft[],
    })],
  });
  const sourceText = captureSourceText(input.provenance as Record<string, unknown>);
  if (sourceText !== undefined) {
    changes.push({
      op: 'update',
      targets: { binding: bind },
      changes: [{ kind: 'source', action: 'add', sourceText }],
    });
  }
  return changes;
}

function captureSourceText(provenance: Record<string, unknown>): string | undefined {
  const source = provenance.source;
  if (!source || typeof source !== 'object' || Array.isArray(source)) return undefined;
  const record = source as Record<string, unknown>;
  const original = record.original;
  const originalUrl = original && typeof original === 'object' && !Array.isArray(original)
    && (original as Record<string, unknown>).kind === 'remote-url'
    ? (original as Record<string, unknown>).url
    : undefined;
  for (const candidate of [record.canonicalUrl, record.url, originalUrl]) {
    if (typeof candidate !== 'string') continue;
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return candidate;
    } catch {
      // Invalid provenance remains in its sidecar but does not become a Source.
    }
  }
  return undefined;
}

function queryFromInput(input: Record<string, unknown>) {
  if (input.query && input.match) throw usageError('Use either query or match, not both.');
  if (input.query) return input.query as NonNullable<NonNullable<NodeDraft['metadata']>['query']>;
  if (typeof input.match === 'string' && input.match.trim()) {
    return { kind: 'rule' as const, op: 'STRING_MATCH' as const, text: input.match.trim() };
  }
  throw usageError('A canonical query or non-empty match string is required.');
}

function createViewToSet(view: Record<string, unknown>): Extract<UpdateInstruction, { kind: 'view'; property: 'configuration' }>['view'] {
  const replace = {
    ...(view.sort !== undefined ? { sort: view.sort } : {}),
    ...(view.filters !== undefined ? { filters: view.filters } : {}),
    ...(view.display !== undefined ? { display: view.display } : {}),
  };
  return {
    ...(view.mode !== undefined ? { mode: view.mode === 'outline' ? 'list' : view.mode } : {}),
    ...(view.toolbar !== undefined ? { toolbar: view.toolbar } : {}),
    ...(Object.hasOwn(view, 'group') ? { group: view.group } : {}),
    ...(Object.keys(replace).length > 0 ? { replace } : {}),
  } as Extract<UpdateInstruction, { kind: 'view'; property: 'configuration' }>['view'];
}

function attachDefaultReturn(_command: string, changeSet: ChangeSet): void {
  if (changeSet.return) return;
  const binding = [...changeSet.operations].reverse().find((change) => (
    (change.op === 'create' || change.op === 'duplicate') && change.bind
  )) ?? changeSet.operations.find((change) => change.op === 'ensure' && change.bind);
  const survivingTarget = [...changeSet.operations].reverse().find((change) => (
    change.op === 'update' || change.op === 'move' || change.op === 'merge'
  ));
  const targets = (binding && 'bind' in binding && binding.bind ? { binding: binding.bind } as TargetRef : undefined)
    ?? (survivingTarget?.op === 'merge' ? survivingTarget.target : survivingTarget?.targets);
  if (!targets) return;
  changeSet.return = [{
    kind: 'node',
    targets,
    page: { limit: returnProjectionLimit(targets) },
  }];
}

function returnProjectionLimit(targets: TargetRef): number {
  if ('target' in targets) return targets.target.cardinality === 'many' ? targets.target.max ?? 100 : 1;
  return 100;
}

function oneAlias(alias: Extract<Selector, { by: 'alias' }>['alias']): TargetRef {
  return { target: { selector: { by: 'alias', alias }, cardinality: 'one' } };
}

function oneId(id: string): TargetRef {
  return { target: { selector: { by: 'id', id }, cardinality: 'one' } };
}

interface TextReplacementPlan {
  readonly changes: readonly Change[];
  readonly revision: number;
}

interface TextRange {
  readonly from: number;
  readonly to: number;
}

async function textReplaceInputFromArgv(
  parsed: ParsedOptions,
  context: PorcelainBuildContext,
): Promise<Record<string, unknown>> {
  allow(parsed, [
    'target', 'matching', 'query', 'within', 'include-trash', 'order', 'max',
    'find', 'with', 'field', 'occurrence', 'case-sensitive', 'max-replacements',
  ]);
  const targetToken = option(parsed, 'target') ?? parsed.positional.shift();
  const matching = option(parsed, 'matching');
  const querySource = option(parsed, 'query');
  const selectorForms = Number(Boolean(targetToken)) + Number(Boolean(matching)) + Number(Boolean(querySource));
  if (selectorForms !== 1 || parsed.positional.length > 0) {
    throw usageError('replace text requires exactly one TARGET, --matching TEXT, or --query JSON|FILE.');
  }

  let target: TargetSpec;
  if (targetToken) {
    const reference = await targetRef(targetToken, context.read);
    if ('binding' in reference) throw usageError('replace text cannot read a transaction binding before planning.');
    target = reference.target;
  } else {
    const max = integer(requiredOption(parsed, 'max'), '--max', 1);
    if (max > 10_000) throw usageError('--max must be between 1 and 10000.');
    const withinToken = option(parsed, 'within');
    const within = withinToken
      ? selectorFromExactTarget(await targetRef(withinToken, context.read))
      : undefined;
    const order = option(parsed, 'order') ?? 'document';
    if (!['document', 'created', 'updated', 'text'].includes(order)) {
      throw usageError('--order must be document, created, updated, or text.');
    }
    target = {
      selector: {
        by: 'query',
        query: querySource
          ? parseJson(await context.read(querySource), '--query') as Extract<Selector, { by: 'query' }>['query']
          : { kind: 'rule', op: 'STRING_MATCH', text: matching! },
        ...(within ? { within } : {}),
        ...(has(parsed, 'include-trash') ? { includeTrash: true } : {}),
        order: order as Extract<Selector, { by: 'query' }>['order'],
        limit: max,
      },
      cardinality: 'many',
      max,
    };
  }
  if (target.cardinality === 'many' && target.max === undefined) {
    throw usageError('replace text many targets require an explicit max bound.');
  }
  return {
    target,
    find: requiredOption(parsed, 'find'),
    replacement: requiredOption(parsed, 'with'),
    field: option(parsed, 'field') ?? 'content',
    occurrence: option(parsed, 'occurrence') ?? 'all',
    caseSensitive: boolean(option(parsed, 'case-sensitive') ?? 'true', '--case-sensitive'),
    maxReplacements: integer(option(parsed, 'max-replacements') ?? '1000', '--max-replacements', 1),
  };
}

async function planTextReplacement(
  input: Record<string, unknown>,
  context: PorcelainBuildContext,
): Promise<TextReplacementPlan> {
  const contract = porcelainContract('replace text')!;
  if (!checkOutlineSchema(contract.inputSchema, input)) {
    throw schemaUsageError(
      'Input does not match the public schema for command: replace text',
      contract.inputSchema,
      input,
    );
  }
  const target = input.target as TargetSpec;
  const find = String(input.find);
  const replacement = String(input.replacement);
  const field = (input.field ?? 'content') as 'content' | 'description' | 'both';
  const occurrence = (input.occurrence ?? 'all') as 'first' | 'all';
  const caseSensitive = input.caseSensitive !== false;
  const maxReplacements = Number(input.maxReplacements);
  const pageLimit = target.cardinality === 'many' ? target.max! : 1;
  const projection = await context.project({
    kind: 'node',
    targets: { target },
    include: ['description', 'references'],
    page: { limit: pageLimit },
  });
  if (projection.truncated || projection.cursor) {
    throw usageError('replace text Projection exceeded its declared Node bound.');
  }

  const changes: Change[] = [];
  let replacementCount = 0;
  for (const value of projection.nodes) {
    if (!isRecord(value)) throw usageError('replace text Projection returned an invalid Node.');
    const id = requiredString(value.id, 'replace text target ID');
    const instructions: UpdateInstruction[] = [];
    if (field === 'content' || field === 'both') {
      const content = projectedRichText(value.content, id);
      const ranges = literalTextRanges(content.text, find, caseSensitive, occurrence);
      replacementCount += ranges.length;
      assertReplacementBound(replacementCount, maxReplacements);
      if (ranges.length > 0 && find !== replacement) {
        instructions.push({
          kind: 'text-patch',
          field: 'content',
          patch: { ops: [{ type: 'replace_all', content: transformedRichText(content, ranges, replacement, id) }] },
          review: { destructive: 'replace' },
        });
      }
    }
    if (field === 'description' || field === 'both') {
      const description = typeof value.description === 'string' ? value.description : '';
      const ranges = literalTextRanges(description, find, caseSensitive, occurrence);
      replacementCount += ranges.length;
      assertReplacementBound(replacementCount, maxReplacements);
      if (ranges.length > 0 && find !== replacement) {
        const transformed = transformedPlainText(description, ranges, replacement);
        instructions.push({
          kind: 'text-patch', field: 'description', from: 0, to: description.length, value: transformed,
          review: { destructive: 'replace' },
        });
      }
    }
    if (instructions.length > 0) changes.push({ op: 'update', targets: oneId(id), changes: instructions });
  }

  if (changes.length === 0) {
    const first = projection.nodes.find(isRecord);
    changes.push(first
      ? {
          op: 'update',
          targets: oneId(requiredString(first.id, 'replace text target ID')),
          changes: [{ kind: 'content', value: projectedRichText(first.content, requiredString(first.id, 'replace text target ID')) }],
        }
      : {
          op: 'update',
          targets: { target },
          changes: [{ kind: 'content', value: richText('') }],
        });
  }
  return { changes, revision: projection.revision };
}

function projectedRichText(value: unknown, nodeId: string): NodeDraft['content'] {
  if (!isRecord(value)
    || typeof value.text !== 'string'
    || !Array.isArray(value.marks)
    || !Array.isArray(value.inlineRefs)) {
    throw usageError(`replace text Projection omitted rich content for Node: ${nodeId}`);
  }
  return value as NodeDraft['content'];
}

function literalTextRanges(
  text: string,
  find: string,
  caseSensitive: boolean,
  occurrence: 'first' | 'all',
): TextRange[] {
  const expression = new RegExp(find.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), caseSensitive ? 'gu' : 'giu');
  const ranges: TextRange[] = [];
  for (const match of text.matchAll(expression)) {
    const from = match.index;
    if (from === undefined) continue;
    ranges.push({ from, to: from + match[0].length });
    if (occurrence === 'first') break;
  }
  return ranges;
}

function transformedPlainText(text: string, ranges: readonly TextRange[], replacement: string): string {
  let cursor = 0;
  let result = '';
  for (const range of ranges) {
    result += text.slice(cursor, range.from) + replacement;
    cursor = range.to;
  }
  result += text.slice(cursor);
  if (result.length > 4_194_304) throw usageError('replace text result exceeds the maximum text length.');
  return result;
}

function transformedRichText(
  content: NodeDraft['content'],
  ranges: readonly TextRange[],
  replacement: string,
  nodeId: string,
): NodeDraft['content'] {
  for (const reference of content.inlineRefs) {
    if (ranges.some((range) => reference.offset > range.from && reference.offset < range.to)) {
      throw usageError(`replace text would consume an inline reference in Node ${nodeId}; use an exact rich-text patch instead.`);
    }
  }
  const text = transformedPlainText(content.text, ranges, replacement);
  const mapPosition = (position: number, bias: 'start' | 'end') => {
    let delta = 0;
    for (const range of ranges) {
      if (position <= range.from) return position + delta;
      const replacementEnd = range.from + delta + replacement.length;
      if (position < range.to) return bias === 'start' ? range.from + delta : replacementEnd;
      delta += replacement.length - (range.to - range.from);
    }
    return position + delta;
  };
  return {
    text,
    marks: content.marks
      .map((mark) => ({
        ...mark,
        ...(mark.attrs ? { attrs: { ...mark.attrs } } : {}),
        start: mapPosition(mark.start, 'start'),
        end: mapPosition(mark.end, 'end'),
      }))
      .filter((mark) => mark.end > mark.start),
    inlineRefs: content.inlineRefs.map((reference) => ({
      ...reference,
      target: { ...reference.target },
      offset: mapPosition(reference.offset, 'start'),
    })),
  };
}

function assertReplacementBound(count: number, max: number): void {
  if (count > max) {
    throw usageError(`replace text matched ${count} occurrences, exceeding maxReplacements ${max}.`);
  }
}

async function buildChanges(
  command: string,
  parsed: ParsedOptions,
  context: PorcelainBuildContext,
): Promise<readonly Change[]> {
  if (command === 'create') return [await buildCreateArgv(parsed, context)];
  if (command === 'edit') return [await buildEditArgv(parsed, context)];
  if (command.startsWith('define ')) {
    throw usageError(`${command} requires --input FILE|-.`);
  }
  if (command === 'move' || command === 'duplicate') {
    return [await buildMove(command, parsed, context)];
  }
  if (command === 'merge') return [await buildMerge(parsed, context)];
  if (command === 'view set') return [await buildView(parsed, context)];
  if (command === 'search create' || command === 'search edit') return buildSearch(command, parsed, context);
  if (command === 'template apply') return [await buildTemplate(parsed, context)];
  if (command === 'daily ensure') return [buildDailyEnsure(parsed)];
  if (command === 'capture create') return buildCapture(parsed, context);
  if (command === 'trash' || command === 'restore' || command === 'purge') {
    return [await buildLifecycle(command, parsed, context)];
  }
  throw usageError(`Porcelain builder is not implemented for command: ${command}`);
}

async function buildEditArgv(parsed: ParsedOptions, context: PorcelainBuildContext): Promise<Change> {
  allow(parsed, ['target', 'text', 'description', 'done', 'checkbox']);
  const targets = await targetRef(takeTargetToken(parsed, 'target'), context.read);
  const node: Record<string, unknown> = {};
  if (has(parsed, 'text')) node.text = option(parsed, 'text');
  if (has(parsed, 'description')) node.description = option(parsed, 'description') === 'null' ? null : option(parsed, 'description');
  if (has(parsed, 'done')) node.done = boolean(option(parsed, 'done')!, '--done');
  if (has(parsed, 'checkbox')) node.checkbox = boolean(option(parsed, 'checkbox')!, '--checkbox');
  return editChangeFromInput({ target: targets, node });
}

async function buildCreateArgv(parsed: ParsedOptions, context: PorcelainBuildContext): Promise<Change> {
  allow(parsed, ['parent', 'first', 'last', 'index', 'before', 'after', 'bind']);
  const anchored = parsed.options.has('before') || parsed.options.has('after');
  const parentToken = option(parsed, 'parent') ?? (!anchored ? parsed.positional.shift() : undefined);
  const placement = await placementFromParsed(parsed, context, parentToken, false);
  await validateExactPlacement(placement as DestinationPlacement, context);
  const text = parsed.positional.splice(0).join(' ');
  if (!text) throw usageError('create requires text or --input FILE|-.');
  return {
    op: 'create',
    placement: placement as DestinationPlacement,
    nodes: [draft(text)],
    bind: option(parsed, 'bind') ?? 'created',
  };
}

async function buildMove(
  command: string,
  parsed: ParsedOptions,
  context: PorcelainBuildContext,
): Promise<Change> {
  allow(parsed, ['target', 'destination', 'first', 'last', 'index', 'before', 'after', 'previous', 'next', 'bind']);
  const targetToken = takeTargetToken(parsed, 'target');
  const targets = await targetRef(targetToken, context.read);
  const selfContained = ['before', 'after', 'previous', 'next'].some((name) => parsed.options.has(name));
  const destinationToken = option(parsed, 'destination') ?? (!selfContained ? parsed.positional.shift() : undefined);
  const placement = await placementFromParsed(parsed, context, destinationToken, true);
  if (parsed.positional.length > 0) throw usageError(`Unexpected ${command} argument: ${parsed.positional[0]}`);
  if (command === 'duplicate') {
    return {
      op: 'duplicate', targets, placement,
      bind: option(parsed, 'bind') ?? 'copies',
    };
  }
  return { op: 'move', targets, placement };
}

async function placementFromParsed(
  parsed: ParsedOptions,
  context: PorcelainBuildContext,
  parentToken: string | undefined,
  allowRelative: boolean,
): Promise<Placement | DestinationPlacement> {
  const before = option(parsed, 'before');
  const after = option(parsed, 'after');
  const indexValue = option(parsed, 'index');
  const first = flag(parsed, 'first');
  const last = flag(parsed, 'last');
  const previous = flag(parsed, 'previous');
  const next = flag(parsed, 'next');
  const selectedCount = [before, after, indexValue, first, last, previous, next]
    .filter((value) => Boolean(value)).length;
  if (selectedCount > 1) {
    throw usageError('Choose exactly one of --first, --last, --index, --before, --after, --previous, or --next.');
  }
  if ((previous || next) && !allowRelative) throw usageError('Relative placement is not valid for create.');
  if (before || after) {
    if (parentToken) throw usageError('--before and --after infer their parent and cannot be combined with a destination.');
    return {
      kind: before ? 'before' : 'after',
      sibling: await targetRef((before ?? after)!, context.read),
    };
  }
  if (previous || next) {
    if (parentToken) throw usageError('--previous and --next cannot be combined with a destination.');
    return { kind: previous ? 'previous' : 'next' };
  }
  if (!parentToken) throw usageError('This placement requires a parent or destination.');
  const parent = await targetRef(parentToken, context.read);
  if (indexValue !== undefined) return { kind: 'index', parent, index: integer(indexValue, '--index', 0) };
  if (first) return { kind: 'first', parent };
  return { kind: 'last', parent };
}

async function buildMerge(parsed: ParsedOptions, context: PorcelainBuildContext): Promise<Change> {
  allow(parsed, ['source', 'target']);
  const source = option(parsed, 'source') ?? parsed.positional.shift();
  const target = option(parsed, 'target') ?? parsed.positional.shift();
  if (!source || !target || parsed.positional.length > 0) throw usageError('merge requires SOURCE and TARGET.');
  return { op: 'merge', sources: await targetRef(source, context.read), target: await targetRef(target, context.read) };
}

async function buildView(parsed: ParsedOptions, context: PorcelainBuildContext): Promise<Change> {
  allow(parsed, ['target', 'mode', 'toolbar', 'group', 'replace']);
  const target = option(parsed, 'target') ?? parsed.positional.shift();
  if (!target) throw usageError('view set requires a target.');
  const mode = option(parsed, 'mode') ?? parsed.positional.shift();
  const toolbar = option(parsed, 'toolbar');
  const group = option(parsed, 'group');
  const replacementSource = option(parsed, 'replace');
  const parsedReplacement = replacementSource
    ? parseJson(await context.read(replacementSource), '--replace')
    : undefined;
  if (parsedReplacement !== undefined && !isRecord(parsedReplacement)) throw usageError('--replace must be an object.');
  const replacement = isRecord(parsedReplacement) ? structuredViewConfiguration(parsedReplacement) : undefined;
  if (parsed.positional.length > 0) throw usageError(`Unexpected view set argument: ${parsed.positional[0]}`);
  const view = {
    ...(mode !== undefined ? { mode: viewMode(mode) } : {}),
    ...(toolbar !== undefined ? { toolbar: boolean(toolbar, '--toolbar') } : {}),
    ...(group !== undefined ? { group: group === 'null' ? null : await viewField(group, context) } : {}),
    ...(replacement !== undefined ? { replace: replacement } : {}),
  };
  if (Object.keys(view).length === 0) {
    throw usageError('view set requires mode, toolbar, group, or explicit replacement.');
  }
  return {
    op: 'update',
    targets: await targetRef(target, context.read),
    changes: [{
      kind: 'view',
      property: 'configuration',
      action: 'set',
      view: view as Extract<UpdateInstruction, { kind: 'view'; property: 'configuration' }>['view'],
    }],
  };
}
async function buildSearch(
  command: 'search create' | 'search edit',
  parsed: ParsedOptions,
  context: PorcelainBuildContext,
): Promise<readonly Change[]> {
  if (command === 'search create') {
    allow(parsed, ['parent', 'title', 'query', 'match', 'view', 'sort', 'filter', 'group', 'display', 'toolbar', 'bind']);
    let parent = option(parsed, 'parent');
    let title = option(parsed, 'title');
    if (!title && parsed.positional.length >= 2) {
      parent ??= parsed.positional.shift();
      title = parsed.positional.shift();
    } else title ??= parsed.positional.shift();
    if (!title || parsed.positional.length > 0) throw usageError('search create requires --title TITLE.');
    const querySource = option(parsed, 'query');
    const match = option(parsed, 'match');
    const view: Record<string, unknown> = {};
    const mode = option(parsed, 'view');
    if (mode) view.mode = viewMode(mode);
    const toolbar = option(parsed, 'toolbar');
    if (toolbar !== undefined) view.toolbar = boolean(toolbar, '--toolbar');
    const group = option(parsed, 'group');
    if (group !== undefined) view.group = group === 'null' ? null : await viewField(group, context);
    const sort = option(parsed, 'sort');
    if (sort) {
      const shorthand = sortShorthand(sort);
      view.sort = [{ field: await viewField(shorthand.field, context), direction: shorthand.direction }];
    }
    const filter = option(parsed, 'filter');
    if (filter) view.filters = [await filterSpecification(parseJson(await context.read(filter), '--filter'), context)];
    const display = option(parsed, 'display');
    if (display) view.display = [{ field: await viewField(display, context) }];
    return searchCreateChanges({
      ...(parent ? { parent: await targetRef(parent, context.read) } : {}),
      title,
      ...(querySource ? { query: parseJson(await context.read(querySource), '--query') } : {}),
      ...(match ? { match } : {}),
      ...(Object.keys(view).length > 0 ? { view } : {}),
      bind: option(parsed, 'bind') ?? 'search',
    });
  }

  allow(parsed, ['target', 'title', 'query', 'match', 'view', 'replace']);
  const target = option(parsed, 'target') ?? parsed.positional.shift();
  if (!target || parsed.positional.length > 0) throw usageError('search edit requires TARGET.');
  const querySource = option(parsed, 'query');
  const match = option(parsed, 'match');
  const mode = option(parsed, 'view');
  const replaceSource = option(parsed, 'replace');
  const parsedReplacement = replaceSource ? parseJson(await context.read(replaceSource), '--replace') : undefined;
  if (parsedReplacement !== undefined && !isRecord(parsedReplacement)) throw usageError('--replace must be an object.');
  const view = mode || replaceSource ? {
    ...(mode ? { mode: viewMode(mode) } : {}),
    ...(isRecord(parsedReplacement) ? { replace: structuredViewConfiguration(parsedReplacement) } : {}),
  } : undefined;
  return [searchSetChange({
    target: await targetRef(target, context.read),
    ...(option(parsed, 'title') ? { title: option(parsed, 'title') } : {}),
    ...(querySource ? { query: parseJson(await context.read(querySource), '--query') } : {}),
    ...(match ? { match } : {}),
    ...(view ? { view } : {}),
  })];
}
async function buildTemplate(parsed: ParsedOptions, context: PorcelainBuildContext): Promise<Change> {
  allow(parsed, ['tag']);
  const tag = option(parsed, 'tag') ?? parsed.positional.shift();
  if (!tag || parsed.positional.length > 0) throw usageError('template apply requires TAG.');
  return { op: 'template', action: 'apply', tag: await targetRef(tag, context.read) };
}

function buildDailyEnsure(parsed: ParsedOptions): Change {
  allow(parsed, ['date', 'bind']);
  const date = option(parsed, 'date') ?? parsed.positional.shift();
  if (!date || parsed.positional.length > 0) throw usageError('daily ensure requires YYYY-MM-DD.');
  return { op: 'ensure', resource: 'date', date, bind: option(parsed, 'bind') ?? 'date' };
}

async function buildCapture(parsed: ParsedOptions, context: PorcelainBuildContext): Promise<readonly Change[]> {
  allow(parsed, ['parent', 'date', 'title', 'description', 'metadata', 'tree', 'bind']);
  const parent = option(parsed, 'parent');
  const date = option(parsed, 'date');
  const title = option(parsed, 'title') ?? parsed.positional.shift();
  if ((!parent && !date) || (parent && date) || !title || parsed.positional.length > 0) {
    throw usageError('capture create requires exactly one of --parent or --date, plus --title.');
  }
  const metadataSource = option(parsed, 'metadata');
  if (!metadataSource) throw usageError('capture create requires capture provenance through --metadata JSON|FILE.');
  const children = option(parsed, 'tree')
    ? ((value) => Array.isArray(value) ? value : [value])(parseJson(await context.read(option(parsed, 'tree')!), '--tree')) as NodeDraft[]
    : [];
  return captureChanges({
    ...(parent ? { parent: await targetRef(parent, context.read) } : {}),
    ...(date ? { date } : {}),
    title,
    ...(option(parsed, 'description') ? { description: option(parsed, 'description') } : {}),
    provenance: parseJson(await context.read(metadataSource), '--metadata'),
    children,
    bind: option(parsed, 'bind') ?? 'capture',
  });
}

async function buildLifecycle(command: string, parsed: ParsedOptions, context: PorcelainBuildContext): Promise<Change> {
  allow(parsed, ['target']);
  const target = option(parsed, 'target') ?? parsed.positional.shift();
  if (!target || parsed.positional.length > 0) throw usageError(`${command} requires TARGET.`);
  return {
    op: 'lifecycle',
    action: command as 'trash' | 'restore' | 'purge',
    targets: await targetRef(target, context.read),
    ...(command === 'purge' && flag(parsed, 'contents') ? { contents: true } : {}),
  };
}

async function targetRef(token: string, read: StructuredReader): Promise<TargetRef> {
  if (token.startsWith('@') || /^[A-Za-z][A-Za-z0-9_-]*:/.test(token)) {
    return { target: { selector: parseSelectorToken(token), cardinality: 'one' } };
  }
  const value = parseJson(await read(token), 'TargetSpec');
  if (isRecord(value) && ('binding' in value || 'target' in value)) return value as TargetRef;
  if (isRecord(value) && isRecord(value.selector)) return { target: value as unknown as TargetSpec };
  return { target: { selector: value as Selector, cardinality: 'one' } };
}

function selectorFromExactTarget(reference: TargetRef): Selector {
  if ('binding' in reference || reference.target.cardinality !== 'one') {
    throw usageError('This porcelain command requires one exact target, not a binding or multi-target Selector.');
  }
  return reference.target.selector;
}

interface ParsedOptions {
  readonly options: Map<string, string | true>;
  readonly consumed: Set<string>;
  readonly allowed: Set<string>;
  readonly positional: string[];
}

function parseOptions(command: string, args: readonly string[]): ParsedOptions {
  const contract = porcelainContract(command);
  if (!contract) throw usageError(`Porcelain contract is not registered: ${command}`);
  const commandOptions = new Map(contract.options.map((entry) => [entry.name, entry]));
  const allOptions = new Map(porcelainHelpOptions(contract).map((entry) => [entry.name, entry]));
  const options = new Map<string, string | true>();
  const positional: string[] = [];
  const split = splitOptionTerminator(args);
  for (let index = 0; index < split.options.length; index += 1) {
    const arg = split.options[index];
    if (!arg?.startsWith('--')) {
      positional.push(arg ?? '');
      continue;
    }
    const name = arg.slice(2);
    const metadata = allOptions.get(name);
    if (!metadata) throw usageError(`Unknown porcelain option: --${name}`);
    if (options.has(name)) throw usageError(`Option may be specified only once: ${arg}`);
    if (COMMON_BOOLEAN_OPTIONS.has(name) || !('value' in metadata)) options.set(name, true);
    else {
      const value = split.options[++index];
      if (value === undefined || value.startsWith('--')) throw usageError(`${arg} requires a value.`);
      options.set(name, value);
    }
  }
  positional.push(...split.literals);
  return { options, consumed: new Set(), allowed: new Set(commandOptions.keys()), positional };
}

function allow(parsed: ParsedOptions, names: readonly string[]): void {
  for (const name of names) parsed.allowed.add(name);
}

function option(parsed: ParsedOptions, name: string): string | undefined {
  const value = parsed.options.get(name);
  if (value === undefined) return undefined;
  parsed.consumed.add(name);
  return value === true ? undefined : value;
}

function requiredOption(parsed: ParsedOptions, name: string): string {
  const value = option(parsed, name);
  if (value === undefined) throw usageError(`--${name} is required.`);
  return value;
}

function has(parsed: ParsedOptions, name: string): boolean {
  if (!parsed.options.has(name)) return false;
  parsed.consumed.add(name);
  return true;
}

function flag(parsed: ParsedOptions, name: string): boolean {
  if (parsed.options.get(name) !== true) return false;
  parsed.consumed.add(name);
  return true;
}

function assertOnlyCommonOptionsConsumed(parsed: ParsedOptions): void {
  const common = new Set(['input', 'idempotency-key', 'preview', 'expect-diff', 'yes']);
  for (const name of parsed.options.keys()) {
    if (!parsed.consumed.has(name) && !parsed.allowed.has(name) && !common.has(name)) {
      throw usageError(`Unknown porcelain option: --${name}`);
    }
    if (!parsed.consumed.has(name) && parsed.allowed.has(name)) {
      throw usageError(`Option was not applicable in this command form: --${name}`);
    }
  }
  if (parsed.positional.length > 0) throw usageError(`Unexpected porcelain argument: ${parsed.positional[0]}`);
}

function takeTargetToken(parsed: ParsedOptions, optionName: string): string {
  const value = option(parsed, optionName) ?? parsed.positional.shift();
  if (!value) throw usageError(`--${optionName} or a positional target is required.`);
  return value;
}

function draft(text: string, patch: Partial<NodeDraft> = {}): NodeDraft {
  return { content: richText(text), children: [], ...patch };
}

function richText(text: string) {
  return { text, marks: [], inlineRefs: [] };
}

function scalar(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function viewMode(value: string | undefined): 'list' | 'table' | 'cards' | 'calendar' {
  if (value === 'outline') return 'list';
  if (value === 'table' || value === 'cards' || value === 'calendar') return value;
  throw usageError('View mode must be outline, table, cards, or calendar.');
}

function sortShorthand(value: string): { field: string; direction: 'asc' | 'desc' } {
  const match = /^(.*):(asc|desc)$/.exec(value);
  if (!match?.[1]) throw usageError('--sort must use FIELD:asc or FIELD:desc.');
  return { field: match[1], direction: match[2] as 'asc' | 'desc' };
}

async function filterSpecification(value: unknown, context: PorcelainBuildContext): Promise<{
  field: PublicViewField;
  operator?: Extract<UpdateInstruction, { kind: 'view'; property: 'filter'; action: 'add' }>['operator'];
  values?: string[];
  valueLogic?: 'all' | 'any';
}> {
  if (!isRecord(value) || typeof value.field !== 'string') throw usageError('--filter requires an object with field.');
  return {
    field: await viewField(value.field, context),
    ...(typeof value.operator === 'string' ? { operator: filterOperator(value.operator) } : {}),
    ...(Array.isArray(value.values) && value.values.every((entry) => typeof entry === 'string') ? { values: value.values } : {}),
    ...(value.valueLogic === 'all' || value.valueLogic === 'any' ? { valueLogic: value.valueLogic } : {}),
  };
}

async function viewField(
  value: string,
  context: PorcelainBuildContext,
): Promise<PublicViewField> {
  if (VIEW_SYSTEM_FIELDS.has(value as never)) {
    return value as PublicViewField;
  }
  return targetRef(value, context.read);
}

const VIEW_SYSTEM_FIELDS = new Set([
  'sys:name', 'sys:createdAt', 'sys:updatedAt', 'sys:done', 'sys:doneAt', 'sys:tags', 'sys:refCount',
] as const);

function filterOperator(value: string): Extract<UpdateInstruction, { kind: 'view'; property: 'filter'; operator: unknown }>['operator'] {
  const operators = new Set(['is', 'is_not', 'contains', 'not_contains', 'is_empty', 'is_not_empty', 'gt', 'lt', 'before', 'after']);
  if (!operators.has(value)) throw usageError(`Unknown filter operator: ${value}`);
  return value as ReturnType<typeof filterOperator>;
}

function boolean(value: string, label: string): boolean {
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw usageError(`${label} must be true or false.`);
}

function number(value: string, label: string): number {
  const result = Number(value);
  if (!Number.isFinite(result)) throw usageError(`${label} requires a number.`);
  return result;
}

function integer(value: string, label: string, minimum: number): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < minimum) throw usageError(`${label} requires an integer >= ${minimum}.`);
  return result;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) throw usageError(`${label} is unavailable.`);
  return value;
}

function parseJson(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw usageError(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function usageError(message: string): OutlineContractError {
  return new OutlineContractError(outlineError('invalid_input', 'usage', message));
}

function schemaUsageError(
  message: string,
  schema: Parameters<typeof outlineSchemaValidationDetails>[0],
  value: unknown,
): OutlineContractError {
  return new OutlineContractError(outlineError(
    'invalid_input',
    'usage',
    message,
    { details: { validation: outlineSchemaValidationDetails(schema, value) } },
  ));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
