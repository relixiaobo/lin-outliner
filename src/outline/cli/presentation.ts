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

const MAX_SUMMARY_BYTES = 4 * 1024;
const MAX_DIFF_BINDINGS = 8;
const MAX_DIFF_WARNINGS = 4;
const MAX_VIEW_FIELDS = 4;
const MAX_RETURNED_ROOTS = 8;
const MAX_PROJECTION_NODES = 4;
const MAX_BATCH_COUNTS = 16;
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

export function renderSummaryResult(command: string, data: unknown): string {
  const lines = summaryLines(command, data);
  const output = `${lines.join('\n')}\n`;
  if (Buffer.byteLength(output) <= MAX_SUMMARY_BYTES) return output;
  const digest = canonicalSha256(data);
  const kept = [...lines];
  while (kept.length > 0) {
    const omitted = lines.slice(kept.length);
    const suffix = `Omitted lines: ${omitted.length}; bytes=${Buffer.byteLength(`${omitted.join('\n')}\n`)}\nDigest: ${digest}\n`;
    const bounded = `${kept.join('\n')}\n${suffix}`;
    if (Buffer.byteLength(bounded) <= MAX_SUMMARY_BYTES) return bounded;
    kept.pop();
  }
  return `Omitted lines: ${lines.length}; bytes=${Buffer.byteLength(output)}\nDigest: ${digest}\n`;
}

function summaryLines(command: string, data: unknown): string[] {
  if (command === 'capabilities' && Array.isArray(data)) {
    return data.map((entry) => isRecord(entry)
      ? `${summaryScalar(entry.name, 128)}\t${summaryScalar(entry.summary)}`
      : summaryScalar(entry));
  }
  if (isRecord(data) && data.kind === 'outline.summary-viewed-tree-receipt' && isRecord(data.settlement)) {
    return [
      ...summaryLines(command, data.settlement),
      `Owner: ${summaryScalar(data.ownerId)}`,
      `Items: ${summaryScalar(data.itemCount)}`,
      `Display fields: ${summaryScalar(data.displayFieldCount)}`,
      `Persisted view mode: ${summaryScalar(data.mode)}`,
    ];
  }
  if (isRecord(data) && data.kind === 'outline.summary-diff-receipt' && isRecord(data.diff)) {
    const diff = data.diff;
    const effects = new Map<string, number>();
    for (const affected of Array.isArray(diff.affected) ? diff.affected : []) {
      if (!isRecord(affected)) continue;
      const effect = String(affected.effect);
      effects.set(effect, (effects.get(effect) ?? 0) + 1);
    }
    const bindings = isRecord(diff.bindings) ? Object.entries(diff.bindings) : [];
    const shownBindings = bindings.slice(0, MAX_DIFF_BINDINGS);
    const warnings = Array.isArray(diff.warnings) ? diff.warnings : [];
    const shownWarnings = warnings.slice(0, MAX_DIFF_WARNINGS);
    const destructive = new Map<string, number>();
    for (const entry of Array.isArray(diff.destructive) ? diff.destructive : []) {
      if (!isRecord(entry)) continue;
      const kind = String(entry.kind);
      destructive.set(kind, (destructive.get(kind) ?? 0) + Number(entry.targetCount ?? 0));
    }
    return [
      `Command: ${summaryScalar(command)}`,
      `Artifact: ${summaryScalar(data.path)}; bytes=${summaryScalar(data.byteCount)}; sha256=${summaryScalar(data.sha256)}`,
      `Diff: ${summaryScalar(diff.diffHash)}`,
      `ChangeSet: ${summaryScalar(diff.changeSetHash)}`,
      `Base revision: ${summaryScalar(diff.baseRevision)}`,
      `Effects: ${[...effects].map(([effect, count]) => `${summaryScalar(effect, 128)}=${count}`).join(', ') || 'none'}`,
      `Destructive: ${[...destructive].map(([kind, count]) => `${summaryScalar(kind, 128)}=${count}`).join(', ') || 'none'}`,
      `Bindings: ${shownBindings.map(([name, ids]) => `${summaryScalar(name, 128)}=${Array.isArray(ids) ? ids.length : 0}`).join(', ') || 'none'}`,
      ...(bindings.length > shownBindings.length ? [`Omitted bindings: ${bindings.length - shownBindings.length}`] : []),
      ...shownWarnings.map((warning) => isRecord(warning)
        ? `Warning: ${summaryScalar(warning.code, 128)} ${summaryScalar(warning.message, 256)}`
        : `Warning: ${summaryScalar(warning)}`),
      ...(warnings.length > shownWarnings.length ? [`Omitted warnings: ${warnings.length - shownWarnings.length}`] : []),
    ];
  }
  if (isRecord(data) && data.kind === 'outline.view-summary') {
    const fields = Array.isArray(data.displayFields) ? data.displayFields : [];
    const shownFields = fields.slice(0, MAX_VIEW_FIELDS);
    return [
      `Command: ${summaryScalar(command)}`,
      `Owner: ${summaryScalar(data.ownerId)}`,
      `Title: ${summaryScalar(data.title)}`,
      `View: ${summaryScalar(data.mode)}; toolbar=${summaryScalar(data.toolbarVisible)}`,
      `Items: ${summaryScalar(data.itemCount)}`,
      `Display fields: ${summaryScalar(data.displayFieldCount)}; digest=${summaryScalar(data.displayDigest)}`,
      ...(fields.length > shownFields.length ? [`Omitted display fields: ${fields.length - shownFields.length}`] : []),
      ...shownFields.map((field) => isRecord(field)
        ? `  ${summaryScalar(field.order, 32)}\t${summaryScalar(field.fieldId, 128)}\t${summaryScalar(field.label, 256)}\tvisible=${summaryScalar(field.visible, 32)}`
        : `  ${summaryScalar(field)}`),
      `Group: ${summaryScalar(data.group)}`,
      `Sort rules: ${summaryScalar(data.sortCount)}; filter rules: ${summaryScalar(data.filterCount)}`,
      `Revision: ${summaryScalar(data.revision)}`,
    ];
  }
  if (isRecord(data) && (data.kind === 'outline.operation' || data.kind === 'outline.no-change')) {
    const operation = data.kind === 'outline.operation';
    const returnedRoots = returnedRootIds(data);
    const shownRoots = returnedRoots.slice(0, MAX_RETURNED_ROOTS);
    return [
      `Command: ${summaryScalar(command)}`,
      `Status: ${operation ? 'applied' : 'no-change'}`,
      ...(operation ? [`Operation: ${summaryScalar(data.operationId)}`, `Revision: ${summaryScalar(data.revisionBefore)} -> ${summaryScalar(data.revisionAfter)}`] : [`Revision: ${summaryScalar(data.revision)}`]),
      `Affected: ${summaryScalar(data.affectedNodeCount)}; digest=${summaryScalar(data.affectedNodeIdsHash ?? data.diffHash)}`,
      `Recovery: ${isRecord(data.recovery) ? summaryScalar(data.recovery.state) : 'unknown'}`,
      ...(returnedRoots.length > 0 ? [
        `Returned roots: ${returnedRoots.length}; shown=${shownRoots.length}; omitted=${returnedRoots.length - shownRoots.length}; digest=${canonicalSha256(returnedRoots)}`,
        `  ${shownRoots.map((id) => summaryScalar(id, 256)).join(', ')}`,
      ] : []),
    ];
  }
  if (isProjectionResult(data)) return projectionSummaryLines(command, data);
  if (isRecord(data) && data.kind === 'outline.count') {
    return [
      `Command: ${summaryScalar(command)}`,
      `Count: ${summaryScalar(data.count)}`,
      `Revision: ${summaryScalar(data.revision)}`,
      'Exact: true',
    ];
  }
  if (isRecord(data) && data.kind === 'outline.batch-count' && Array.isArray(data.counts)) {
    const shown = data.counts.slice(0, MAX_BATCH_COUNTS);
    return [
      `Command: ${summaryScalar(command)}`,
      `Revision: ${summaryScalar(data.revision)}`,
      `Counts: ${data.counts.length}; shown=${shown.length}; omitted=${data.counts.length - shown.length}; digest=${canonicalSha256(data.counts)}`,
      ...shown.map((entry) => isRecord(entry)
        ? `  ${summaryScalar(entry.name, 128)}\t${summaryScalar(entry.count, 64)}`
        : `  ${summaryScalar(entry)}`),
    ];
  }
  return [
    `Command: ${summaryScalar(command)}`,
    `Result: ${summaryResultKind(data)}`,
    `Digest: ${canonicalSha256(data)}`,
    'Details: rerun with --json for the complete machine result.',
  ];
}

function projectionSummaryLines(command: string, data: Record<string, unknown>): string[] {
  const projection = data.projection as Record<string, unknown>;
  const nodes = data.nodes as unknown[];
  const shownNodes = nodes.slice(0, MAX_PROJECTION_NODES);
  const backlinks = Array.isArray(data.backlinks) ? data.backlinks : [];
  return [
    `Command: ${summaryScalar(command)}`,
    `Revision: ${summaryScalar(data.revision)}`,
    `Projection: ${summaryScalar(projection.kind)}`,
    `Nodes: ${nodes.length}; shown=${shownNodes.length}; omitted=${nodes.length - shownNodes.length}; digest=${canonicalSha256(nodes)}`,
    `Backlinks: ${backlinks.length}; digest=${canonicalSha256(backlinks)}`,
    `Continuation: ${typeof data.cursor === 'string' ? 'available' : 'none'}; truncated=${data.truncated === true}`,
    ...shownNodes.map((node, index) => nodeSummaryLine(node, index)),
  ];
}

function nodeSummaryLine(value: unknown, index: number): string {
  if (!isRecord(value)) {
    return `  Item ${index + 1}: value=${summaryScalar(value)}; digest=${canonicalSha256(value)}`;
  }
  const text = isRecord(value.content) && typeof value.content.text === 'string'
    ? value.content.text
    : value.text;
  const fields = [
    value.id !== undefined ? `id=${summaryScalar(value.id, 128)}` : undefined,
    value.type !== undefined ? `type=${summaryScalar(value.type, 64)}` : undefined,
    value.parentId !== undefined ? `parent=${summaryScalar(value.parentId, 128)}` : undefined,
    text !== undefined ? `text=${summaryScalar(text, 256)}` : undefined,
  ].filter((field): field is string => field !== undefined);
  return `  Node ${index + 1}: ${fields.join('; ') || 'no common fields'}; digest=${canonicalSha256(value)}`;
}

function isProjectionResult(value: unknown): value is Record<string, unknown> & {
  projection: Record<string, unknown>;
  nodes: unknown[];
} {
  return isRecord(value)
    && isRecord(value.projection)
    && typeof value.revision === 'number'
    && Array.isArray(value.nodes);
}

function summaryResultKind(value: unknown): string {
  if (isRecord(value) && typeof value.kind === 'string') return summaryScalar(value.kind, 128);
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  return typeof value;
}

function summaryScalar(value: unknown, maxBytes = 512): string {
  const text = String(value);
  const encoded = JSON.stringify(text).slice(1, -1).replace(/[\u007f-\u009f]/gu, (character) => (
    `\\u${character.codePointAt(0)!.toString(16).padStart(4, '0')}`
  ));
  if (Buffer.byteLength(encoded) <= maxBytes) return encoded;
  const suffix = `... [bytes=${Buffer.byteLength(encoded)}; sha256=${canonicalSha256(text)}]`;
  const budget = Math.max(0, maxBytes - Buffer.byteLength(suffix));
  let prefix = '';
  let bytes = 0;
  for (const character of encoded) {
    const nextBytes = Buffer.byteLength(character);
    if (bytes + nextBytes > budget) break;
    prefix += character;
    bytes += nextBytes;
  }
  return `${prefix}${suffix}`;
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
