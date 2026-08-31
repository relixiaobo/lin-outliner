import { canonicalSha256 } from '../contract/canonical';
import { OutlineContractError, outlineError } from '../contract/errors';
import {
  ProjectionResultSchema,
  type OneTargetRef,
  type Projection,
  type ProjectionResult,
  type ViewSummary,
} from '../contract/schemas';
import { checkOutlineSchema } from '../contract/validation';

const MAX_HUMAN_BYTES = 4 * 1024;
const NON_ITEM_NODE_TYPES = new Set([
  'queryCondition', 'viewDef', 'sortRule', 'filterRule', 'displayField',
  'defConfig', 'systemOption', 'fieldEntry',
]);

interface ReadClient {
  request(command: string, input: unknown, signal?: AbortSignal): Promise<{ data: unknown }>;
}

export async function inspectView(
  client: ReadClient,
  target: OneTargetRef,
  signal?: AbortSignal,
): Promise<ViewSummary> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await inspectViewOnce(client, target, signal);
    } catch (error) {
      if (attempt === 0 && isRevisionConflict(error)) continue;
      throw error;
    }
  }
  throw revisionConflict();
}

async function inspectViewOnce(
  client: ReadClient,
  target: OneTargetRef,
  signal?: AbortSignal,
): Promise<ViewSummary> {
  if ('binding' in target) throw invalidView('view inspect cannot resolve a ChangeSet binding.');
  const ownerPage = await show(client, {
    kind: 'node', targets: target, include: ['children'], page: { limit: 1 },
  }, signal);
  const owner = record(ownerPage.nodes[0], 'view owner');
  const ownerId = string(owner.id, 'view owner ID');
  const revision = ownerPage.revision;
  const ownerTree = await showAll(client, {
    kind: 'outline', targets: oneId(ownerId), depth: 1, include: ['children', 'view'], page: { limit: 10_000 },
  }, revision, signal);
  const directChildren = ownerTree.filter((node) => node.parentId === ownerId);
  const viewDefs = directChildren.filter((node) => node.type === 'viewDef');
  if (viewDefs.length !== 1) {
    throw invalidView(`view inspect requires exactly one view definition; found ${viewDefs.length}.`);
  }
  const viewDef = viewDefs[0]!;
  const viewId = string(viewDef.id, 'view definition ID');
  const viewTree = await showAll(client, {
    kind: 'outline', targets: oneId(viewId), depth: 1, include: ['view'], page: { limit: 10_000 },
  }, revision, signal);
  const viewChildren = viewTree.filter((node) => node.parentId === viewId);
  const displays = orderedDisplays(viewChildren.filter((node) => node.type === 'displayField').map((node) => ({
    ...node,
    id: string(node.id, 'display field ID'),
    displayOrder: typeof node.displayOrder === 'number' ? node.displayOrder : undefined,
  } as Record<string, unknown> & { id: string; displayOrder?: number })));
  const customFieldIds = [...new Set(displays.flatMap((node) => (
    typeof node.displayField === 'string' && !node.displayField.startsWith('sys:') ? [node.displayField] : []
  )))];
  const labels = new Map<string, string>();
  if (customFieldIds.length > 0) {
    const definitions = await showAll(client, {
      kind: 'summary',
      targets: { target: { selector: { by: 'ids', ids: customFieldIds }, cardinality: 'many', max: customFieldIds.length } },
      page: { limit: Math.min(10_000, customFieldIds.length) },
    }, revision, signal);
    for (const definition of definitions) labels.set(string(definition.id, 'field definition ID'), nodeText(definition));
  }
  const displayFields = displays.map((display, index) => {
    const fieldId = typeof display.displayField === 'string' ? display.displayField : `unknown:${display.id}`;
    const explicitLabel = typeof display.displayLabel === 'string' ? display.displayLabel : undefined;
    return {
      fieldId,
      label: explicitLabel ?? labels.get(fieldId) ?? systemFieldLabel(fieldId),
      visible: display.displayVisible !== false,
      order: typeof display.displayOrder === 'number' ? display.displayOrder : index,
    };
  });
  return {
    kind: 'outline.view-summary',
    revision,
    ownerId,
    title: nodeText(owner),
    mode: viewMode(viewDef.viewMode),
    toolbarVisible: viewDef.toolbarVisible !== false,
    itemCount: directChildren.filter(isOrdinaryViewItem).length,
    displayFieldCount: displayFields.length,
    displayDigest: canonicalSha256(displayFields),
    displayFields,
    group: typeof viewDef.groupField === 'string' ? viewDef.groupField : null,
    sortCount: viewChildren.filter((node) => node.type === 'sortRule').length,
    filterCount: viewChildren.filter((node) => node.type === 'filterRule').length,
  };
}

async function showAll(
  client: ReadClient,
  projection: Projection,
  revision: number,
  signal?: AbortSignal,
): Promise<Record<string, unknown>[]> {
  const nodes: Record<string, unknown>[] = [];
  let cursor: string | undefined;
  do {
    const page = await show(client, {
      ...projection,
      page: { limit: projection.page?.limit ?? 10_000, ...(cursor ? { cursor } : {}) },
    }, signal);
    if (page.revision !== revision) throw revisionConflict();
    nodes.push(...page.nodes.map((node) => record(node, 'projection node')));
    cursor = page.cursor;
  } while (cursor);
  return nodes;
}

async function show(client: ReadClient, projection: Projection, signal?: AbortSignal): Promise<ProjectionResult> {
  const data = (await client.request('show', { projection }, signal)).data;
  if (!checkOutlineSchema(ProjectionResultSchema, data)) {
    throw new OutlineContractError(outlineError(
      'protocol_incompatible', 'protocol', 'Outline Runtime returned an invalid ProjectionResult.',
    ));
  }
  return data;
}

export function renderHumanResult(command: string, data: unknown): string {
  const lines = humanLines(command, data);
  const output = `${lines.join('\n')}\n`;
  if (Buffer.byteLength(output) <= MAX_HUMAN_BYTES) return output;
  const digest = canonicalSha256(data);
  const kept = [...lines];
  while (kept.length > 0) {
    const omitted = lines.slice(kept.length);
    const suffix = `Omitted lines: ${omitted.length}; bytes=${Buffer.byteLength(`${omitted.join('\n')}\n`)}\nDigest: ${digest}\n`;
    const bounded = `${kept.join('\n')}\n${suffix}`;
    if (Buffer.byteLength(bounded) <= MAX_HUMAN_BYTES) return bounded;
    kept.pop();
  }
  return `Omitted lines: ${lines.length}; bytes=${Buffer.byteLength(output)}\nDigest: ${digest}\n`;
}

function humanLines(command: string, data: unknown): string[] {
  if (isRecord(data) && data.kind === 'outline.human-viewed-tree-receipt' && isRecord(data.settlement)) {
    return [
      ...humanLines(command, data.settlement),
      `Owner: ${String(data.ownerId)}`,
      `Items: ${String(data.itemCount)}`,
      `Display fields: ${String(data.displayFieldCount)}`,
      `Persisted view mode: ${String(data.mode)}`,
    ];
  }
  if (isRecord(data) && data.kind === 'outline.human-diff-receipt' && isRecord(data.diff)) {
    const diff = data.diff;
    const effects = new Map<string, number>();
    for (const affected of Array.isArray(diff.affected) ? diff.affected : []) {
      if (!isRecord(affected)) continue;
      const effect = String(affected.effect);
      effects.set(effect, (effects.get(effect) ?? 0) + 1);
    }
    const bindings = isRecord(diff.bindings) ? Object.entries(diff.bindings) : [];
    const shownBindings = bindings.slice(0, 16);
    const warnings = Array.isArray(diff.warnings) ? diff.warnings : [];
    const shownWarnings = warnings.slice(0, 16);
    const destructive = new Map<string, number>();
    for (const entry of Array.isArray(diff.destructive) ? diff.destructive : []) {
      if (!isRecord(entry)) continue;
      const kind = String(entry.kind);
      destructive.set(kind, (destructive.get(kind) ?? 0) + Number(entry.targetCount ?? 0));
    }
    return [
      `Command: ${command}`,
      `Artifact: ${String(data.path)}; bytes=${String(data.byteCount)}; sha256=${String(data.sha256)}`,
      `Diff: ${String(diff.diffHash)}`,
      `ChangeSet: ${String(diff.changeSetHash)}`,
      `Base revision: ${String(diff.baseRevision)}`,
      `Effects: ${[...effects].map(([effect, count]) => `${effect}=${count}`).join(', ') || 'none'}`,
      `Destructive: ${[...destructive].map(([kind, count]) => `${kind}=${count}`).join(', ') || 'none'}`,
      `Bindings: ${shownBindings.map(([name, ids]) => `${name}=${Array.isArray(ids) ? ids.length : 0}`).join(', ') || 'none'}`,
      ...(bindings.length > shownBindings.length ? [`Omitted bindings: ${bindings.length - shownBindings.length}`] : []),
      ...shownWarnings.map((warning) => isRecord(warning)
        ? `Warning: ${String(warning.code)} ${String(warning.message)}`
        : `Warning: ${String(warning)}`),
      ...(warnings.length > shownWarnings.length ? [`Omitted warnings: ${warnings.length - shownWarnings.length}`] : []),
    ];
  }
  if (isRecord(data) && data.kind === 'outline.view-summary') {
    const fields = Array.isArray(data.displayFields) ? data.displayFields : [];
    const shownFields = fields.slice(0, 32);
    return [
      `Command: ${command}`,
      `Owner: ${String(data.ownerId)}`,
      `Title: ${String(data.title)}`,
      `View: ${String(data.mode)}; toolbar=${String(data.toolbarVisible)}`,
      `Items: ${String(data.itemCount)}`,
      `Display fields: ${String(data.displayFieldCount)}; digest=${String(data.displayDigest)}`,
      ...(fields.length > shownFields.length ? [`Omitted display fields: ${fields.length - shownFields.length}`] : []),
      ...shownFields.map((field) => isRecord(field)
        ? `  ${String(field.order)}\t${String(field.fieldId)}\t${String(field.label)}\tvisible=${String(field.visible)}`
        : `  ${String(field)}`),
      `Group: ${String(data.group)}`,
      `Sort rules: ${String(data.sortCount)}; filter rules: ${String(data.filterCount)}`,
      `Revision: ${String(data.revision)}`,
    ];
  }
  if (isRecord(data) && (data.kind === 'outline.operation' || data.kind === 'outline.no-change')) {
    const operation = data.kind === 'outline.operation';
    const resultIds = returnedRootIds(data).slice(0, 16);
    return [
      `Command: ${command}`,
      `Status: ${operation ? 'applied' : 'no-change'}`,
      ...(operation ? [`Operation: ${String(data.operationId)}`, `Revision: ${String(data.revisionBefore)} -> ${String(data.revisionAfter)}`] : [`Revision: ${String(data.revision)}`]),
      `Affected: ${String(data.affectedNodeCount)}; digest=${String(data.affectedNodeIdsHash ?? data.diffHash)}`,
      `Recovery: ${isRecord(data.recovery) ? String(data.recovery.state) : 'unknown'}`,
      ...(resultIds.length > 0 ? [`Returned roots: ${resultIds.join(', ')}`] : []),
    ];
  }
  return [JSON.stringify(data, null, 2)];
}

function returnedRootIds(data: Record<string, unknown>): string[] {
  if (!Array.isArray(data.result)) return [];
  return data.result.flatMap((entry) => isRecord(entry) && Array.isArray(entry.nodes)
    ? entry.nodes.flatMap((node) => isRecord(node) && typeof node.id === 'string' ? [node.id] : [])
    : []);
}

function oneId(id: string): OneTargetRef {
  return { target: { selector: { by: 'id', id }, cardinality: 'one' } };
}

function nodeText(node: Record<string, unknown>): string {
  if (isRecord(node.content) && typeof node.content.text === 'string') return node.content.text;
  return typeof node.text === 'string' ? node.text : '';
}

function viewMode(value: unknown): ViewSummary['mode'] {
  if (value === 'list' || value === 'table' || value === 'cards' || value === 'calendar') return value;
  return 'list';
}

function systemFieldLabel(fieldId: string): string {
  const labels: Record<string, string> = {
    'sys:name': 'Name', 'sys:createdAt': 'Created', 'sys:updatedAt': 'Updated',
    'sys:done': 'Done', 'sys:doneAt': 'Done at', 'sys:tags': 'Tags', 'sys:refCount': 'References',
  };
  return labels[fieldId] ?? fieldId;
}

function isOrdinaryViewItem(node: Record<string, unknown>): boolean {
  return !NON_ITEM_NODE_TYPES.has(String(node.type ?? 'plain'));
}

function orderedDisplays<T extends { id: string; displayOrder?: number }>(displays: readonly T[]): T[] {
  return displays
    .map((display, sourceIndex) => ({ display, sourceIndex }))
    .sort((left, right) => {
      const leftOrder = Number.isFinite(left.display.displayOrder)
        ? left.display.displayOrder!
        : Number.POSITIVE_INFINITY;
      const rightOrder = Number.isFinite(right.display.displayOrder)
        ? right.display.displayOrder!
        : Number.POSITIVE_INFINITY;
      return leftOrder - rightOrder
        || left.sourceIndex - right.sourceIndex
        || left.display.id.localeCompare(right.display.id);
    })
    .map(({ display }) => display);
}

function isRevisionConflict(error: unknown): boolean {
  return error instanceof OutlineContractError
    && error.outlineError.code === 'stale_revision';
}

function revisionConflict(): OutlineContractError {
  return new OutlineContractError(outlineError(
    'stale_revision', 'conflict',
    'The document revision changed while inspecting the view. Retry the complete command.',
    { retryable: true },
  ));
}

function invalidView(message: string): OutlineContractError {
  return new OutlineContractError(outlineError('invalid_input', 'selection', message, {
    next: ['Run outline schema view inspect --part result for the exact summary contract.'],
  }));
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw invalidView(`Missing ${label}.`);
  return value;
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string') throw invalidView(`Missing ${label}.`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
