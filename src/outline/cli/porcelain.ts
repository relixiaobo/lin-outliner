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
  const action = command.slice('field '.length) as Extract<UpdateInstruction, { kind: 'field' }>['action'];
  const fieldToken = option(parsed, 'field') ?? (action === 'define' ? undefined : parsed.positional.shift());
  const instruction: Extract<UpdateInstruction, { kind: 'field' }> = {
    kind: 'field',
    action,
    ...(fieldToken ? { field: await targetRef(fieldToken, context.read) } : {}),
  };
  if (action === 'define') {
    const name = option(parsed, 'name') ?? parsed.positional.shift();
    if (!name) throw usageError('field define requires a name.');
    instruction.name = name;
    instruction.fieldType = option(parsed, 'field-type') ?? 'plain';
  } else if (action === 'set') {
    const value = option(parsed, 'value') ?? parsed.positional.shift();
    if (value === undefined) throw usageError('field set requires a value.');
    instruction.value = scalar(value);
  } else if (action === 'reuse') {
    const source = option(parsed, 'source-field') ?? parsed.positional.shift();
    if (!source) throw usageError('field reuse requires SOURCE_FIELD and TARGET_FIELD.');
    instruction.sourceField = await targetRef(source, context.read);
  } else if (action === 'select') {
    const selected = option(parsed, 'option') ?? parsed.positional.shift();
    if (!selected) throw usageError('field select requires an option Node ID.');
    instruction.value = selected;
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
    changes: [{ kind: 'definition', definitionType: type, patch: parseJson(await context.read(patch), '--patch') }],
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
  const mapping = viewMapping(command);
  let value: unknown = option(parsed, 'value') ? scalar(option(parsed, 'value')!) : undefined;
  if (value === undefined && parsed.positional.length > 0) value = scalar(parsed.positional.shift()!);
  if (value === undefined) {
    const object: Record<string, unknown> = {};
    if (option(parsed, 'mode')) object.mode = option(parsed, 'mode');
    if (option(parsed, 'visible')) object.visible = boolean(option(parsed, 'visible')!, '--visible');
    if (option(parsed, 'field')) object.field = option(parsed, 'field');
    if (option(parsed, 'direction')) object.direction = option(parsed, 'direction');
    if (option(parsed, 'rule')) object.ruleId = option(parsed, 'rule');
    if (option(parsed, 'operator')) object.operator = option(parsed, 'operator');
    if (option(parsed, 'values')) object.values = scalar(option(parsed, 'values')!);
    if (option(parsed, 'logic')) object.valueLogic = option(parsed, 'logic');
    if (option(parsed, 'display-field')) object.displayFieldId = option(parsed, 'display-field');
    value = object;
  }
  if (parsed.positional.length > 0) throw usageError(`Unexpected ${command} argument: ${parsed.positional[0]}`);
  return {
    op: 'update',
    targets: await targetRef(target, context.read),
    changes: [{ kind: 'view', ...mapping, ...(mapping.action === 'clear' ? {} : { value }) }],
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
      nodes: [draft(title, { type: 'search', metadata: { query: parseJson(await context.read(query), '--query') } })],
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
  return {
    op: 'update',
    targets: await targetRef(target, context.read),
    changes: [{
      kind: 'search',
      action: command === 'search refresh' ? 'refresh' : 'set',
      ...(command === 'search set' ? { value: scalar(requiredOption(parsed, 'value')) } : {}),
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

function viewMapping(command: string): Pick<Extract<UpdateInstruction, { kind: 'view' }>, 'property' | 'action'> {
  const map: Record<string, Pick<Extract<UpdateInstruction, { kind: 'view' }>, 'property' | 'action'>> = {
    'view set': { property: 'mode', action: 'set' },
    'view group set': { property: 'group', action: 'set' },
    'view sort add': { property: 'sort', action: 'add' },
    'view sort set': { property: 'sort', action: 'set' },
    'view sort remove': { property: 'sort', action: 'remove' },
    'view sort clear': { property: 'sort', action: 'clear' },
    'view filter add': { property: 'filter', action: 'add' },
    'view filter set': { property: 'filter', action: 'set' },
    'view filter remove': { property: 'filter', action: 'remove' },
    'view filter clear': { property: 'filter', action: 'clear' },
    'view display add': { property: 'display-field', action: 'add' },
    'view display set': { property: 'display-field', action: 'set' },
    'view display remove': { property: 'display-field', action: 'remove' },
  };
  const result = map[command];
  if (!result) throw usageError(`Unknown view command: ${command}`);
  return result;
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
