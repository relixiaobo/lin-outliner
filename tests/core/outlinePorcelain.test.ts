import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runOutlineCli } from '../../src/outline/cli';
import type { Diff, Operation } from '../../src/outline/contract';
import { OutlineRuntimeServer } from '../../src/outline/runtime/server';

const roots: string[] = [];

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe('outline porcelain CLI', () => {
  test('creates one field-backed Node tree and reuses only compatible definitions', async () => {
    const root = await makeRoot();
    const runtime = await OutlineRuntimeServer.start({ root, contentRoot: `${root}-content`, idleTimeoutMs: 60_000 });
    expect(runtime).not.toBeNull();
    if (!runtime) return;
    try {
      const payload = (title: string, fieldType: 'text' | 'number') => JSON.stringify({
        at: { parent: '@today', position: 'first' },
        fields: [
          { key: 'weather', name: 'Weather', type: 'text' },
          { key: 'low', name: 'Night low (C)', type: fieldType },
        ],
        node: {
          text: title,
          description: 'Sunny throughout.',
          children: [{ text: 'Central districts', fields: { weather: 'Sunny', low: 21 } }],
        },
        view: { mode: 'table', display: ['weather', 'low'] },
      });

      const operationsBefore = (await runtime.workspace.store.operations()).length;
      const first = await jsonCommand(root, ['create', '--input', '-'], payload('Weather A', 'number'));
      expect(first.code).toBe(0);
      expect((await runtime.workspace.store.operations()).length).toBe(operationsBefore + 1);
      const firstId = (first.data as { rootId: string }).rootId;
      const state = runtime.workspace.documentState();
      expect(state.nodes[firstId]).toMatchObject({ content: { text: 'Weather A' }, description: 'Sunny throughout.' });
      expect(state.nodes[firstId]!.children.map((id) => state.nodes[id]?.type)).toContain('viewDef');
      expect(Object.values(state.nodes).filter((node) => node.type === 'fieldDef' && node.content.text === 'Weather')).toHaveLength(1);
      expect(Object.values(state.nodes).filter((node) => node.type === 'fieldDef' && node.content.text === 'Night low (C)')).toHaveLength(1);

      const second = await jsonCommand(root, ['create', '--input', '-'], payload('Weather B', 'number'));
      expect(second.code).toBe(0);
      expect((await runtime.workspace.store.operations()).length).toBe(operationsBefore + 2);
      expect(Object.values(runtime.workspace.documentState().nodes)
        .filter((node) => node.type === 'fieldDef' && node.content.text === 'Night low (C)')).toHaveLength(1);

      const rejected = await jsonCommand(root, ['create', '--input', '-'], payload('Weather C', 'text'));
      expect(rejected.code).toBe(3);
      expect(rejected.error).toMatchObject({
        code: 'invalid_input',
        details: { existingId: expect.any(String), mismatches: [{ property: 'fieldType', requested: 'plain', actual: 'number' }] },
      });
      expect((await runtime.workspace.store.operations()).length).toBe(operationsBefore + 2);
      expect(Object.values(runtime.workspace.documentState().nodes)
        .some((node) => node.content.text === 'Weather C')).toBe(false);
    } finally {
      await runtime.stop();
    }
  });

  test('creates rich, tagged, and referenced Nodes without introducing presentation-specific data types', async () => {
    const root = await makeRoot();
    const runtime = await OutlineRuntimeServer.start({ root, contentRoot: `${root}-content`, idleTimeoutMs: 60_000 });
    expect(runtime).not.toBeNull();
    if (!runtime) return;
    try {
      expect((await jsonCommand(root, ['define', 'create', '--input', '-'], JSON.stringify({
        kind: 'tag', name: 'Research',
      }))).code).toBe(0);
      const reference = await jsonCommand(root, ['create', '@library', 'Canonical source']);
      const referenceId = (reference.data as { rootId: string }).rootId;
      const tagId = Object.values(runtime.workspace.documentState().nodes)
        .find((node) => node.type === 'tagDef' && node.content.text === 'Research')!.id;

      const result = await jsonCommand(root, ['create', '--input', '-'], JSON.stringify({
        at: { parent: '@library' },
        node: {
          text: {
            text: 'Rich research note',
            marks: [{ start: 0, end: 4, type: 'bold' }],
            inlineRefs: [{ offset: 5, target: { kind: 'node', nodeId: referenceId } }],
          },
          tags: [tagId],
          children: [{ text: 'Source reference', reference: referenceId }],
        },
        view: { mode: 'cards' },
      }));
      expect(result.code).toBe(0);
      const ownerId = (result.data as { rootId: string }).rootId;
      const state = runtime.workspace.documentState();
      expect(state.nodes[ownerId]).toMatchObject({
        content: {
          text: 'Rich research note',
          marks: [{ start: 0, end: 4, type: 'bold' }],
          inlineRefs: [{ offset: 5, target: { kind: 'node', nodeId: referenceId } }],
        },
        tags: [tagId],
      });
      const referenceNode = state.nodes[ownerId]!.children.map((id) => state.nodes[id])
        .find((node) => node?.type === 'reference');
      expect(referenceNode).toMatchObject({ targetId: referenceId });
      expect(state.nodes[ownerId]!.children.map((id) => state.nodes[id]))
        .toContainEqual(expect.objectContaining({ type: 'viewDef', viewMode: 'cards' }));
    } finally {
      await runtime.stop();
    }
  });

  test('uses one normalized Diff/apply kernel across content and lifecycle commands', async () => {
    const root = await makeRoot();
    const runtime = await OutlineRuntimeServer.start({ root, contentRoot: `${root}-content`, idleTimeoutMs: 60_000 });
    expect(runtime).not.toBeNull();
    if (!runtime) return;
    try {
      const preview = await jsonCommand(root, ['create', '@today', 'Porcelain item', '--bind', 'created', '--preview']);
      expect(preview.code).toBe(0);
      const diff = preview.data as Diff;
      const nodeId = diff.bindings.created?.[0];
      expect(nodeId).toBeDefined();
      expect(runtime.workspace.documentState().nodes[nodeId!]).toBeUndefined();

      const direct = await jsonCommand(root, ['preview', '--input', '-'], JSON.stringify(diff.normalizedChangeSet));
      expect(direct.code).toBe(0);
      expect(direct.data).toEqual(diff);

      const applied = await jsonCommand(root, [
        'create', '@today', 'Porcelain item', '--bind', 'created', '--expect-diff', diff.diffHash,
        '--idempotency-key', diff.normalizedChangeSet.idempotencyKey!,
      ]);
      expect(applied.code).toBe(0);
      expect(applied.data).toMatchObject({ kind: 'outline.create-result', settlement: { diffHash: diff.diffHash } });
      expect(runtime.workspace.documentState().nodes[nodeId!]?.content.text).toBe('Porcelain item');

      expect((await jsonCommand(root, ['edit', nodeId!, '--description', 'Reviewed'])).code).toBe(0);
      expect(runtime.workspace.documentState().nodes[nodeId!]?.description).toBe('Reviewed');
      expect((await jsonCommand(root, ['edit', nodeId!, '--done', 'true'])).code).toBe(0);
      expect(runtime.workspace.documentState().nodes[nodeId!]?.completedAt).toBeGreaterThan(0);
      expect((await jsonCommand(root, ['edit', nodeId!, '--done', 'false'])).code).toBe(0);
      expect(runtime.workspace.documentState().nodes[nodeId!]?.completedAt ?? 0).toBe(0);

      expect((await jsonCommand(root, ['trash', nodeId!])).code).toBe(0);
      expect(runtime.workspace.documentState().nodes[nodeId!]?.parentId).toBe('trash');
      expect((await jsonCommand(root, ['restore', nodeId!])).code).toBe(0);
      expect(runtime.workspace.documentState().nodes[nodeId!]?.parentId).not.toBe('trash');
      expect((await jsonCommand(root, ['trash', nodeId!])).code).toBe(0);

      const purgePreview = await jsonCommand(root, ['purge', nodeId!, '--preview']);
      expect(purgePreview.code).toBe(0);
      const purgeDiff = purgePreview.data as Diff;
      const yesAlone = await jsonCommand(root, ['purge', nodeId!, '--yes']);
      expect(yesAlone.code).toBe(2);
      expect(yesAlone.error).toMatchObject({ code: 'invalid_input' });

      const unacknowledged = await jsonCommand(root, [
        'purge', nodeId!, '--expect-diff', purgeDiff.diffHash,
        '--idempotency-key', purgeDiff.normalizedChangeSet.idempotencyKey!,
      ]);
      expect(unacknowledged.code).toBe(4);
      expect(unacknowledged.error).toMatchObject({ code: 'confirmation_required' });
      expect(runtime.workspace.documentState().nodes[nodeId!]).toBeDefined();

      const purged = await jsonCommand(root, [
        'purge', nodeId!, '--expect-diff', purgeDiff.diffHash, '--yes',
        '--idempotency-key', purgeDiff.normalizedChangeSet.idempotencyKey!,
      ]);
      expect(purged.code).toBe(0);
      expect((purged.data as Operation).recovery.state).toBe('available');
      expect(runtime.workspace.documentState().nodes[nodeId!]).toBeUndefined();
    } finally {
      await runtime.stop();
    }
  });

  test('accepts a structured TargetSpec file without introducing fuzzy selection', async () => {
    const root = await makeRoot();
    const runtime = await OutlineRuntimeServer.start({ root, contentRoot: `${root}-content`, idleTimeoutMs: 60_000 });
    expect(runtime).not.toBeNull();
    if (!runtime) return;
    try {
      const targetPath = path.join(root, 'target.json');
      await Bun.write(targetPath, JSON.stringify({
        selector: { by: 'alias', alias: 'today' },
        cardinality: 'one',
      }));
      const result = await jsonCommand(root, ['create', '--parent', targetPath, 'Structured parent']);
      expect(result.code).toBe(0);
      expect(result.data).toMatchObject({ kind: 'outline.create-result', verification: { passed: true } });
      expect(runtime.workspace.projection().nodes).toContainEqual(
        expect.objectContaining({ content: expect.objectContaining({ text: 'Structured parent' }) }),
      );
    } finally {
      await runtime.stop();
    }
  });

  test('reviews and confirms the exact destructive Diff on a TTY', async () => {
    const root = await makeRoot();
    const runtime = await OutlineRuntimeServer.start({ root, contentRoot: `${root}-content`, idleTimeoutMs: 60_000 });
    expect(runtime).not.toBeNull();
    if (!runtime) return;
    try {
      const acceptedId = await createTrashedNode(root, runtime, 'TTY accepted purge');
      const accepted = await humanCommand(root, ['purge', acceptedId], async () => true);
      expect(accepted.code).toBe(0);
      expect(accepted.stdout).toContain('Review Diff:');
      expect(accepted.stdout).toContain('"kind": "outline.diff"');
      expect(accepted.prompts).toEqual([expect.stringContaining('Apply destructive purge Diff')]);
      expect(runtime.workspace.documentState().nodes[acceptedId]).toBeUndefined();

      const rejectedId = await createTrashedNode(root, runtime, 'TTY rejected purge');
      const rejected = await humanCommand(root, ['purge', rejectedId], async () => false);
      expect(rejected.code).toBe(4);
      expect(rejected.stderr).toContain('not confirmed');
      expect(runtime.workspace.documentState().nodes[rejectedId]).toBeDefined();

      const staleId = await createTrashedNode(root, runtime, 'TTY stale purge');
      const stale = await humanCommand(root, ['purge', staleId], async () => {
        expect((await jsonCommand(root, ['create', '@today', 'Concurrent TTY write'])).code).toBe(0);
        return true;
      });
      expect(stale.code).toBe(3);
      expect(stale.stderr).toContain('revision changed');
      expect(runtime.workspace.documentState().nodes[staleId]).toBeDefined();
    } finally {
      await runtime.stop();
    }
  });

  test('bounds text replacement, rejects consumed inline references, and invalidates stale plans', async () => {
    const root = await makeRoot();
    const runtime = await OutlineRuntimeServer.start({ root, contentRoot: `${root}-content`, idleTimeoutMs: 60_000 });
    expect(runtime).not.toBeNull();
    if (!runtime) return;
    try {
      const reference = await jsonCommand(root, ['create', '@library', 'Reference target']);
      const referenceId = (reference.data as { rootId: string }).rootId;
      const rich = await jsonCommand(root, ['transact', '--input', '-'], JSON.stringify({
        protocolVersion: 1,
        kind: 'outline.changeset',
        operations: [{
          op: 'create',
          placement: { kind: 'last', parent: { target: { selector: { by: 'alias', alias: 'library' }, cardinality: 'one' } } },
          nodes: [{ content: { text: 'alpha keyword omega', marks: [], inlineRefs: [{ offset: 10, target: { kind: 'node', nodeId: referenceId } }] }, children: [] }],
          bind: 'created',
        }],
        return: [{ kind: 'node', targets: { binding: 'created' }, page: { limit: 1 } }],
      }));
      const richId = returnedIds(rich.data)[0]!;
      const consumedReference = await jsonCommand(root, [
        'replace', 'text', richId, '--find', 'keyword', '--with', 'term', '--preview',
      ]);
      expect(consumedReference.code).toBe(2);
      expect(consumedReference.error).toMatchObject({ code: 'invalid_input' });
      expect(JSON.stringify(consumedReference.error)).toContain('inline reference');
      expect(runtime.workspace.documentState().nodes[richId]?.content.text).toBe('alpha keyword omega');

      const repeated = await jsonCommand(root, ['create', '@library', 'x x x']);
      const repeatedId = (repeated.data as { rootId: string }).rootId;
      const overBound = await jsonCommand(root, [
        'replace', 'text', repeatedId, '--find', 'x', '--with', 'y',
        '--max-replacements', '2', '--preview',
      ]);
      expect(overBound.code).toBe(2);
      expect(JSON.stringify(overBound.error)).toContain('exceeding maxReplacements 2');

      const preview = await jsonCommand(root, [
        'replace', 'text', repeatedId, '--find', 'x', '--with', 'y', '--preview',
      ]);
      expect(preview.code).toBe(0);
      expect((preview.data as Diff).destructive).toEqual([{ kind: 'replace', targetCount: 1 }]);
      expect(JSON.stringify((preview.data as Diff).normalizedChangeSet.operations)).toContain('"review":{"destructive":"replace"}');
      expect((await jsonCommand(root, ['create', '@library', 'Concurrent write'])).code).toBe(0);
      const stale = await jsonCommand(root, [
        'replace', 'text', repeatedId, '--find', 'x', '--with', 'y',
        '--expect-diff', (preview.data as Diff).diffHash, '--yes',
        '--idempotency-key', (preview.data as Diff).normalizedChangeSet.idempotencyKey!,
      ]);
      expect(stale.code).toBe(3);
      expect(stale.error).toMatchObject({ code: 'diff_mismatch' });
      expect(runtime.workspace.documentState().nodes[repeatedId]?.content.text).toBe('x x x');
    } finally {
      await runtime.stop();
    }
  });

  test('expresses exact create, move, and duplicate placement through argv and exactly reverts each mutation', async () => {
    const root = await makeRoot();
    const runtime = await OutlineRuntimeServer.start({ root, contentRoot: `${root}-content`, idleTimeoutMs: 60_000 });
    expect(runtime).not.toBeNull();
    if (!runtime) return;
    try {
      expect((await jsonCommand(root, ['create', '--input', '-'], JSON.stringify({
        at: { parent: '@library' },
        node: {
          text: 'Placement fixture',
          children: [
            semanticTree('Placement source', [semanticTree('A'), semanticTree('B'), semanticTree('C')]),
            semanticTree('Placement destination', [semanticTree('X'), semanticTree('Y')]),
          ],
        },
      }))).code).toBe(0);
      const sourceId = nodeIdByText(runtime, 'Placement source');
      const destinationId = nodeIdByText(runtime, 'Placement destination');
      const aId = nodeIdByText(runtime, 'A');
      const bId = nodeIdByText(runtime, 'B');
      const cId = nodeIdByText(runtime, 'C');

      await mutateAndRevert(root, runtime, ['create', '--before', bId, 'Before B'], (operation) => {
        expect(childTexts(runtime, sourceId)).toEqual(['A', 'Before B', 'B', 'C']);
      });
      await mutateAndRevert(root, runtime, ['create', '--after', bId, 'After B'], (operation) => {
        expect(childTexts(runtime, sourceId)).toEqual(['A', 'B', 'After B', 'C']);
      });
      await mutateAndRevert(root, runtime, ['move', bId, '--previous'], () => {
        expect(childTexts(runtime, sourceId)).toEqual(['B', 'A', 'C']);
      });
      await mutateAndRevert(root, runtime, ['move', bId, '--next'], () => {
        expect(childTexts(runtime, sourceId)).toEqual(['A', 'C', 'B']);
      });
      await mutateAndRevert(root, runtime, ['move', bId, destinationId, '--first'], () => {
        expect(childTexts(runtime, destinationId)).toEqual(['B', 'X', 'Y']);
      });
      await mutateAndRevert(root, runtime, ['move', bId, destinationId, '--last'], () => {
        expect(childTexts(runtime, destinationId)).toEqual(['X', 'Y', 'B']);
      });
      await mutateAndRevert(root, runtime, ['move', bId, destinationId, '--index', '1'], () => {
        expect(childTexts(runtime, destinationId)).toEqual(['X', 'B', 'Y']);
      });
      await mutateAndRevert(root, runtime, ['duplicate', cId, '--previous'], (operation) => {
        const copyId = returnedIds(operation)[0]!;
        expect(documentChildIds(runtime, sourceId)).toEqual([aId, bId, copyId, cId]);
      });
      await mutateAndRevert(root, runtime, ['duplicate', cId, '--next'], (operation) => {
        const copyId = returnedIds(operation)[0]!;
        expect(documentChildIds(runtime, sourceId)).toEqual([aId, bId, cId, copyId]);
      });
    } finally {
      await runtime.stop();
    }
  });

  test('keeps retarget and content-to-reference replacement distinct and exactly reversible', async () => {
    const root = await makeRoot();
    const runtime = await OutlineRuntimeServer.start({ root, contentRoot: `${root}-content`, idleTimeoutMs: 60_000 });
    expect(runtime).not.toBeNull();
    if (!runtime) return;
    try {
      expect((await jsonCommand(root, ['create', '--input', '-'], JSON.stringify({
        at: { parent: '@library' },
        node: {
          text: 'Reference fixture',
          children: [
            semanticTree('Reference replacement parent', [semanticTree('Original subtree', [semanticTree('Original child')])]),
            semanticTree('Canonical reference target'),
          ],
        },
      }))).code).toBe(0);
      const parentId = nodeIdByText(runtime, 'Reference replacement parent');
      const originalId = nodeIdByText(runtime, 'Original subtree');
      const originalChildId = nodeIdByText(runtime, 'Original child');
      const canonicalId = nodeIdByText(runtime, 'Canonical reference target');
      const operationCount = (await runtime.workspace.store.operations()).length;

      const invalidRetarget = await jsonCommand(root, ['edit', '--input', '-'], JSON.stringify({
        target: originalId,
        references: [{ action: 'retarget', target: canonicalId }],
      }));
      expect(invalidRetarget).toMatchObject({ code: 3, error: { code: 'precondition_failed' } });
      expect((await runtime.workspace.store.operations()).length).toBe(operationCount);
      expect(runtime.workspace.documentState().nodes[originalId]?.parentId).toBe(parentId);

      await mutateAndRevert(root, runtime, ['edit', '--input', '-'], () => {
        const state = runtime.workspace.documentState();
        expect(state.nodes[originalId]).toMatchObject({ parentId: 'trash', trashedFromParentId: parentId });
        expect(state.nodes[originalChildId]?.parentId).toBe(originalId);
        expect(state.nodes[parentId]?.children.map((id) => state.nodes[id])).toContainEqual(
          expect.objectContaining({ type: 'reference', targetId: canonicalId }),
        );
      }, JSON.stringify({ target: originalId, references: [{ action: 'replace', target: canonicalId }] }));

      const invalidInline = await jsonCommand(root, ['edit', '--input', '-'], JSON.stringify({
        target: originalId,
        references: [{ action: 'inline', target: 'node:missing' }],
      }));
      expect(invalidInline.code).not.toBe(0);
      expect((await runtime.workspace.store.operations()).length).toBe(operationCount + 2);
      expect(runtime.workspace.documentState().nodes[originalId]?.parentId).toBe(parentId);

      await mutateAndRevert(root, runtime, ['edit', '--input', '-'], () => {
        const state = runtime.workspace.documentState();
        expect(state.nodes[originalId]).toMatchObject({ parentId: 'trash', trashedFromParentId: parentId });
        expect(state.nodes[parentId]?.children.map((id) => state.nodes[id])).toContainEqual(
          expect.objectContaining({
            content: expect.objectContaining({
              inlineRefs: [expect.objectContaining({ target: { kind: 'node', nodeId: canonicalId } })],
            }),
          }),
        );
      }, JSON.stringify({ target: originalId, references: [{ action: 'inline', target: canonicalId }] }));

      expect((await jsonCommand(root, ['edit', '--input', '-'], JSON.stringify({
        target: parentId,
        references: [{ action: 'add', target: canonicalId }],
      }))).code).toBe(0);
      expect(Object.values(runtime.workspace.documentState().nodes)).toContainEqual(
        expect.objectContaining({ type: 'reference', parentId, targetId: canonicalId }),
      );
    } finally {
      await runtime.stop();
    }
  });

  test('rejects undeclared Field keys and returns the effective Outline View without writing', async () => {
    const root = await makeRoot();
    const runtime = await OutlineRuntimeServer.start({ root, contentRoot: `${root}-content`, idleTimeoutMs: 60_000 });
    expect(runtime).not.toBeNull();
    if (!runtime) return;
    try {
      const before = JSON.parse(JSON.stringify(runtime.workspace.documentState())) as unknown;
      const invalid = await jsonCommand(root, ['create', '--input', '-'], JSON.stringify({
        at: { parent: '@library' },
        fields: [{ key: 'known', name: 'Known', type: 'text' }],
        node: { text: 'Invalid table', children: [{ text: 'Item', fields: { missing: 'value' } }] },
        view: { mode: 'table', display: ['known'] },
      }));
      expect(invalid.code).toBe(2);
      expect(JSON.stringify(invalid.error)).toContain('undeclared field key: missing');
      expect(runtime.workspace.documentState()).toEqual(before);

      const plain = await jsonCommand(root, ['create', '@library', 'Plain owner']);
      const inspection = await jsonCommand(root, ['view', 'get', (plain.data as { rootId: string }).rootId]);
      expect(inspection.code).toBe(0);
      expect(inspection.data).toMatchObject({ mode: 'outline', displayFieldCount: 0 });
    } finally {
      await runtime.stop();
    }
  });

  test('switches every View mode without changing Node identity, tree structure, or Field values', async () => {
    const root = await makeRoot();
    const runtime = await OutlineRuntimeServer.start({ root, contentRoot: `${root}-content`, idleTimeoutMs: 60_000 });
    expect(runtime).not.toBeNull();
    if (!runtime) return;
    try {
      const created = await jsonCommand(root, ['create', '--input', '-'], JSON.stringify({
        at: { parent: '@library' },
        fields: [{ key: 'status', name: 'View invariant status', type: 'text' }],
        node: { text: 'View invariant owner', children: [{ text: 'Stable item', fields: { status: 'Ready' } }] },
        view: { mode: 'table', display: ['status'] },
      }));
      const ownerId = (created.data as { rootId: string }).rootId;
      const dataSnapshot = () => {
        const state = runtime.workspace.documentState();
        const viewTypes = new Set(['viewDef', 'sortRule', 'filterRule', 'displayField']);
        return Object.values(state.nodes)
          .filter((node) => !viewTypes.has(node.type))
          .map((node) => ({
            id: node.id,
            parentId: node.parentId,
            type: node.type,
            content: node.content,
            fieldDefId: node.fieldDefId,
            children: node.children.filter((id) => !viewTypes.has(state.nodes[id]?.type ?? '')),
          }))
          .sort((left, right) => left.id.localeCompare(right.id));
      };
      const before = dataSnapshot();
      for (const mode of ['cards', 'calendar', 'outline', 'table'] as const) {
        const result = await jsonCommand(root, ['view', 'set', ownerId, mode]);
        expect(result.code).toBe(0);
        expect(dataSnapshot()).toEqual(before);
        expect((await jsonCommand(root, ['view', 'get', ownerId])).data).toMatchObject({ mode });
      }
    } finally {
      await runtime.stop();
    }
  });

  test('converges Source membership through edit without exposing storage choreography', async () => {
    const root = await makeRoot();
    const runtime = await OutlineRuntimeServer.start({ root, contentRoot: `${root}-content`, idleTimeoutMs: 60_000 });
    expect(runtime).not.toBeNull();
    if (!runtime) return;
    try {
      const created = await jsonCommand(root, ['create', '@library', 'Source owner']);
      const ownerId = (created.data as { rootId: string }).rootId;
      expect((await jsonCommand(root, ['edit', '--input', '-'], JSON.stringify({
        target: ownerId,
        sources: [
          { action: 'add', text: 'https://example.com/a' },
          { action: 'add', text: 'https://example.com/b' },
        ],
      }))).code).toBe(0);
      const sourceValues = () => Object.values(runtime.workspace.documentState().nodes)
        .filter((node) => node.parentId !== undefined && node.content.text.startsWith('https://example.com/'));
      expect(sourceValues().map((node) => node.content.text).sort()).toEqual([
        'https://example.com/a', 'https://example.com/b',
      ]);
      const first = sourceValues().find((node) => node.content.text.endsWith('/a'))!;
      expect((await jsonCommand(root, ['edit', '--input', '-'], JSON.stringify({
        target: ownerId,
        sources: [{ action: 'replace', value: first.id, text: 'https://example.com/c' }],
      }))).code).toBe(0);
      expect(sourceValues().map((node) => node.content.text).sort()).toEqual([
        'https://example.com/b', 'https://example.com/c',
      ]);
      expect((await jsonCommand(root, ['edit', '--input', '-'], JSON.stringify({
        target: ownerId, sources: [{ action: 'clear' }],
      }))).code).toBe(0);
      expect(sourceValues()).toHaveLength(0);
    } finally {
      await runtime.stop();
    }
  });

  test('creates 10,000 Nodes with one Operation and a bounded semantic receipt', async () => {
    const root = await makeRoot();
    const runtime = await OutlineRuntimeServer.start({ root, contentRoot: `${root}-content`, idleTimeoutMs: 60_000 });
    expect(runtime).not.toBeNull();
    if (!runtime) return;
    try {
      const input = JSON.stringify({
        at: { parent: '@library' },
        node: {
          text: 'Large Node tree',
          children: Array.from({ length: 10_000 }, (_, index) => ({ text: `Item ${index} "quoted" \\ slash` })),
        },
        view: { mode: 'table', display: ['sys:name'] },
      });
      expect(Buffer.byteLength(input)).toBeGreaterThan(256 * 1024);
      const operationsBefore = (await runtime.workspace.store.operations()).length;
      const result = await jsonCommand(root, ['create', '--input', '-'], input);
      expect(result.code).toBe(0);
      expect((await runtime.workspace.store.operations()).length).toBe(operationsBefore + 1);
      const ownerId = (result.data as { rootId: string }).rootId;
      expect(Buffer.byteLength(JSON.stringify(result.data))).toBeLessThan(4 * 1024);
      const state = runtime.workspace.documentState();
      const itemCount = state.nodes[ownerId]!.children.filter((id) => state.nodes[id]?.type !== 'viewDef').length;
      expect(itemCount).toBe(10_000);
    } finally {
      await runtime.stop();
    }
  }, 30_000);
});

function returnedIds(value: unknown): string[] {
  const record = value as { settlement?: { result?: Array<{ nodes?: unknown[] }> }; result?: Array<{ nodes?: unknown[] }> } | undefined;
  const result = record?.settlement?.result ?? record?.result;
  return (result?.[0]?.nodes ?? []).flatMap((node) => (
    node && typeof node === 'object' && typeof (node as { id?: unknown }).id === 'string'
      ? [(node as { id: string }).id]
      : []
  ));
}

async function mutateAndRevert(
  root: string,
  runtime: OutlineRuntimeServer,
  args: readonly string[],
  assertApplied: (operation: Operation) => void,
  stdin = '',
): Promise<void> {
  const before = JSON.parse(JSON.stringify(runtime.workspace.documentState())) as unknown;
  const operationCount = (await runtime.workspace.store.operations()).length;
      const result = await jsonCommand(root, args, stdin);
  expect(result.code).toBe(0);
  const operation = ((result.data as { settlement?: Operation } | undefined)?.settlement ?? result.data) as Operation;
  const operationId = operation.operationId;
  expect(typeof operationId).toBe('string');
  expect(operation).toMatchObject({
    kind: expect.stringMatching(/^outline\.operation(?:-settlement)?$/),
    operationId: expect.any(String),
    affectedNodeCount: expect.any(Number),
    recovery: { state: 'available' },
  });
  expect((await runtime.workspace.store.operations()).length).toBe(operationCount + 1);
  assertApplied(operation);

  const reverted = await jsonCommand(root, ['revert', operationId]);
  expect(reverted).toMatchObject({ code: 0 });
  expect(reverted.data).toMatchObject({ kind: 'outline.operation', revertsOperationId: operation.operationId });
  expect(runtime.workspace.documentState()).toEqual(before);
}

function childTexts(runtime: OutlineRuntimeServer, parentId: string): string[] {
  const state = runtime.workspace.documentState();
  return documentChildIds(runtime, parentId).map((id) => state.nodes[id]!.content.text);
}

function documentChildIds(runtime: OutlineRuntimeServer, parentId: string): string[] {
  return runtime.workspace.documentState().nodes[parentId]!.children;
}

function nodeIdByText(runtime: OutlineRuntimeServer, text: string): string {
  const nodeId = Object.values(runtime.workspace.documentState().nodes)
    .find((node) => node.content.text === text)?.id;
  expect(nodeId).toBeDefined();
  return nodeId!;
}

interface SemanticTree {
  readonly text: string;
  readonly children?: readonly SemanticTree[];
}

function semanticTree(text: string, children: readonly SemanticTree[] = []): SemanticTree {
  return { text, ...(children.length > 0 ? { children } : {}) };
}

async function createTrashedNode(
  root: string,
  runtime: OutlineRuntimeServer,
  text: string,
): Promise<string> {
  expect((await jsonCommand(root, ['create', '@today', text])).code).toBe(0);
  const nodeId = Object.values(runtime.workspace.documentState().nodes)
    .find((node) => node.content.text === text)?.id;
  expect(nodeId).toBeDefined();
  expect((await jsonCommand(root, ['trash', nodeId!])).code).toBe(0);
  return nodeId!;
}

async function humanCommand(
  root: string,
  args: readonly string[],
  confirm: (prompt: string) => Promise<boolean>,
): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string; readonly prompts: readonly string[] }> {
  let stdout = '';
  let stderr = '';
  const prompts: string[] = [];
  const code = await runOutlineCli(['--no-start', ...args], {
    runtimeRoot: root,
    io: {
      stdout: (value) => { stdout += value; },
      stderr: (value) => { stderr += value; },
      interactive: true,
      confirm: async (prompt) => {
        prompts.push(prompt);
        return confirm(prompt);
      },
    },
  });
  return { code, stdout, stderr, prompts };
}

async function jsonCommand(root: string, args: readonly string[], stdin = ''): Promise<{
  code: number;
  data?: unknown;
  error?: unknown;
}> {
  let stdout = '';
  const code = await runOutlineCli(['--json', '--no-start', ...args], {
    runtimeRoot: root,
    io: {
      stdout: (value) => { stdout += value; },
      stderr: () => undefined,
      readStdin: async () => stdin,
      stdinBytes: () => (async function* () { yield Buffer.from(stdin); })(),
    },
  });
  const response = JSON.parse(stdout) as { data?: unknown; error?: unknown };
  return { code, ...response };
}

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'tenon-outline-porcelain-'));
  roots.push(root);
  return root;
}
