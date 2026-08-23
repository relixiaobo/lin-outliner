import type {
  Change,
  ChangeSet,
  NodeDraft,
  Selector,
  TargetRef,
  TargetSpec,
  UpdateInstruction,
} from '../contract/schemas';
import { OutlineContractError, outlineError } from '../contract/errors';
import { createChangeSet, parseChangeSetInput, parseSelectorToken, type StructuredReader } from './arguments';

type PublicViewField = Extract<
  UpdateInstruction,
  { kind: 'view'; property: 'sort'; action: 'add' }
>['field'];

export interface PorcelainBuildContext {
  readonly read: StructuredReader;
  readonly lookup: (selector: Selector) => Promise<Record<string, unknown>>;
}

export interface PorcelainRequest {
  readonly changeSet: ChangeSet;
  readonly preview?: boolean;
  readonly expectDiff?: string;
  readonly acknowledgeDestructive?: boolean;
}

const BOOLEAN_OPTIONS = new Set(['preview', 'yes', 'contents']);

export async function buildPorcelainRequest(
  command: string,
  args: readonly string[],
  context: PorcelainBuildContext,
): Promise<PorcelainRequest> {
  const parsed = parseOptions(args);
  const input = option(parsed, 'input');
  const inputFormat = option(parsed, 'input-format') ?? 'json';
  const idempotencyKey = option(parsed, 'idempotency-key');
  const preview = flag(parsed, 'preview');
  const expectDiff = option(parsed, 'expect-diff');
  const yes = flag(parsed, 'yes');
  if (inputFormat !== 'json' && inputFormat !== 'jsonl') throw usageError('--input-format must be json or jsonl.');
  if (preview && expectDiff) throw usageError('--preview cannot be combined with --expect-diff.');
  if (preview && yes) throw usageError('--preview cannot be combined with --yes.');
  if (yes && !expectDiff) throw usageError('--yes requires --expect-diff for porcelain commands.');

  let changeSet: ChangeSet;
  if (input) {
    if (parsed.positional.length > 0) throw usageError(`${command} cannot combine --input with positional arguments.`);
    changeSet = await parseChangeSetInput(await context.read(input), inputFormat);
  } else {
    changeSet = createChangeSet(await buildChanges(command, parsed, context), idempotencyKey);
  }
  if (idempotencyKey) {
    if (changeSet.idempotencyKey && changeSet.idempotencyKey !== idempotencyKey) {
      throw usageError('--idempotency-key does not match the ChangeSet input.');
    }
    changeSet.idempotencyKey = idempotencyKey;
  }
  assertOnlyCommonOptionsConsumed(parsed);
  return {
    changeSet,
    ...(preview ? { preview: true } : {}),
    ...(expectDiff ? { expectDiff } : {}),
    ...(yes ? { acknowledgeDestructive: true } : {}),
  };
}

async function buildChanges(
  command: string,
  parsed: ParsedOptions,
  context: PorcelainBuildContext,
): Promise<readonly Change[]> {
  if (command === 'add') return [await buildAdd(parsed, context)];
  if (command === 'set') return [await buildSet(parsed, context)];
  if (['move', 'duplicate', 'indent', 'outdent'].includes(command)) {
    return [await buildMove(command, parsed, context)];
  }
  if (command === 'merge' || command === 'definition merge') return [await buildMerge(parsed, context)];
  if (command === 'done set' || command === 'done cycle') return [await buildDone(command, parsed, context)];
  if (command === 'tag add' || command === 'tag remove') return [await buildTag(command, parsed, context)];
  if (command.startsWith('field ')) return [await buildField(command, parsed, context)];
  if (command === 'definition create') return [buildDefinitionCreate(parsed)];
  if (command === 'definition configure') return [await buildDefinitionConfigure(parsed, context)];
  if (command.startsWith('reference ')) return [await buildReference(command, parsed, context)];
  if (command.startsWith('view ')) return [await buildView(command, parsed, context)];
  if (command.startsWith('search ')) return [await buildSearch(command, parsed, context)];
  if (command === 'template apply') return [await buildTemplate(parsed, context)];
  if (command === 'daily ensure') return [buildDailyEnsure(parsed)];
  if (command === 'capture add') return [await buildCapture(parsed, context)];
  if (command === 'media add') return [await buildMediaAdd(parsed, context)];
  if (command === 'media set') return [await buildMediaSet(parsed, context)];
  if (command === 'trash' || command === 'restore' || command === 'purge') {
    return [await buildLifecycle(command, parsed, context)];
  }
  throw usageError(`Porcelain builder is not implemented for command: ${command}`);
}

async function buildAdd(parsed: ParsedOptions, context: PorcelainBuildContext): Promise<Change> {
  allow(parsed, ['parent', 'tree', 'index', 'bind', 'type', 'description']);
  const parentToken = takeTargetToken(parsed, 'parent');
  const parents = await targetRef(parentToken, context.read);
  const tree = option(parsed, 'tree');
  let nodes: NodeDraft[];
  if (tree) {
    const value = parseJson(await context.read(tree), '--tree');
    nodes = (Array.isArray(value) ? value : [value]) as NodeDraft[];
  } else {
    const text = parsed.positional.splice(0).join(' ');
    if (!text) throw usageError('add requires text or --tree FILE|-.');
    nodes = [draft(text, {
      ...(option(parsed, 'type') ? { type: option(parsed, 'type') as NodeDraft['type'] } : {}),
      ...(option(parsed, 'description') ? { description: option(parsed, 'description') } : {}),
    })];
  }
  return {
    op: 'create',
    parents,
    nodes,
    ...(option(parsed, 'index') ? { index: integer(option(parsed, 'index')!, '--index', 0) } : {}),
    ...(option(parsed, 'bind') ? { bind: option(parsed, 'bind')! } : {}),
  };
}

async function buildSet(parsed: ParsedOptions, context: PorcelainBuildContext): Promise<Change> {
  allow(parsed, [
    'target', 'text', 'content', 'description', 'code', 'checkbox', 'icon', 'icon-kind',
    'banner', 'image', 'media-url', 'width', 'height',
  ]);
  const targets = await targetRef(takeTargetToken(parsed, 'target'), context.read);
  const changes: UpdateInstruction[] = [];
  const content = option(parsed, 'content') ?? option(parsed, 'text');
  if (content !== undefined) changes.push({ kind: 'content', value: richText(content) });
  if (has(parsed, 'description')) {
    const value = option(parsed, 'description')!;
    changes.push({ kind: 'description', value: value === 'null' ? null : value });
  }
  if (has(parsed, 'code')) changes.push({ kind: 'code', language: option(parsed, 'code')! });
  if (has(parsed, 'checkbox')) changes.push({ kind: 'checkbox', visible: boolean(option(parsed, 'checkbox')!, '--checkbox') });
  if (has(parsed, 'icon')) changes.push({
    kind: 'icon',
    value: option(parsed, 'icon') === 'null' ? null : option(parsed, 'icon')!,
    ...(option(parsed, 'icon-kind') ? { iconKind: option(parsed, 'icon-kind') } : {}),
  });
  if (has(parsed, 'banner')) changes.push({ kind: 'banner', assetLeaseId: nullable(option(parsed, 'banner')!) });
  if (has(parsed, 'image') || has(parsed, 'media-url')) changes.push({
    kind: 'image',
    ...(option(parsed, 'image') ? { assetLeaseId: option(parsed, 'image') } : {}),
    ...(option(parsed, 'media-url') ? { mediaUrl: option(parsed, 'media-url') } : {}),
    ...(option(parsed, 'width') ? { width: number(option(parsed, 'width')!, '--width') } : {}),
    ...(option(parsed, 'height') ? { height: number(option(parsed, 'height')!, '--height') } : {}),
  });
  if (changes.length === 0) throw usageError('set requires at least one property option.');
  return { op: 'update', targets, changes };
}

async function buildMove(
  command: string,
  parsed: ParsedOptions,
  context: PorcelainBuildContext,
): Promise<Change> {
  allow(parsed, ['target', 'destination', 'index', 'bind']);
  const targetToken = takeTargetToken(parsed, 'target');
  const targets = await targetRef(targetToken, context.read);
  let destinationToken = option(parsed, 'destination') ?? parsed.positional.shift();
  let index = option(parsed, 'index') ? integer(option(parsed, 'index')!, '--index', 0) : undefined;
  if ((command === 'indent' || command === 'outdent') && !destinationToken) {
    const selector = selectorFromExactTarget(targets);
    const node = await context.lookup(selector);
    const parentId = requiredString(node.parentId, `${command} target parent`);
    const parent = await context.lookup({ by: 'id', id: parentId });
    if (command === 'indent') {
      const siblings = stringArray(parent.children);
      const position = siblings.indexOf(requiredString(node.id, 'target ID'));
      if (position <= 0) throw usageError('indent target has no previous sibling.');
      destinationToken = siblings[position - 1]!;
      index = undefined;
    } else {
      const grandparentId = requiredString(parent.parentId, 'outdent grandparent');
      const grandparent = await context.lookup({ by: 'id', id: grandparentId });
      const parentPosition = stringArray(grandparent.children).indexOf(parentId);
      destinationToken = grandparentId;
      index = Math.max(0, parentPosition + 1);
    }
  }
  if (!destinationToken) throw usageError(`${command} requires a destination.`);
  const destination = await targetRef(destinationToken, context.read);
  if (parsed.positional.length > 0) throw usageError(`Unexpected ${command} argument: ${parsed.positional[0]}`);
  if (command === 'duplicate') {
    return {
      op: 'duplicate', targets, destination,
      ...(index !== undefined ? { index } : {}),
      ...(option(parsed, 'bind') ? { bind: option(parsed, 'bind')! } : {}),
    };
  }
  return { op: 'move', targets, destination, ...(index !== undefined ? { index } : {}) };
}

async function buildMerge(parsed: ParsedOptions, context: PorcelainBuildContext): Promise<Change> {
  allow(parsed, ['source', 'target']);
  const source = option(parsed, 'source') ?? parsed.positional.shift();
  const target = option(parsed, 'target') ?? parsed.positional.shift();
  if (!source || !target || parsed.positional.length > 0) throw usageError('merge requires SOURCE and TARGET.');
  return { op: 'merge', sources: await targetRef(source, context.read), target: await targetRef(target, context.read) };
}

async function buildDone(command: string, parsed: ParsedOptions, context: PorcelainBuildContext): Promise<Change> {
  allow(parsed, ['target', 'value']);
  const targets = await targetRef(takeTargetToken(parsed, 'target'), context.read);
  let value: boolean;
  if (command === 'done set') {
    const raw = option(parsed, 'value') ?? parsed.positional.shift();
    if (!raw) throw usageError('done set requires true or false.');
    value = boolean(raw, 'done value');
  } else {
    const node = await context.lookup(selectorFromExactTarget(targets));
    value = !(node.done === true || (typeof node.completedAt === 'number' && node.completedAt > 0));
  }
  if (parsed.positional.length > 0) throw usageError(`Unexpected ${command} argument: ${parsed.positional[0]}`);
  return { op: 'update', targets, changes: [{ kind: 'done', value }] };
}

async function buildTag(command: string, parsed: ParsedOptions, context: PorcelainBuildContext): Promise<Change> {
  allow(parsed, ['target', 'tag']);
  const target = option(parsed, 'target') ?? parsed.positional.shift();
  const tag = option(parsed, 'tag') ?? parsed.positional.shift();
  if (!target || !tag || parsed.positional.length > 0) throw usageError(`${command} requires TARGET and TAG.`);
  return {
    op: 'update',
    targets: await targetRef(target, context.read),
    changes: [{
      kind: 'tag',
      action: command === 'tag add' ? 'add' : 'remove',
      tag: await targetRef(tag, context.read),
    }],
  };
}

async function buildField(command: string, parsed: ParsedOptions, context: PorcelainBuildContext): Promise<Change> {
  allow(parsed, ['target', 'field', 'source-field', 'name', 'field-type', 'value', 'option']);
  const target = option(parsed, 'target') ?? parsed.positional.shift();
  if (!target) throw usageError(`${command} requires a target.`);
  const action = command.slice('field '.length);
  let instruction: Extract<UpdateInstruction, { kind: 'field' }>;
  if (action === 'define') {
    const name = option(parsed, 'name') ?? parsed.positional.shift();
    if (!name) throw usageError('field define requires a name.');
    instruction = {
      kind: 'field',
      action: 'define',
      name,
      fieldType: fieldType(option(parsed, 'field-type') ?? 'plain'),
    };
  } else if (action === 'set') {
    const field = option(parsed, 'field') ?? parsed.positional.shift();
    const value = option(parsed, 'value') ?? parsed.positional.shift();
    if (!field || value === undefined) throw usageError('field set requires FIELD and VALUE.');
    instruction = {
      kind: 'field',
      action: 'set',
      field: await targetRef(field, context.read),
      value: scalarValue(value, 'field value'),
    };
  } else if (action === 'reuse') {
    const field = option(parsed, 'field') ?? parsed.positional.shift();
    const source = option(parsed, 'source-field') ?? parsed.positional.shift();
    if (!field || !source) throw usageError('field reuse requires SOURCE_FIELD and TARGET_FIELD.');
    instruction = {
      kind: 'field',
      action: 'reuse',
      field: await targetRef(field, context.read),
      sourceField: await targetRef(source, context.read),
    };
  } else if (action === 'select') {
    const field = option(parsed, 'field') ?? parsed.positional.shift();
    const selected = option(parsed, 'option') ?? parsed.positional.shift();
    if (!field || !selected) throw usageError('field select requires FIELD and OPTION.');
    instruction = {
      kind: 'field',
      action: 'select',
      field: await targetRef(field, context.read),
      option: await targetRef(selected, context.read),
    };
  } else if (action === 'clear' || action === 'remove') {
    const field = option(parsed, 'field') ?? parsed.positional.shift();
    if (!field) throw usageError(`${command} requires FIELD.`);
    instruction = {
      kind: 'field',
      action,
      field: await targetRef(field, context.read),
    };
  } else {
    throw usageError(`Unknown field command: ${command}`);
  }
  if (parsed.positional.length > 0) throw usageError(`Unexpected ${command} argument: ${parsed.positional[0]}`);
  return { op: 'update', targets: await targetRef(target, context.read), changes: [instruction] };
}

function buildDefinitionCreate(parsed: ParsedOptions): Change {
  allow(parsed, ['type', 'name', 'field-type', 'bind']);
  const type = option(parsed, 'type') ?? parsed.positional.shift();
  const name = option(parsed, 'name') ?? parsed.positional.shift();
  if ((type !== 'tag' && type !== 'field') || !name || parsed.positional.length > 0) {
    throw usageError('definition create requires TYPE(tag|field) and NAME.');
  }
  return {
    op: 'ensure',
    resource: 'definition',
    definitionType: type,
    name,
    ...(type === 'field' ? { fieldType: option(parsed, 'field-type') ?? 'plain' } : {}),
    bind: option(parsed, 'bind') ?? 'definition',
  };
}

async function buildDefinitionConfigure(parsed: ParsedOptions, context: PorcelainBuildContext): Promise<Change> {
  allow(parsed, ['target', 'type', 'patch']);
  const target = option(parsed, 'target') ?? parsed.positional.shift();
  const type = option(parsed, 'type') ?? parsed.positional.shift();
  const patch = option(parsed, 'patch');
  if (!target || (type !== 'tag' && type !== 'field') || !patch || parsed.positional.length > 0) {
    throw usageError('definition configure requires TARGET, TYPE(tag|field), and --patch JSON|FILE.');
  }
  return {
    op: 'update',
    targets: await targetRef(target, context.read),
    changes: [{
      kind: 'definition',
      definitionType: type,
      patch: parseJson(await context.read(patch), '--patch'),
    } as Extract<UpdateInstruction, { kind: 'definition' }>],
  };
}

async function buildReference(command: string, parsed: ParsedOptions, context: PorcelainBuildContext): Promise<Change> {
  allow(parsed, ['target', 'reference']);
  const owner = option(parsed, 'target') ?? parsed.positional.shift();
  const reference = option(parsed, 'reference') ?? parsed.positional.shift() ?? owner;
  if (!owner || !reference || parsed.positional.length > 0) throw usageError(`${command} requires a target.`);
  const actions = { 'reference add': 'add', 'reference set': 'retarget', 'reference inline': 'inline', 'reference restore': 'restore' } as const;
  return {
    op: 'update',
    targets: await targetRef(owner, context.read),
    changes: [{ kind: 'reference', action: actions[command as keyof typeof actions], target: await targetRef(reference, context.read) }],
  };
}

async function buildView(command: string, parsed: ParsedOptions, context: PorcelainBuildContext): Promise<Change> {
  allow(parsed, [
    'target', 'value', 'mode', 'visible', 'field', 'direction', 'rule', 'operator',
    'values', 'logic', 'display-field',
  ]);
  const target = option(parsed, 'target') ?? parsed.positional.shift();
  if (!target) throw usageError(`${command} requires a target.`);
  const value = option(parsed, 'value') ?? parsed.positional.shift();
  const fieldToken = option(parsed, 'field');
  const ruleId = option(parsed, 'rule');
  const displayFieldId = option(parsed, 'display-field');
  let instruction: Extract<UpdateInstruction, { kind: 'view' }>;
  if (command === 'view set') {
    instruction = { kind: 'view', property: 'mode', action: 'set', mode: viewMode(option(parsed, 'mode') ?? value) };
  } else if (command === 'view group set') {
    const field = fieldToken ?? value;
    instruction = {
      kind: 'view',
      property: 'group',
      action: 'set',
      field: field === undefined || field === 'null' ? null : await viewField(field, context),
    };
  } else if (command === 'view sort add' || command === 'view sort set') {
    if (!fieldToken) throw usageError(`${command} requires --field.`);
    const base = {
      kind: 'view' as const,
      property: 'sort' as const,
      field: await viewField(fieldToken, context),
      direction: sortDirection(option(parsed, 'direction') ?? 'asc'),
    };
    if (command === 'view sort set') {
      if (!ruleId) throw usageError('view sort set requires --rule.');
      instruction = { ...base, action: 'set', ruleId };
    } else instruction = { ...base, action: 'add' };
  } else if (command === 'view sort remove') {
    if (!ruleId) throw usageError('view sort remove requires --rule.');
    instruction = { kind: 'view', property: 'sort', action: 'remove', ruleId };
  } else if (command === 'view sort clear') {
    instruction = { kind: 'view', property: 'sort', action: 'clear' };
  } else if (command === 'view filter add') {
    if (!fieldToken) throw usageError('view filter add requires --field.');
    instruction = {
      kind: 'view',
      property: 'filter',
      action: 'add',
      field: await viewField(fieldToken, context),
      operator: filterOperator(option(parsed, 'operator') ?? 'contains'),
      values: option(parsed, 'values') ? stringArray(scalar(option(parsed, 'values')!)) : [],
      valueLogic: filterLogic(option(parsed, 'logic') ?? 'any'),
    };
  } else if (command === 'view filter set') {
    if (!ruleId) throw usageError('view filter set requires --rule.');
    instruction = {
      kind: 'view',
      property: 'filter',
      action: 'set',
      ruleId,
      ...(fieldToken ? { field: await viewField(fieldToken, context) } : {}),
      ...(option(parsed, 'operator') ? { operator: filterOperator(option(parsed, 'operator')!) } : {}),
      ...(option(parsed, 'values') ? { values: stringArray(scalar(option(parsed, 'values')!)) } : {}),
      ...(option(parsed, 'logic') ? { valueLogic: filterLogic(option(parsed, 'logic')!) } : {}),
    };
  } else if (command === 'view filter remove') {
    if (!ruleId) throw usageError('view filter remove requires --rule.');
    instruction = { kind: 'view', property: 'filter', action: 'remove', ruleId };
  } else if (command === 'view filter clear') {
    instruction = { kind: 'view', property: 'filter', action: 'clear' };
  } else if (command === 'view display add') {
    if (!fieldToken) throw usageError('view display add requires --field.');
    instruction = { kind: 'view', property: 'display-field', action: 'add', field: await viewField(fieldToken, context) };
  } else if (command === 'view display set') {
    if (!displayFieldId) throw usageError('view display set requires --display-field.');
    const patch = value === undefined ? {} : scalar(value);
    if (!isRecord(patch)) throw usageError('view display set value must be an object.');
    instruction = {
      kind: 'view',
      property: 'display-field',
      action: 'set',
      displayFieldId,
      ...(typeof patch.field === 'string' ? { field: await viewField(patch.field, context) } : {}),
      ...(typeof patch.visible === 'boolean' ? { visible: patch.visible } : {}),
      ...(typeof patch.width === 'number' ? { width: patch.width } : {}),
      ...(typeof patch.order === 'number' ? { order: patch.order } : {}),
      ...(typeof patch.label === 'string' || patch.label === null ? { label: patch.label } : {}),
      ...(typeof patch.placement === 'string' ? { placement: displayPlacement(patch.placement) } : {}),
      ...(patch.move === 'left' || patch.move === 'right' ? { move: patch.move } : {}),
    };
  } else if (command === 'view display remove') {
    if (!displayFieldId) throw usageError('view display remove requires --display-field.');
    instruction = { kind: 'view', property: 'display-field', action: 'remove', displayFieldId };
  } else {
    throw usageError(`Unsupported typed view command: ${command}`);
  }
  if (parsed.positional.length > 0) throw usageError(`Unexpected ${command} argument: ${parsed.positional[0]}`);
  return {
    op: 'update',
    targets: await targetRef(target, context.read),
    changes: [instruction],
  };
}

async function buildSearch(command: string, parsed: ParsedOptions, context: PorcelainBuildContext): Promise<Change> {
  if (command === 'search create') {
    allow(parsed, ['parent', 'title', 'query', 'bind']);
    const parent = option(parsed, 'parent') ?? parsed.positional.shift();
    const title = option(parsed, 'title') ?? parsed.positional.shift();
    const query = option(parsed, 'query');
    if (!parent || !title || !query || parsed.positional.length > 0) {
      throw usageError('search create requires PARENT, TITLE, and --query JSON|FILE.');
    }
    return {
      op: 'create',
      parents: await targetRef(parent, context.read),
      nodes: [draft(title, {
        type: 'search',
        metadata: {
          query: parseJson(await context.read(query), '--query') as NonNullable<
            NonNullable<NodeDraft['metadata']>['query']
          >,
        },
      })],
      ...(option(parsed, 'bind') ? { bind: option(parsed, 'bind')! } : {}),
    };
  }
  if (command === 'search ensure-tag') {
    allow(parsed, ['tag', 'bind']);
    const tag = option(parsed, 'tag') ?? parsed.positional.shift();
    if (!tag || parsed.positional.length > 0) throw usageError('search ensure-tag requires TAG.');
    return { op: 'ensure', resource: 'tag-search', tag: await targetRef(tag, context.read), bind: option(parsed, 'bind') ?? 'search' };
  }
  allow(parsed, ['target', 'value']);
  const target = option(parsed, 'target') ?? parsed.positional.shift();
  if (!target || parsed.positional.length > 0) throw usageError(`${command} requires TARGET.`);
  if (command === 'search refresh') {
    return {
      op: 'update',
      targets: await targetRef(target, context.read),
      changes: [{ kind: 'search', action: 'refresh' }],
    };
  }
  const config = scalar(requiredOption(parsed, 'value'));
  if (!isRecord(config) || typeof config.title !== 'string' || !isRecord(config.query)) {
    throw usageError('search set --value requires {"title": string, "query": QueryExpression}.');
  }
  return {
    op: 'update',
    targets: await targetRef(target, context.read),
    changes: [{
      kind: 'search',
      action: 'set',
      title: config.title,
      query: config.query as Extract<UpdateInstruction, { kind: 'search'; action: 'set' }>['query'],
    }],
  };
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

async function buildCapture(parsed: ParsedOptions, context: PorcelainBuildContext): Promise<Change> {
  allow(parsed, ['parent', 'title', 'description', 'metadata', 'tree', 'bind']);
  const parent = option(parsed, 'parent') ?? parsed.positional.shift();
  const title = option(parsed, 'title') ?? parsed.positional.shift();
  if (!parent || !title) throw usageError('capture add requires PARENT and TITLE.');
  const children = option(parsed, 'tree')
    ? ((value) => Array.isArray(value) ? value : [value])(parseJson(await context.read(option(parsed, 'tree')!), '--tree')) as NodeDraft[]
    : [];
  return {
    op: 'create',
    parents: await targetRef(parent, context.read),
    nodes: [draft(title, {
      ...(option(parsed, 'description') ? { description: option(parsed, 'description') } : {}),
      ...(option(parsed, 'metadata') ? { metadata: { capture: parseJson(await context.read(option(parsed, 'metadata')!), '--metadata') } } : {}),
      children,
    })],
    ...(option(parsed, 'bind') ? { bind: option(parsed, 'bind')! } : {}),
  };
}

async function buildMediaAdd(parsed: ParsedOptions, context: PorcelainBuildContext): Promise<Change> {
  allow(parsed, ['parent', 'type', 'name', 'lease', 'url', 'metadata', 'bind']);
  const parent = option(parsed, 'parent') ?? parsed.positional.shift();
  const type = option(parsed, 'type') ?? parsed.positional.shift();
  const name = option(parsed, 'name') ?? parsed.positional.shift() ?? '';
  if (!parent || (type !== 'image' && type !== 'attachment')) throw usageError('media add requires PARENT and TYPE(image|attachment).');
  return {
    op: 'create',
    parents: await targetRef(parent, context.read),
    nodes: [draft(name, {
      type,
      ...(option(parsed, 'lease') ? { assetLeaseId: option(parsed, 'lease') } : {}),
      ...(option(parsed, 'url') ? { mediaUrl: option(parsed, 'url') } : {}),
      ...(option(parsed, 'metadata') ? { metadata: parseJson(await context.read(option(parsed, 'metadata')!), '--metadata') as Record<string, unknown> } : {}),
    })],
    ...(option(parsed, 'bind') ? { bind: option(parsed, 'bind')! } : {}),
  };
}

async function buildMediaSet(parsed: ParsedOptions, context: PorcelainBuildContext): Promise<Change> {
  allow(parsed, ['target', 'lease', 'url', 'width', 'height']);
  const target = option(parsed, 'target') ?? parsed.positional.shift();
  if (!target || parsed.positional.length > 0) throw usageError('media set requires TARGET.');
  return {
    op: 'update',
    targets: await targetRef(target, context.read),
    changes: [{
      kind: 'image',
      ...(option(parsed, 'lease') ? { assetLeaseId: option(parsed, 'lease') } : {}),
      ...(option(parsed, 'url') ? { mediaUrl: option(parsed, 'url') } : {}),
      ...(option(parsed, 'width') ? { width: number(option(parsed, 'width')!, '--width') } : {}),
      ...(option(parsed, 'height') ? { height: number(option(parsed, 'height')!, '--height') } : {}),
    }],
  };
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
  if (token.startsWith('@') || token.startsWith('node:')) {
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

function parseOptions(args: readonly string[]): ParsedOptions {
  const options = new Map<string, string | true>();
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg?.startsWith('--')) {
      positional.push(arg ?? '');
      continue;
    }
    const name = arg.slice(2);
    if (options.has(name)) throw usageError(`Option may be specified only once: ${arg}`);
    if (BOOLEAN_OPTIONS.has(name)) options.set(name, true);
    else {
      const value = args[++index];
      if (value === undefined || value.startsWith('--')) throw usageError(`${arg} requires a value.`);
      options.set(name, value);
    }
  }
  return { options, consumed: new Set(), allowed: new Set(), positional };
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
  const common = new Set(['input', 'input-format', 'idempotency-key', 'preview', 'expect-diff', 'yes']);
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

function scalarValue(value: string, label: string): string | number | boolean | null {
  const parsed = scalar(value);
  if (parsed === null || ['string', 'number', 'boolean'].includes(typeof parsed)) {
    return parsed as string | number | boolean | null;
  }
  throw usageError(`${label} must be a string, number, boolean, or null.`);
}

const FIELD_TYPES = new Set([
  'plain', 'options', 'options_from_supertag', 'date', 'number', 'url', 'email', 'checkbox',
] as const);

function fieldType(value: string): 'plain' | 'options' | 'options_from_supertag' | 'date' | 'number' | 'url' | 'email' | 'checkbox' {
  if (!FIELD_TYPES.has(value as never)) throw usageError(`Unknown field type: ${value}`);
  return value as ReturnType<typeof fieldType>;
}

function viewMode(value: string | undefined): 'list' | 'table' | 'cards' | 'calendar' {
  if (value === 'list' || value === 'table' || value === 'cards' || value === 'calendar') return value;
  throw usageError('view set requires list, table, cards, or calendar.');
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

function sortDirection(value: string): 'asc' | 'desc' {
  if (value === 'asc' || value === 'desc') return value;
  throw usageError('sort direction must be asc or desc.');
}

function filterOperator(value: string): Extract<UpdateInstruction, { kind: 'view'; property: 'filter'; operator: unknown }>['operator'] {
  const operators = new Set(['is', 'is_not', 'contains', 'not_contains', 'is_empty', 'is_not_empty', 'gt', 'lt', 'before', 'after']);
  if (!operators.has(value)) throw usageError(`Unknown filter operator: ${value}`);
  return value as ReturnType<typeof filterOperator>;
}

function filterLogic(value: string): 'all' | 'any' {
  if (value === 'all' || value === 'any') return value;
  throw usageError('filter logic must be all or any.');
}

function displayPlacement(value: string): 'title' | 'body' | 'footer' | 'hidden' {
  if (value === 'title' || value === 'body' || value === 'footer' || value === 'hidden') return value;
  throw usageError(`Unknown display placement: ${value}`);
}

function nullable(value: string): string | null {
  return value === 'null' ? null : value;
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

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
