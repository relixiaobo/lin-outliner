import { afterEach, describe, expect, test } from 'bun:test';
import type { LinApi } from '../../src/preload';
import type {
  ChangeSet,
  Diff,
  Operation,
  OutlineResponse,
  OutlineStreamRecord,
} from '../../src/outline/contract';
import type { DocumentProjection, NodeProjection, RichText } from '../../src/renderer/api/types';
import { subscribeDesktopProjection } from '../../src/renderer/api/outline';
import {
  installDesktopProjectionReader,
  outlineDocumentApi,
} from '../../src/renderer/api/outlineIntents';

const HASH = '0'.repeat(64);
const subscriptions: Array<() => void> = [];
let savedWindow: PropertyDescriptor | undefined;

afterEach(() => {
  while (subscriptions.length > 0) subscriptions.pop()?.();
  if (savedWindow) Object.defineProperty(globalThis, 'window', savedWindow);
  else delete (globalThis as { window?: unknown }).window;
  savedWindow = undefined;
});

describe('renderer Outline intents', () => {
  test('builds pasted metadata and trees through same-ChangeSet bindings', async () => {
    const harness = await createHarness([
      node('root', { children: ['parent'] }),
      node('parent', { parentId: 'root', children: ['first'] }),
      node('first', { parentId: 'parent' }),
    ]);

    await outlineDocumentApi.pasteNodesIntoNode(
      'first',
      rich('First #Work'),
      [{
        content: rich('Child'),
        tags: ['Work'],
        fields: [{ name: 'Owner', value: 'Lin' }],
        children: [{ content: rich('Grandchild'), tags: [], fields: [], children: [] }],
      }],
      [{ content: rich('Sibling'), tags: ['Work'], fields: [], children: [] }],
      { checkbox: true, tags: ['Work'], fields: [{ name: 'Owner', value: 'Ada' }] },
    );

    const operations = harness.changeSets[0]!.operations;
    expect(operations.slice(0, 2)).toEqual([
      expect.objectContaining({ op: 'ensure', definitionType: 'tag', name: 'work', bind: expect.any(String) }),
      expect.objectContaining({ op: 'ensure', definitionType: 'field', name: 'owner', bind: expect.any(String) }),
    ]);
    const childCreate = operations.find((change) => (
      change.op === 'create'
      && 'placement' in change
      && 'parent' in change.placement
      && 'binding' in change.placement.parent
    ));
    expect(childCreate).toMatchObject({
      op: 'create',
      placement: { kind: 'last', parent: { binding: expect.any(String) } },
    });
    expect(operations).toContainEqual(expect.objectContaining({
      op: 'update',
      changes: expect.arrayContaining([
        expect.objectContaining({ kind: 'tag', action: 'add', tag: { binding: expect.any(String) } }),
        expect.objectContaining({ kind: 'field', action: 'set', field: { binding: expect.any(String) } }),
      ]),
    }));
  });

  test('copies tags when splitting beside the source node', async () => {
    const harness = await createHarness([
      node('root', { children: ['source'] }),
      node('source', { parentId: 'root', tags: ['tag:a', 'tag:b'] }),
    ]);

    await outlineDocumentApi.splitNode('source', rich('Before'), rich('After'));

    expect(harness.changeSets[0]!.operations[1]).toMatchObject({
      op: 'create',
      placement: { kind: 'index', parent: oneId('root'), index: 1 },
      nodes: [expect.objectContaining({ tags: ['tag:a', 'tag:b'] })],
    });
  });

  test('reorders a selected sibling block without changing its internal order', async () => {
    const harness = await createHarness([
      node('root', { children: ['a', 'b', 'c', 'd'] }),
      node('a', { parentId: 'root' }),
      node('b', { parentId: 'root' }),
      node('c', { parentId: 'root' }),
      node('d', { parentId: 'root' }),
    ]);

    await outlineDocumentApi.batchMoveNodesDown(['b', 'c']);

    expect(harness.changeSets[0]!.operations).toEqual([
      { op: 'move', targets: oneId('c'), placement: { kind: 'index', parent: oneId('root'), index: 3 } },
      { op: 'move', targets: oneId('b'), placement: { kind: 'index', parent: oneId('root'), index: 2 } },
    ]);
  });

  test('encodes a drag block as one ordered multi-target move', async () => {
    const harness = await createHarness([
      node('root', { children: ['a', 'b', 'c'] }),
      node('a', { parentId: 'root' }),
      node('b', { parentId: 'root' }),
      node('c', { parentId: 'root' }),
    ]);

    await outlineDocumentApi.batchMoveNodes([
      { nodeId: 'b', parentId: 'root', index: 2 },
      { nodeId: 'a', parentId: 'root', index: 1 },
    ]);

    expect(harness.changeSets[0]!.operations).toEqual([{
      op: 'move',
      targets: {
        target: {
          selector: { by: 'ids', ids: ['a', 'b'] },
          cardinality: 'many',
          max: 2,
        },
      },
      placement: { kind: 'last', parent: oneId('root') },
    }]);
  });

  test('cycles checkbox visibility and completion state from Projection state', async () => {
    const harness = await createHarness([
      node('root', { children: ['hidden', 'todo', 'done'] }),
      node('hidden', { parentId: 'root' }),
      node('todo', { parentId: 'root', completedAt: 0 }),
      node('done', { parentId: 'root', completedAt: 10 }),
    ]);

    await outlineDocumentApi.cycleDoneState('hidden');
    await outlineDocumentApi.cycleDoneState('todo');
    await outlineDocumentApi.cycleDoneState('done');

    expect(firstUpdate(harness.changeSets[0]!)).toEqual({ kind: 'checkbox', visible: true });
    expect(firstUpdate(harness.changeSets[1]!)).toEqual({ kind: 'done', value: true });
    expect(firstUpdate(harness.changeSets[2]!)).toEqual({ kind: 'checkbox', visible: false });
  });

  test('reads desktop backlinks from the dedicated Projection collection', async () => {
    await createHarness([node('target')], [{
      targetId: 'target', sourceId: 'source', referenceId: 'reference', kind: 'tree',
    }]);

    await expect(outlineDocumentApi.backlinks('target')).resolves.toEqual([{
      sourceId: 'source', referenceId: 'reference', kind: 'tree',
    }]);
  });

  test('binds a newly ensured field into the display-field instruction', async () => {
    const harness = await createHarness([node('root')]);

    await outlineDocumentApi.createDisplayField('root', 'Estimate', 'number');

    expect(harness.changeSets[0]!.operations).toEqual([
      {
        op: 'ensure',
        resource: 'definition',
        definitionType: 'field',
        name: 'Estimate',
        fieldType: 'number',
        bind: 'field',
      },
      {
        op: 'update',
        targets: oneId('root'),
        changes: [{
          kind: 'view',
          property: 'display-field',
          action: 'add',
          field: { binding: 'field' },
        }],
      },
    ]);
  });

  test('converts the trigger row into an inline field without replacing its identity', async () => {
    const harness = await createHarness([
      node('root', { children: ['trigger'] }),
      node('trigger', { parentId: 'root', content: rich('') }),
    ]);

    const result = await outlineDocumentApi.createInlineFieldAfterNode('trigger', '', 'plain');

    expect(harness.changeSets[0]!.operations).toEqual([{
      op: 'update',
      targets: oneId('trigger'),
      changes: [{ kind: 'field', action: 'convert', name: '', fieldType: 'plain' }],
    }]);
    expect(result.focus).toEqual({
      nodeId: 'trigger',
      surface: 'field-name',
      placement: { kind: 'all' },
      selectAll: true,
    });
  });

  test('stores reference conversion content without leaking the internal text sentinel', async () => {
    const harness = await createHarness([
      node('root', { children: ['target'] }),
      node('target', { parentId: 'root', content: rich('Target') }),
    ]);

    await outlineDocumentApi.addReferenceConversion('root', 'target');

    expect(harness.changeSets[0]!.operations[0]).toMatchObject({
      op: 'create',
      nodes: [expect.objectContaining({
        content: {
          text: '',
          marks: [],
          inlineRefs: [{
            offset: 0,
            target: { kind: 'node', nodeId: 'target' },
            displayName: 'Target',
          }],
        },
      })],
    });
  });

  test('parses and saves the query builder outline through a typed search instruction', async () => {
    const harness = await createHarness([
      node('root', { children: ['search'] }),
      node('search', { type: 'search', parentId: 'root', content: rich('Open work') }),
    ]);

    await outlineDocumentApi.setSearchQueryOutline('search', [
      '- AND',
      '  - TODO',
      '  - STRING_MATCH',
      '    - value:: launch plan',
    ].join('\n'));

    expect(firstUpdate(harness.changeSets[0]!)).toEqual({
      kind: 'search',
      action: 'set',
      title: 'Open work',
      query: {
        kind: 'group',
        logic: 'AND',
        children: [
          { kind: 'rule', op: 'TODO' },
          {
            kind: 'rule',
            op: 'STRING_MATCH',
            text: 'launch plan',
            operands: [{ text: 'launch plan' }],
          },
        ],
      },
    });
  });

  test('lowers field-slot helpers without returning to document-command IPC', async () => {
    const harness = await createHarness([
      node('root', { children: ['entry'] }),
      node('field', { type: 'fieldDef', children: ['option'] }),
      node('option', { parentId: 'field' }),
      node('entry', { type: 'fieldEntry', parentId: 'root', fieldDefId: 'field', children: ['value'] }),
      node('value', { parentId: 'entry' }),
    ]);

    await outlineDocumentApi.createCollectedFieldOption('entry', 'New option', 'node:new');
    await outlineDocumentApi.selectFieldOption('entry', 'option', 'node:selected');
    await outlineDocumentApi.setFieldFreeTextValue('entry', 'Free text', 'node:text');
    await outlineDocumentApi.clearFieldValue('entry');
    await outlineDocumentApi.removeFieldValue('value');
    await outlineDocumentApi.registerCollectedOption('field', 'Pool option');

    expect(firstUpdate(harness.changeSets[0]!)).toMatchObject({
      kind: 'field-slot',
      field: oneId('field'),
      mutation: { action: 'append-text', text: 'New option', collect: true, entryId: 'entry', id: 'node:new' },
    });
    expect(firstUpdate(harness.changeSets[1]!)).toMatchObject({
      kind: 'field-slot',
      mutation: { action: 'select-option', option: oneId('option'), entryId: 'entry', id: 'node:selected' },
    });
    expect(firstUpdate(harness.changeSets[2]!)).toMatchObject({
      kind: 'field-slot',
      mutation: { action: 'append-text', text: 'Free text', entryId: 'entry', id: 'node:text' },
    });
    expect(firstUpdate(harness.changeSets[3]!)).toEqual({ kind: 'field', action: 'clear', field: oneId('field') });
    expect(firstUpdate(harness.changeSets[4]!)).toMatchObject({
      kind: 'field-slot',
      mutation: { action: 'remove-value', value: oneId('value'), entryId: 'entry' },
    });
    expect(firstUpdate(harness.changeSets[5]!)).toEqual({
      kind: 'field', action: 'register-option', name: 'Pool option',
    });
  });

  test('acknowledges only explicitly destructive desktop intents', async () => {
    const harness = await createHarness([
      node('root', { children: ['source', 'target'] }),
      node('source', { parentId: 'root' }),
      node('target', { parentId: 'root' }),
    ]);

    await outlineDocumentApi.trashNode('source');
    await outlineDocumentApi.deleteNode('source');
    await outlineDocumentApi.mergeNodeInto('source', 'target');

    expect(harness.applyInputs.map((input) => input.acknowledgeDestructive)).toEqual([
      undefined,
      true,
      true,
    ]);
  });

  test('keeps renderer rich-text replace-all patches non-reviewed and non-acknowledged', async () => {
    const harness = await createHarness([
      node('root', { children: ['target'] }),
      node('target', { parentId: 'root' }),
    ]);

    await outlineDocumentApi.applyNodeTextPatch('target', {
      ops: [{
        type: 'replace_all',
        content: { text: 'IME or inline-reference sync', marks: [], inlineRefs: [] },
      }],
    });

    expect(firstUpdate(harness.changeSets[0]!)).toEqual({
      kind: 'text-patch',
      field: 'content',
      patch: {
        ops: [{
          type: 'replace_all',
          content: { text: 'IME or inline-reference sync', marks: [], inlineRefs: [] },
        }],
      },
    });
    expect(harness.applyInputs[0]?.acknowledgeDestructive).toBeUndefined();
  });

  test('preserves image alt text in the typed NodeDraft metadata', async () => {
    const harness = await createHarness([node('root')]);

    await outlineDocumentApi.createImageNode('root', null, {
      mediaUrl: 'https://example.com/image.png',
      alt: 'Architecture diagram',
      width: 640,
    });

    expect(harness.changeSets[0]!.operations[0]).toMatchObject({
      op: 'create',
      nodes: [expect.objectContaining({
        type: 'image',
        mediaUrl: 'https://example.com/image.png',
        metadata: { alt: 'Architecture diagram', width: 640 },
      })],
    });
  });
});

interface IntentHarness {
  readonly changeSets: ChangeSet[];
  readonly applyInputs: Array<{ diff: Diff; acknowledgeDestructive?: boolean }>;
}

async function createHarness(
  nodes: NodeProjection[],
  backlinks: Array<{ targetId: string; sourceId: string; referenceId: string; kind: string }> = [],
): Promise<IntentHarness> {
  savedWindow ??= Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.assign(globalThis, { window: {} });
  const projection = documentProjection(nodes);
  const byId = new Map(nodes.map((entry) => [entry.id, entry]));
  const changeSets: ChangeSet[] = [];
  const applyInputs: Array<{ diff: Diff; acknowledgeDestructive?: boolean }> = [];
  let stream: ((record: OutlineStreamRecord) => void) | undefined;
  let revision = 7;
  let operationSequence = 0;

  const outline: NonNullable<LinApi['outline']> = {
    request: async (request) => {
      if (request.command === 'show') return success(request, {
        ...projectionResult(projection, revision),
        ...(backlinks.length > 0 ? { backlinks } : {}),
      });
      if (request.command === 'diff') {
        const changeSet = (request.input as { changeSet: ChangeSet }).changeSet;
        changeSets.push(changeSet);
        return success(request, diffFor(changeSet, revision));
      }
      if (request.command === 'apply') {
        const input = request.input as { diff: Diff; acknowledgeDestructive?: boolean };
        applyInputs.push(input);
        revision += 1;
        operationSequence += 1;
        const operation = operationFor(revision, operationSequence);
        stream?.(eventFor(operation, operationSequence));
        return success(request, operation);
      }
      throw new Error(`Unexpected Outline request: ${request.command}`);
    },
    cancel: () => undefined,
    subscribe: (_subscription, listener) => {
      stream = listener;
      queueMicrotask(() => listener({
        protocolVersion: 1,
        requestId: 'watch:intents',
        sequence: 0,
        type: 'hello',
        cursor: 'cursor:7',
      }));
      return () => {
        stream = undefined;
      };
    },
  };
  Object.assign(window, { lin: { outline } as unknown as LinApi });
  const uninstallReader = installDesktopProjectionReader(() => ({ projection, byId }));
  const subscription = subscribeDesktopProjection(() => undefined, () => undefined);
  subscriptions.push(uninstallReader, subscription.unsubscribe);
  await subscription.ready;
  return { changeSets, applyInputs };
}

function documentProjection(nodes: NodeProjection[]): DocumentProjection {
  return {
    workspaceId: 'workspace-id',
    rootId: 'root',
    libraryId: 'library',
    dailyNotesId: 'daily-notes',
    schemaId: 'schema',
    searchesId: 'searches',
    recentsId: 'recents',
    trashId: 'trash',
    todayId: 'today',
    nodes,
  };
}

function projectionResult(projection: DocumentProjection, revision: number) {
  const { nodes, ...anchors } = projection;
  return {
    projection: {
      kind: 'outline',
      targets: { target: { selector: { by: 'alias', alias: 'home' }, cardinality: 'one' } },
      depth: 1_024,
      include: ['children'],
      page: { limit: 10_000 },
    },
    revision,
    anchors,
    nodes,
  };
}

function diffFor(changeSet: ChangeSet, revision: number): Diff {
  return {
    protocolVersion: 1,
    kind: 'outline.diff',
    diffHash: HASH,
    changeSetHash: HASH,
    baseRevision: revision,
    normalizedChangeSet: changeSet,
    bindings: {},
    affected: [],
    destructive: [],
    warnings: [],
    resultEstimate: { nodeCount: 0, encodedBytes: 0 },
  };
}

function operationFor(revisionAfter: number, sequence: number): Operation {
  return {
    protocolVersion: 1,
    kind: 'outline.operation',
    operationId: `operation:${sequence}`,
    changeSetHash: HASH,
    diffHash: HASH,
    origin: 'desktop',
    summary: 'Applied renderer intent.',
    affectedNodeIds: [],
    affectedNodeCount: 0,
    affectedNodeIdsHash: HASH,
    revisionBefore: revisionAfter - 1,
    revisionAfter,
    createdAt: '2026-08-24T00:00:00.000Z',
    reversible: true,
    recoverable: true,
  };
}

function eventFor(operation: Operation, sequence: number): OutlineStreamRecord {
  return {
    protocolVersion: 1,
    requestId: 'watch:intents',
    sequence,
    type: 'event',
    cursor: `cursor:${operation.revisionAfter}`,
    event: {
      protocolVersion: 1,
      kind: 'outline.event',
      type: 'operation.committed',
      instanceId: 'runtime:intents',
      sequence,
      revision: operation.revisionAfter,
      cursor: `cursor:${operation.revisionAfter}`,
      operation,
      changes: { changedNodes: [], removedIds: [] },
    },
  };
}

function success(
  request: { requestId: string; command: string },
  data: unknown,
): OutlineResponse {
  return {
    protocolVersion: 1,
    requestId: request.requestId,
    command: request.command,
    ok: true,
    revision: 7,
    data,
  };
}

function node(id: string, patch: Partial<NodeProjection> = {}): NodeProjection {
  return {
    id,
    content: rich(id),
    children: [],
    tags: [],
    createdAt: 1,
    updatedAt: 1,
    locked: false,
    autoCollected: false,
    ...patch,
  } as NodeProjection;
}

function rich(text: string): RichText {
  return { text, marks: [], inlineRefs: [] };
}

function oneId(id: string) {
  return { target: { selector: { by: 'id', id }, cardinality: 'one' } };
}

function firstUpdate(changeSet: ChangeSet) {
  const operation = changeSet.operations[0];
  if (operation?.op !== 'update') throw new Error('Expected an update operation.');
  return operation.changes[0];
}
