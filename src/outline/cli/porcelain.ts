import { Value } from 'typebox/value';
import type {
  AssetLease,
  Change,
  ChangeSet,
  NodeDraft,
  Selector,
  TargetRef,
  TargetSpec,
  UpdateInstruction,
} from '../contract/schemas';
import { OutlineContractError, outlineError } from '../contract/errors';
import { porcelainContract, porcelainHelpOptions } from '../contract/porcelain';
import { createChangeSet, parseSelectorToken, type StructuredReader } from './arguments';

type PublicViewField = Extract<
  UpdateInstruction,
  { kind: 'view'; property: 'sort'; action: 'add' }
>['field'];

export interface PorcelainBuildContext {
  readonly read: StructuredReader;
  readonly lookup: (selector: Selector) => Promise<Record<string, unknown>>;
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
  const idempotencyKey = option(parsed, 'idempotency-key');
  const preview = flag(parsed, 'preview');
  const expectDiff = option(parsed, 'expect-diff');
  const yes = flag(parsed, 'yes');
  if (preview && expectDiff) throw usageError('--preview cannot be combined with --expect-diff.');
  if (preview && yes) throw usageError('--preview cannot be combined with --yes.');
  if (yes && !expectDiff) throw usageError('--yes requires --expect-diff for porcelain commands.');

  let changeSet: ChangeSet;
  if (input) {
    if (parsed.positional.length > 0) throw usageError(`${command} cannot combine --input with positional arguments.`);
    const payload = parseJson(await context.read(input), `${command} input`);
    const contract = porcelainContract(command)!;
    if (!Value.Check(contract.inputSchema, payload)) {
      throw usageError(`Input does not match the public schema for command: ${command}`);
    }
    changeSet = createChangeSet(await buildChangesFromInput(command, payload as Record<string, unknown>, context), idempotencyKey);
  } else {
    changeSet = createChangeSet(await buildChanges(command, parsed, context), idempotencyKey);
  }
  if (idempotencyKey) {
    if (changeSet.idempotencyKey && changeSet.idempotencyKey !== idempotencyKey) {
      throw usageError('--idempotency-key does not match the ChangeSet input.');
    }
    changeSet.idempotencyKey = idempotencyKey;
  }
  attachDefaultReturn(command, changeSet);
  assertOnlyCommonOptionsConsumed(parsed);
  return {
    changeSet,
    ...(preview ? { preview: true } : {}),
    ...(expectDiff ? { expectDiff } : {}),
    ...(yes ? { acknowledgeDestructive: true } : {}),
  };
}

async function buildChangesFromInput(
  command: string,
  input: Record<string, unknown>,
  context: PorcelainBuildContext,
): Promise<readonly Change[]> {
  if (command === 'add') {
    return [{
      op: 'create',
      parents: input.parent as TargetRef,
      nodes: input.nodes as NodeDraft[],
      ...(input.index !== undefined ? { index: input.index as number | null } : {}),
      bind: String(input.bind ?? 'created'),
    }];
  }
  if (command === 'set') return [setChangeFromInput(input)];
  if (command === 'move' || command === 'duplicate') {
    if (command === 'duplicate') return [{
      op: 'duplicate',
      targets: input.target as TargetRef,
      destination: input.destination as TargetRef,
      ...(input.index !== undefined ? { index: input.index as number | null } : {}),
      bind: String(input.bind ?? 'copies'),
    }];
    return [{
      op: 'move',
      targets: input.target as TargetRef,
      destination: input.destination as TargetRef,
      ...(input.index !== undefined ? { index: input.index as number | null } : {}),
    }];
  }
  if (command === 'indent' || command === 'outdent') {
    return [await buildRelativeMove(command, input.target as TargetRef, context)];
  }
  if (command === 'merge' || command === 'definition merge') {
    return [{ op: 'merge', sources: input.source as TargetRef, target: input.target as TargetRef }];
  }
  if (command === 'done set' || command === 'done cycle') {
    const targets = input.target as TargetRef;
    const value = command === 'done set'
      ? input.value === true
      : !await targetDone(targets, context);
    return [{ op: 'update', targets, changes: [{ kind: 'done', value }] }];
  }
  if (command === 'tag add' || command === 'tag remove') {
    return [{
      op: 'update',
      targets: input.target as TargetRef,
      changes: [{ kind: 'tag', action: command === 'tag add' ? 'add' : 'remove', tag: input.tag as TargetRef }],
    }];
  }
  if (command.startsWith('field ')) return [fieldChangeFromInput(command, input)];
  if (command === 'definition create') return definitionCreateChanges(input);
  if (command === 'definition configure') return [{
    op: 'update',
    targets: input.target as TargetRef,
    changes: [{
      kind: 'definition',
      definitionType: input.definitionType as 'tag' | 'field',
      patch: input.patch,
    } as Extract<UpdateInstruction, { kind: 'definition' }>],
  }];
  if (command.startsWith('reference ')) {
    const actions = { 'reference add': 'add', 'reference set': 'retarget', 'reference inline': 'inline', 'reference restore': 'restore' } as const;
    return [{
      op: 'update',
      targets: input.target as TargetRef,
      changes: [{
        kind: 'reference',
        action: actions[command as keyof typeof actions],
        target: input.reference as TargetRef,
      }],
    }];
  }
  if (command.startsWith('view ')) return [viewChangeFromInput(command, input)];
  if (command === 'search create') return searchCreateChanges(input);
  if (command === 'search ensure-tag') return [{
    op: 'ensure',
    resource: 'tag-search',
    tag: input.tag as TargetRef,
    bind: String(input.bind ?? 'search'),
  }];
  if (command === 'search set') return [searchSetChange(input)];
  if (command === 'search refresh') return [{
    op: 'update', targets: input.target as TargetRef, changes: [{ kind: 'search', action: 'refresh' }],
  }];
  if (command === 'template apply') return [{ op: 'template', action: 'apply', tag: input.tag as TargetRef }];
  if (command === 'daily ensure') return [{
    op: 'ensure', resource: 'date', date: String(input.date), bind: String(input.bind ?? 'date'),
  }];
  if (command === 'capture add') return captureChanges(input);
  if (command === 'media add') return mediaAddChanges(input, context);
  if (command === 'media set') return [{
    op: 'update',
    targets: input.target as TargetRef,
    changes: [{
      kind: 'image',
      ...(input.assetLeaseId ? { assetLeaseId: String(input.assetLeaseId) } : {}),
      ...(input.mediaUrl ? { mediaUrl: String(input.mediaUrl) } : {}),
      ...(input.width !== undefined ? { width: Number(input.width) } : {}),
      ...(input.height !== undefined ? { height: Number(input.height) } : {}),
    }],
  }];
  if (command === 'trash' || command === 'restore' || command === 'purge') return [{
    op: 'lifecycle', action: command, targets: input.target as TargetRef,
  }];
  throw usageError(`Structured input lowering is not implemented for command: ${command}`);
}

function setChangeFromInput(input: Record<string, unknown>): Change {
  const changes: UpdateInstruction[] = [];
  if (input.content) changes.push({ kind: 'content', value: input.content as Extract<UpdateInstruction, { kind: 'content' }>['value'] });
  if (Object.hasOwn(input, 'description')) changes.push({ kind: 'description', value: input.description as string | null });
  if (input.codeLanguage !== undefined) changes.push({ kind: 'code', language: String(input.codeLanguage) });
  if (input.checkbox !== undefined) changes.push({ kind: 'checkbox', visible: input.checkbox === true });
  if (Object.hasOwn(input, 'icon')) changes.push({
    kind: 'icon', value: input.icon as string | null, ...(input.iconKind ? { iconKind: String(input.iconKind) } : {}),
  });
  if (Object.hasOwn(input, 'bannerLeaseId')) changes.push({ kind: 'banner', assetLeaseId: input.bannerLeaseId as string | null });
  if (isRecord(input.image)) changes.push({ kind: 'image', ...input.image });
  if (changes.length === 0) throw usageError('set input requires at least one property.');
  return { op: 'update', targets: input.target as TargetRef, changes };
}

function fieldChangeFromInput(command: string, input: Record<string, unknown>): Change {
  const target = input.target as TargetRef;
  let changes: Extract<UpdateInstruction, { kind: 'field' }>[];
  if (command === 'field define') {
    if (input.field && input.name) throw usageError('field define accepts either name or field, not both.');
    if (!input.field && !input.name) throw usageError('field define requires name or an existing field.');
    if (input.field) {
      changes = [{
        kind: 'field', action: 'attach', field: input.field as TargetRef,
        ...(input.index !== undefined ? { index: input.index as number | null } : {}),
      }];
      if (Object.hasOwn(input, 'value')) changes.push({
        kind: 'field', action: 'set', field: input.field as TargetRef,
        value: input.value as string | number | boolean | null,
      });
    } else {
      changes = [{
        kind: 'field', action: 'define', name: String(input.name),
        fieldType: (input.fieldType ?? 'plain') as Extract<UpdateInstruction, { kind: 'field'; action: 'define' }>['fieldType'],
        ...(input.index !== undefined ? { index: input.index as number | null } : {}),
        ...(Object.hasOwn(input, 'value') ? { value: input.value as string | number | boolean | null } : {}),
      }];
    }
  } else if (command === 'field set') changes = [{
    kind: 'field', action: 'set', field: input.field as TargetRef,
    value: input.value as string | number | boolean | null,
  }];
  else if (command === 'field clear' || command === 'field remove') changes = [{
    kind: 'field', action: command === 'field clear' ? 'clear' : 'remove', field: input.field as TargetRef,
  }];
  else if (command === 'field reuse') changes = [{
    kind: 'field', action: 'reuse', field: input.field as TargetRef, sourceField: input.sourceField as TargetRef,
  }];
  else changes = [{
    kind: 'field', action: 'select', field: input.field as TargetRef, option: input.option as TargetRef,
  }];
  return { op: 'update', targets: target, changes };
}

function definitionCreateChanges(input: Record<string, unknown>): readonly Change[] {
  const definitionType = input.definitionType as 'tag' | 'field';
  const common = {
    op: 'create' as const,
    resource: 'definition' as const,
    name: String(input.name),
    ...(input.id ? { id: String(input.id) } : {}),
    ...(input.config ? { config: input.config } : {}),
    bind: String(input.bind ?? 'definition'),
  };
  return definitionType === 'tag'
    ? [{ ...common, definitionType, ...(input.template ? { template: input.template as NodeDraft[] } : {}) } as Change]
    : [{ ...common, definitionType, ...(input.options ? { options: input.options as NodeDraft[] } : {}) } as Change];
}

function viewChangeFromInput(command: string, input: Record<string, unknown>): Change {
  const targets = input.target as TargetRef;
  let instruction: Extract<UpdateInstruction, { kind: 'view' }>;
  if (command === 'view set') instruction = {
    kind: 'view', property: 'configuration', action: 'set', view: input.view as Extract<UpdateInstruction, { kind: 'view'; property: 'configuration' }>['view'],
  };
  else if (command === 'view group set') instruction = {
    kind: 'view', property: 'group', action: 'set', field: input.field as PublicViewField | null,
  };
  else if (command === 'view sort add') instruction = {
    kind: 'view', property: 'sort', action: 'add',
    field: (input.sort as { field: PublicViewField }).field,
    direction: (input.sort as { direction?: 'asc' | 'desc' }).direction ?? 'asc',
  };
  else if (command === 'view sort set') instruction = {
    kind: 'view', property: 'sort', action: 'set', ruleId: String(input.ruleId),
    ...(input.sort as { field: PublicViewField; direction: 'asc' | 'desc' }),
  };
  else if (command === 'view sort remove') instruction = {
    kind: 'view', property: 'sort', action: 'remove', ruleId: String(input.ruleId),
  };
  else if (command === 'view sort clear') instruction = { kind: 'view', property: 'sort', action: 'clear' };
  else if (command === 'view filter add') instruction = {
    kind: 'view', property: 'filter', action: 'add',
    field: (input.filter as Record<string, unknown>).field as PublicViewField,
    operator: ((input.filter as Record<string, unknown>).operator ?? 'contains') as Extract<UpdateInstruction, { kind: 'view'; property: 'filter'; action: 'add' }>['operator'],
    values: ((input.filter as Record<string, unknown>).values ?? []) as string[],
    valueLogic: ((input.filter as Record<string, unknown>).valueLogic ?? 'any') as 'all' | 'any',
  };
  else if (command === 'view filter set') instruction = {
    kind: 'view', property: 'filter', action: 'set', ruleId: String(input.ruleId), ...(input.patch as Record<string, unknown>),
  } as Extract<UpdateInstruction, { kind: 'view'; property: 'filter'; action: 'set' }>;
  else if (command === 'view filter remove') instruction = {
    kind: 'view', property: 'filter', action: 'remove', ruleId: String(input.ruleId),
  };
  else if (command === 'view filter clear') instruction = { kind: 'view', property: 'filter', action: 'clear' };
  else if (command === 'view display add') instruction = {
    kind: 'view', property: 'display-field', action: 'add', field: (input.display as Record<string, unknown>).field as PublicViewField,
  };
  else if (command === 'view display set') instruction = {
    kind: 'view', property: 'display-field', action: 'set', displayFieldId: String(input.displayFieldId), ...(input.patch as Record<string, unknown>),
  } as Extract<UpdateInstruction, { kind: 'view'; property: 'display-field'; action: 'set' }>;
  else instruction = {
    kind: 'view', property: 'display-field', action: 'remove', displayFieldId: String(input.displayFieldId),
  };
  return { op: 'update', targets, changes: [instruction] };
}

function searchCreateChanges(input: Record<string, unknown>): readonly Change[] {
  const query = queryFromInput(input);
  const bind = String(input.bind ?? 'search');
  const changes: Change[] = [{
    op: 'create',
    parents: (input.parent as TargetRef | undefined) ?? oneAlias('saved-searches'),
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
  if (input.query && input.match) throw usageError('search set accepts --query or --match, not both.');
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
  if (changes.length === 0) throw usageError('search set requires title, query, match, or view.');
  return { op: 'update', targets: input.target as TargetRef, changes };
}

function captureChanges(input: Record<string, unknown>): readonly Change[] {
  if (Boolean(input.parent) === Boolean(input.date)) throw usageError('capture add requires exactly one of parent or date.');
  const bind = String(input.bind ?? 'capture');
  const changes: Change[] = [];
  let parent = input.parent as TargetRef | undefined;
  if (input.date) {
    changes.push({ op: 'ensure', resource: 'date', date: String(input.date), bind: 'captureDate' });
    parent = { binding: 'captureDate' };
  }
  changes.push({
    op: 'create', parents: parent!, bind,
    nodes: [draft(String(input.title), {
      ...(input.description !== undefined ? { description: String(input.description) } : {}),
      metadata: { capture: input.provenance },
      children: (input.children ?? []) as NodeDraft[],
    })],
  });
  return changes;
}

async function mediaAddChanges(input: Record<string, unknown>, context: PorcelainBuildContext): Promise<readonly Change[]> {
  const source = input.source as { kind: 'path'; path: string } | { kind: 'stdin' } | undefined;
  const lease = source ? await context.ingestAsset(source.kind === 'stdin' ? '-' : source.path) : undefined;
  const assetLeaseId = lease?.leaseId ?? (input.assetLeaseId ? String(input.assetLeaseId) : undefined);
  const mediaType = input.mediaType as 'image' | 'attachment';
  if (mediaType === 'attachment' && !assetLeaseId) throw usageError('attachment media requires source or assetLeaseId.');
  if (!assetLeaseId && !input.mediaUrl) throw usageError('media add requires source, assetLeaseId, or mediaUrl.');
  if (mediaType === 'attachment' && input.mediaUrl) throw usageError('attachments cannot use mediaUrl.');
  return [{
    op: 'create', parents: input.parent as TargetRef, bind: String(input.bind ?? 'media'),
    nodes: [draft(String(input.name ?? lease?.metadata.originalFilename ?? ''), {
      type: mediaType,
      ...(assetLeaseId ? { assetLeaseId } : {}),
      ...(input.mediaUrl ? { mediaUrl: String(input.mediaUrl) } : {}),
      ...(input.metadata ? { metadata: input.metadata as Record<string, unknown> } : {}),
    })],
  }];
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
    ...(view.mode !== undefined ? { mode: view.mode } : {}),
    ...(view.toolbar !== undefined ? { toolbar: view.toolbar } : {}),
    ...(Object.hasOwn(view, 'group') ? { group: view.group } : {}),
    ...(Object.keys(replace).length > 0 ? { replace } : {}),
  } as Extract<UpdateInstruction, { kind: 'view'; property: 'configuration' }>['view'];
}

function attachDefaultReturn(command: string, changeSet: ChangeSet): void {
  if (changeSet.return) return;
  const preferred = command === 'field define'
    ? changeSet.operations.find((change): change is Extract<Change, { op: 'update' }> => change.op === 'update')?.targets
    : undefined;
  const binding = [...changeSet.operations].reverse().find((change) => (
    (change.op === 'create' || change.op === 'duplicate') && change.bind
  )) ?? changeSet.operations.find((change) => change.op === 'ensure' && change.bind);
  const targets = preferred ?? (binding && 'bind' in binding && binding.bind ? { binding: binding.bind } as TargetRef : undefined);
  if (!targets) return;
  changeSet.return = [{
    kind: preferred ? 'outline' : 'node',
    targets,
    ...(preferred ? { depth: 2 } : {}),
    include: ['description', 'children', 'tags', 'fields', 'references', 'media', 'view', 'trash'],
    page: { limit: 10_000 },
  }];
}

function oneAlias(alias: Extract<Selector, { by: 'alias' }>['alias']): TargetRef {
  return { target: { selector: { by: 'alias', alias }, cardinality: 'one' } };
}

async function targetDone(target: TargetRef, context: PorcelainBuildContext): Promise<boolean> {
  const node = await context.lookup(selectorFromExactTarget(target));
  return node.done === true || (typeof node.completedAt === 'number' && node.completedAt > 0);
}

async function buildRelativeMove(
  command: 'indent' | 'outdent',
  targets: TargetRef,
  context: PorcelainBuildContext,
): Promise<Change> {
  const selector = selectorFromExactTarget(targets);
  const node = await context.lookup(selector);
  const parentId = requiredString(node.parentId, `${command} target parent`);
  const parent = await context.lookup({ by: 'id', id: parentId });
  if (command === 'indent') {
    const siblings = stringArray(parent.children);
    const position = siblings.indexOf(requiredString(node.id, 'target ID'));
    if (position <= 0) throw usageError('indent target has no previous sibling.');
    return { op: 'move', targets, destination: oneId(siblings[position - 1]!) };
  }
  const grandparentId = requiredString(parent.parentId, 'outdent grandparent');
  const grandparent = await context.lookup({ by: 'id', id: grandparentId });
  const parentPosition = stringArray(grandparent.children).indexOf(parentId);
  return { op: 'move', targets, destination: oneId(grandparentId), index: Math.max(0, parentPosition + 1) };
}

function oneId(id: string): TargetRef {
  return { target: { selector: { by: 'id', id }, cardinality: 'one' } };
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
  if (command === 'definition create') return [await buildDefinitionCreate(parsed, context)];
  if (command === 'definition configure') return [await buildDefinitionConfigure(parsed, context)];
  if (command.startsWith('reference ')) return [await buildReference(command, parsed, context)];
  if (command.startsWith('view ')) return [await buildView(command, parsed, context)];
  if (command.startsWith('search ')) return buildSearch(command, parsed, context);
  if (command === 'template apply') return [await buildTemplate(parsed, context)];
  if (command === 'daily ensure') return [buildDailyEnsure(parsed)];
  if (command === 'capture add') return buildCapture(parsed, context);
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
    bind: option(parsed, 'bind') ?? 'created',
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
      bind: option(parsed, 'bind') ?? 'copies',
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
  allow(parsed, ['target', 'field', 'source-field', 'name', 'field-type', 'value', 'option', 'index']);
  const target = option(parsed, 'target') ?? parsed.positional.shift();
  if (!target) throw usageError(`${command} requires a target.`);
  const action = command.slice('field '.length);
  let instructions: Extract<UpdateInstruction, { kind: 'field' }>[];
  if (action === 'define') {
    const existingField = option(parsed, 'field');
    const name = option(parsed, 'name') ?? parsed.positional.shift();
    if (existingField && name) throw usageError('field define accepts either NAME or --field, not both.');
    if (!existingField && !name) throw usageError('field define requires NAME or --field.');
    if (existingField) {
      const field = await targetRef(existingField, context.read);
      instructions = [{
        kind: 'field', action: 'attach', field,
        ...(option(parsed, 'index') ? { index: integer(option(parsed, 'index')!, '--index', 0) } : {}),
      }];
      if (has(parsed, 'value')) instructions.push({
        kind: 'field', action: 'set', field,
        value: scalarValue(option(parsed, 'value')!, 'field value'),
      });
    } else {
      instructions = [{
        kind: 'field',
        action: 'define',
        name: name!,
        fieldType: fieldType(option(parsed, 'field-type') ?? 'plain'),
        ...(option(parsed, 'index') ? { index: integer(option(parsed, 'index')!, '--index', 0) } : {}),
        ...(has(parsed, 'value') ? { value: scalarValue(option(parsed, 'value')!, 'field value') } : {}),
      }];
    }
  } else if (action === 'set') {
    const field = option(parsed, 'field') ?? parsed.positional.shift();
    const value = option(parsed, 'value') ?? parsed.positional.shift();
    if (!field || value === undefined) throw usageError('field set requires FIELD and VALUE.');
    instructions = [{
      kind: 'field',
      action: 'set',
      field: await targetRef(field, context.read),
      value: scalarValue(value, 'field value'),
    }];
  } else if (action === 'reuse') {
    const field = option(parsed, 'field') ?? parsed.positional.shift();
    const source = option(parsed, 'source-field') ?? parsed.positional.shift();
    if (!field || !source) throw usageError('field reuse requires SOURCE_FIELD and TARGET_FIELD.');
    instructions = [{
      kind: 'field',
      action: 'reuse',
      field: await targetRef(field, context.read),
      sourceField: await targetRef(source, context.read),
    }];
  } else if (action === 'select') {
    const field = option(parsed, 'field') ?? parsed.positional.shift();
    const selected = option(parsed, 'option') ?? parsed.positional.shift();
    if (!field || !selected) throw usageError('field select requires FIELD and OPTION.');
    instructions = [{
      kind: 'field',
      action: 'select',
      field: await targetRef(field, context.read),
      option: await targetRef(selected, context.read),
    }];
  } else if (action === 'clear' || action === 'remove') {
    const field = option(parsed, 'field') ?? parsed.positional.shift();
    if (!field) throw usageError(`${command} requires FIELD.`);
    instructions = [{
      kind: 'field',
      action,
      field: await targetRef(field, context.read),
    }];
  } else {
    throw usageError(`Unknown field command: ${command}`);
  }
  if (parsed.positional.length > 0) throw usageError(`Unexpected ${command} argument: ${parsed.positional[0]}`);
  return { op: 'update', targets: await targetRef(target, context.read), changes: instructions };
}

async function buildDefinitionCreate(parsed: ParsedOptions, context: PorcelainBuildContext): Promise<Change> {
  allow(parsed, ['type', 'name', 'field-type', 'id', 'config', 'template', 'options', 'bind']);
  const type = option(parsed, 'type') ?? parsed.positional.shift();
  const name = option(parsed, 'name') ?? parsed.positional.shift();
  if ((type !== 'tag' && type !== 'field') || !name || parsed.positional.length > 0) {
    throw usageError('definition create requires TYPE(tag|field) and NAME.');
  }
  const configSource = option(parsed, 'config');
  const config = configSource
    ? parseJson(await context.read(configSource), '--config') as Record<string, unknown>
    : type === 'field' ? { fieldType: fieldType(option(parsed, 'field-type') ?? 'plain') } : undefined;
  if (type === 'tag') {
    const templateSource = option(parsed, 'template');
    const templateValue = templateSource ? parseJson(await context.read(templateSource), '--template') : undefined;
    return {
      op: 'create', resource: 'definition', definitionType: 'tag', name,
      ...(option(parsed, 'id') ? { id: option(parsed, 'id') } : {}),
      ...(config ? { config } : {}),
      ...(templateValue ? { template: (Array.isArray(templateValue) ? templateValue : [templateValue]) as NodeDraft[] } : {}),
      bind: option(parsed, 'bind') ?? 'definition',
    } as Change;
  }
  const optionsSource = option(parsed, 'options');
  const optionsValue = optionsSource ? parseJson(await context.read(optionsSource), '--options') : undefined;
  return {
    op: 'create', resource: 'definition', definitionType: 'field', name,
    ...(option(parsed, 'id') ? { id: option(parsed, 'id') } : {}),
    config,
    ...(optionsValue ? { options: (Array.isArray(optionsValue) ? optionsValue : [optionsValue]) as NodeDraft[] } : {}),
    bind: option(parsed, 'bind') ?? 'definition',
  } as Change;
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
    'values', 'logic', 'display-field', 'toolbar', 'group', 'replace',
  ]);
  const target = option(parsed, 'target') ?? parsed.positional.shift();
  if (!target) throw usageError(`${command} requires a target.`);
  const value = option(parsed, 'value') ?? parsed.positional.shift();
  const fieldToken = option(parsed, 'field');
  const ruleId = option(parsed, 'rule');
  const displayFieldId = option(parsed, 'display-field');
  let instruction: Extract<UpdateInstruction, { kind: 'view' }>;
  if (command === 'view set') {
    const mode = option(parsed, 'mode') ?? value;
    const toolbar = option(parsed, 'toolbar');
    const group = option(parsed, 'group');
    const replacementSource = option(parsed, 'replace');
    const replacement = replacementSource
      ? parseJson(await context.read(replacementSource), '--replace')
      : undefined;
    if (replacement !== undefined && !isRecord(replacement)) throw usageError('--replace must be an object.');
    const view = {
      ...(mode !== undefined ? { mode: viewMode(mode) } : {}),
      ...(toolbar !== undefined ? { toolbar: boolean(toolbar, '--toolbar') } : {}),
      ...(group !== undefined ? { group: group === 'null' ? null : await viewField(group, context) } : {}),
      ...(replacement !== undefined ? { replace: replacement } : {}),
    };
    if (Object.keys(view).length === 0) throw usageError('view set requires mode, toolbar, group, or explicit replacement.');
    instruction = {
      kind: 'view', property: 'configuration', action: 'set',
      view: view as Extract<UpdateInstruction, { kind: 'view'; property: 'configuration' }>['view'],
    };
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

async function buildSearch(command: string, parsed: ParsedOptions, context: PorcelainBuildContext): Promise<readonly Change[]> {
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
  if (command === 'search ensure-tag') {
    allow(parsed, ['tag', 'bind']);
    const tag = option(parsed, 'tag') ?? parsed.positional.shift();
    if (!tag || parsed.positional.length > 0) throw usageError('search ensure-tag requires TAG.');
    return [{ op: 'ensure', resource: 'tag-search', tag: await targetRef(tag, context.read), bind: option(parsed, 'bind') ?? 'search' }];
  }
  allow(parsed, ['target', 'value', 'title', 'query', 'match', 'view', 'replace']);
  const target = option(parsed, 'target') ?? parsed.positional.shift();
  if (!target || parsed.positional.length > 0) throw usageError(`${command} requires TARGET.`);
  if (command === 'search refresh') {
    return [{
      op: 'update',
      targets: await targetRef(target, context.read),
      changes: [{ kind: 'search', action: 'refresh' }],
    }];
  }
  const legacyValue = option(parsed, 'value');
  const legacy = legacyValue ? scalar(legacyValue) : undefined;
  if (legacy !== undefined && !isRecord(legacy)) {
    throw usageError('search set --value must be an object.');
  }
  const querySource = option(parsed, 'query');
  const match = option(parsed, 'match');
  const mode = option(parsed, 'view');
  const replaceSource = option(parsed, 'replace');
  const view = mode || replaceSource ? {
    ...(mode ? { mode: viewMode(mode) } : {}),
    ...(replaceSource ? { replace: parseJson(await context.read(replaceSource), '--replace') } : {}),
  } : undefined;
  return [searchSetChange({
    target: await targetRef(target, context.read),
    ...(legacy ?? {}),
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
    throw usageError('capture add requires exactly one of --parent or --date, plus --title.');
  }
  const metadataSource = option(parsed, 'metadata');
  if (!metadataSource) throw usageError('capture add requires capture provenance through --metadata JSON|FILE.');
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

async function buildMediaAdd(parsed: ParsedOptions, context: PorcelainBuildContext): Promise<Change> {
  allow(parsed, ['parent', 'type', 'name', 'source', 'lease', 'url', 'metadata', 'bind']);
  const parent = option(parsed, 'parent') ?? parsed.positional.shift();
  const type = option(parsed, 'type') ?? parsed.positional.shift();
  const source = option(parsed, 'source') ?? parsed.positional.shift();
  const name = option(parsed, 'name') ?? '';
  if (!parent || (type !== 'image' && type !== 'attachment') || parsed.positional.length > 0) {
    throw usageError('media add requires PARENT, TYPE(image|attachment), and a source/lease/url.');
  }
  const metadataSource = option(parsed, 'metadata');
  const changes = await mediaAddChanges({
    parent: await targetRef(parent, context.read),
    mediaType: type,
    name,
    ...(source ? { source: source === '-' ? { kind: 'stdin' } : { kind: 'path', path: source } } : {}),
    ...(option(parsed, 'lease') ? { assetLeaseId: option(parsed, 'lease') } : {}),
    ...(option(parsed, 'url') ? { mediaUrl: option(parsed, 'url') } : {}),
    ...(metadataSource ? { metadata: parseJson(await context.read(metadataSource), '--metadata') } : {}),
    bind: option(parsed, 'bind') ?? 'media',
  }, context);
  return changes[0]!;
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
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
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
      const value = args[++index];
      if (value === undefined || value.startsWith('--')) throw usageError(`${arg} requires a value.`);
      options.set(name, value);
    }
  }
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
