import { afterEach, describe, expect, test } from 'bun:test';
import type { LinApi } from '../../src/preload';
import type {
  ChangeSet,
  Diff,
  Operation,
  OperationUndoGroup,
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
  test('uses direct commit for ordinary non-destructive desktop edits', async () => {
    const harness = await createHarness([
      node('root', { children: ['target'] }),
      node('target', { parentId: 'root' }),
    ]);

    await outlineDocumentApi.createNode('root', 1, '');
    await outlineDocumentApi.applyNodeTextPatch('target', {
      ops: [{ type: 'replace', from: 0, to: 0, content: rich('typed') }],
    });

    expect(harness.commitInputs).toHaveLength(2);
    expect(harness.applyInputs).toHaveLength(0);
    expect(harness.commitInputs[0]!.operations[0]).toMatchObject({ op: 'create' });
    expect(firstUpdate(harness.commitInputs[1]!)).toMatchObject({ kind: 'text-patch' });
  });

  test('passes text-edit undo groups through direct desktop commits', async () => {
    const harness = await createHarness([
      node('root', { children: ['target'] }),
      node('target', { parentId: 'root' }),
    ]);
    const undoGroup: OperationUndoGroup = {
      groupId: 'undo-group:test-materialize',
      kind: 'text-edit',
      nodeId: 'node:draft',
    };

    await outlineDocumentApi.materializeDraftNode('root', 1, 'A', 'node:draft', undoGroup);
    await outlineDocumentApi.applyNodeTextPatch('node:draft', {
      ops: [{ type: 'replace', from: 1, to: 1, content: rich('B') }],
    }, { undoGroup });

    expect(harness.commitRequests.map((input) => input.undoGroup)).toEqual([undoGroup, undoGroup]);
  });

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
    const createBinds = operations.flatMap((change) => (
      change.op === 'create' && change.bind ? [change.bind] : []
    ));
    expect(createBinds).toHaveLength(3);
    expect(new Set(createBinds).size).toBe(createBinds.length);
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

  test('round-trips paste metadata through field-slot appendNodes drafts', async () => {
    const harness = await createHarness([
      node('root', { children: ['owner'] }),
      node('owner', { parentId: 'root' }),
      node('field', { type: 'fieldDef' }),
    ]);

    await outlineDocumentApi.updateFieldSlot('owner', 'field', {
      kind: 'appendNodes',
      id: 'node:value',
      nodes: [{
        content: rich('Task #Work'),
        tags: ['Work'],
        fields: [{ name: 'Status', value: 'Open' }],
        children: [{
          content: rich('Child #Next'),
          tags: ['Next'],
          fields: [],
          children: [],
        }],
      }],
    });

    const instruction = firstUpdate(harness.changeSets[0]!);
    expect(instruction).toMatchObject({
      kind: 'field-slot',
      mutation: {
        action: 'append-nodes',
        nodes: [{
          metadata: {
            pasteTags: ['Work'],
            pasteFields: [{ name: 'Status', value: 'Open' }],
          },
          children: [{
            metadata: {
              pasteTags: ['Next'],
            },
          }],
        }],
      },
    });
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

  test('creates and converts unchecked checkbox rows atomically', async () => {
    const harness = await createHarness([
      node('root', { children: ['target'] }),
      node('target', { parentId: 'root', content: rich('/checkbox') }),
    ]);

    await outlineDocumentApi.createCheckboxNode('root', 1, rich('Created'), 'created-checkbox');
    await outlineDocumentApi.convertNodeToCheckbox('target', rich('Converted'));

    expect(harness.changeSets[0]!.operations).toEqual([{
      op: 'create',
      placement: { kind: 'index', parent: oneId('root'), index: 1 },
      nodes: [{
        id: 'created-checkbox',
        content: rich('Created'),
        children: [],
        checkbox: true,
        done: false,
      }],
    }]);
    expect(harness.changeSets[1]!.operations).toEqual([{
      op: 'update',
      targets: oneId('target'),
      changes: [
        { kind: 'content', value: rich('Converted') },
        { kind: 'checkbox', visible: true },
      ],
    }]);
  });

  test('replaces tag trigger content and applies an existing tag atomically', async () => {
    const harness = await createHarness([
      node('root', { children: ['target'] }),
      node('target', { parentId: 'root', content: rich('Task #project') }),
      node('tag:project', { type: 'tagDef', content: rich('project') }),
    ]);

    await outlineDocumentApi.applyTagWithContent('target', 'tag:project', rich('Task '));

    expect(harness.changeSets[0]!.operations).toEqual([{
      op: 'update',
      targets: oneId('target'),
      changes: [
        { kind: 'content', value: rich('Task ') },
        { kind: 'tag', action: 'add', tag: oneId('tag:project') },
      ],
    }]);
  });

  test('ensures a renderer-reserved tag and applies it with trigger content in one ChangeSet', async () => {
    const harness = await createHarness([
      node('root', { children: ['target'] }),
      node('target', { parentId: 'root', content: rich('#new') }),
    ]);

    await outlineDocumentApi.createTagAndApplyWithContent(
      'target',
      'new',
      rich(''),
      'node:reserved-tag',
    );

    expect(harness.changeSets[0]!.operations).toEqual([
      {
        op: 'ensure',
        resource: 'definition',
        definitionType: 'tag',
        id: 'node:reserved-tag',
        name: 'new',
        bind: 'tag',
      },
      {
        op: 'update',
        targets: oneId('target'),
        changes: [
          { kind: 'content', value: rich('') },
          { kind: 'tag', action: 'add', tag: { binding: 'tag' } },
        ],
      },
    ]);
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
        config: { fieldType: 'number' },
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

  test('binds a newly materialized draft before converting it into an inline field', async () => {
    const harness = await createHarness([
      node('root', { children: [] }),
    ]);

    const result = await outlineDocumentApi.createInlineField(
      'root',
      0,
      '',
      'plain',
      undefined,
      'node:field-entry',
    );

    expect(harness.changeSets[0]!.operations).toEqual([
      {
        op: 'create',
        placement: { kind: 'index', parent: oneId('root'), index: 0 },
        nodes: [{
          id: 'node:field-entry',
          content: { text: '', marks: [], inlineRefs: [] },
          children: [],
        }],
        bind: 'field-entry',
      },
      {
        op: 'update',
        targets: { binding: 'field-entry' },
        changes: [{ kind: 'field', action: 'convert', name: '', fieldType: 'plain' }],
      },
    ]);
    expect(result.focus).toEqual({
      nodeId: 'node:field-entry',
      parentId: 'root',
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

  test('deletes mixed rows through one contiguous ChangeSet', async () => {
    const harness = await createHarness([
      node('root', { children: ['body', 'owner'] }),
      node('body', { parentId: 'root' }),
      node('owner', { parentId: 'root', children: ['entry'] }),
      node('field', { type: 'fieldDef' }),
      node('entry', {
        parentId: 'owner',
        type: 'fieldEntry',
        fieldDefId: 'field',
        children: ['value-a', 'value-b'],
      }),
      node('value-a', { parentId: 'entry' }),
      node('value-b', { parentId: 'entry' }),
    ]);

    await outlineDocumentApi.batchDeleteRows(['body'], ['value-a', 'value-b']);

    expect(harness.commitInputs).toHaveLength(1);
    expect(harness.commitInputs[0]!.operations).toEqual([
      {
        op: 'update',
        targets: { target: { selector: { by: 'id', id: 'owner' }, cardinality: 'one' } },
        changes: [
          {
            kind: 'field-slot',
            field: { target: { selector: { by: 'id', id: 'field' }, cardinality: 'one' } },
            mutation: {
              action: 'remove-value',
              value: { target: { selector: { by: 'id', id: 'value-a' }, cardinality: 'one' } },
              entryId: 'entry',
            },
          },
          {
            kind: 'field-slot',
            field: { target: { selector: { by: 'id', id: 'field' }, cardinality: 'one' } },
            mutation: {
              action: 'remove-value',
              value: { target: { selector: { by: 'id', id: 'value-b' }, cardinality: 'one' } },
              entryId: 'entry',
            },
          },
        ],
      },
      {
        op: 'lifecycle',
        action: 'trash',
        targets: { target: { selector: { by: 'id', id: 'body' }, cardinality: 'one' } },
      },
    ]);
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

    expect(harness.commitInputs).toHaveLength(1);
    expect(harness.applyInputs.map((input) => input.acknowledgeDestructive)).toEqual([
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
    expect(harness.commitInputs).toHaveLength(1);
    expect(harness.applyInputs).toHaveLength(0);
  });

  test('uses ordinary Node content as the accessible name for an image Source', async () => {
    const harness = await createHarness([node('root')]);

    await outlineDocumentApi.createSourceNode('root', null, {
      sourceText: 'https://example.com/image.png',
      name: 'Architecture diagram',
    });

    expect(harness.changeSets[0]!.operations).toEqual([
      expect.objectContaining({
        op: 'create',
        nodes: [expect.objectContaining({ content: rich('Architecture diagram') })],
        bind: 'sourceOwner',
      }),
      expect.objectContaining({
        op: 'update',
        targets: { binding: 'sourceOwner' },
        changes: [expect.objectContaining({
          kind: 'source',
          action: 'add',
          sourceText: 'https://example.com/image.png',
        })],
      }),
    ]);
  });

  test('writes bare-URL content and its Source in one owner update', async () => {
    const harness = await createHarness([node('target')]);
    const url = 'https://example.com/article';

    await outlineDocumentApi.setNodeContentAndAddSource('target', rich(url), url);

    expect(harness.changeSets[0]!.operations).toEqual([{
      op: 'update',
      targets: oneId('target'),
      changes: [
        { kind: 'content', value: rich(url) },
        {
          kind: 'source',
          action: 'add',
          sourceText: url,
          valueId: expect.any(String),
        },
      ],
    }]);
  });

  test('materializes a bare-URL draft under its reserved Node identity', async () => {
    const harness = await createHarness([node('root')]);
    const url = 'https://example.com/article';

    await outlineDocumentApi.createSourceNode('root', 0, {
      id: 'node:reserved',
      name: url,
      sourceText: url,
    });

    expect(harness.changeSets[0]!.operations[0]).toMatchObject({
      op: 'create',
      nodes: [{ id: 'node:reserved', content: rich(url) }],
    });
  });
});

interface IntentHarness {
  readonly changeSets: ChangeSet[];
  readonly commitInputs: ChangeSet[];
  readonly commitRequests: Array<{ changeSet: ChangeSet; undoGroup?: OperationUndoGroup }>;
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
  const commitInputs: ChangeSet[] = [];
  const commitRequests: Array<{ changeSet: ChangeSet; undoGroup?: OperationUndoGroup }> = [];
  const applyInputs: Array<{ diff: Diff; acknowledgeDestructive?: boolean }> = [];
  let stream: ((record: OutlineStreamRecord) => void) | undefined;
  let revision = 7;
  let operationSequence = 0;

  const outline: NonNullable<LinApi['outline']> = {
    commit: async (input) => {
      const changeSet = input.changeSet;
      changeSets.push(changeSet);
      commitInputs.push(changeSet);
      commitRequests.push(input);
      revision += 1;
      operationSequence += 1;
      const operation = operationFor(revision, operationSequence);
      return {
        settlement: operation,
        update: {
          kind: 'delta',
          revision,
          todayId: projection.todayId,
          changedNodes: [],
          removedIds: [],
        },
        diff: diffFor(changeSet, revision - 1),
      };
    },
    request: async (request) => {
      if (request.command === 'get') {
        return success(request, {
          ...projectionResult(projection, revision),
          ...(backlinks.length > 0 ? { backlinks } : {}),
        });
      }
      if (request.command === 'preview') {
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
  return {
    changeSets,
    commitInputs,
    commitRequests,
    applyInputs,
  };
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
