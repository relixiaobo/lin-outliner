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
  test('uses one normalized Diff/apply kernel across content and lifecycle commands', async () => {
    const root = await makeRoot();
    const runtime = await OutlineRuntimeServer.start({ root, contentRoot: `${root}-content`, idleTimeoutMs: 60_000 });
    expect(runtime).not.toBeNull();
    if (!runtime) return;
    try {
      const preview = await jsonCommand(root, ['add', '@today', 'Porcelain item', '--bind', 'created', '--preview']);
      expect(preview.code).toBe(0);
      const diff = preview.data as Diff;
      const nodeId = diff.bindings.created?.[0];
      expect(nodeId).toBeDefined();
      expect(runtime.workspace.documentState().nodes[nodeId!]).toBeUndefined();

      const direct = await jsonCommand(root, ['diff', '--input', '-'], JSON.stringify(diff.normalizedChangeSet));
      expect(direct.code).toBe(0);
      expect(direct.data).toEqual(diff);

      const applied = await jsonCommand(root, [
        'add', '@today', 'Porcelain item', '--bind', 'created', '--expect-diff', diff.diffHash,
        '--idempotency-key', diff.normalizedChangeSet.idempotencyKey!,
      ]);
      expect(applied.code).toBe(0);
      expect(applied.data).toMatchObject({ kind: 'outline.operation', diffHash: diff.diffHash });
      expect(runtime.workspace.documentState().nodes[nodeId!]?.content.text).toBe('Porcelain item');

      expect((await jsonCommand(root, ['set', nodeId!, '--description', 'Reviewed'])).code).toBe(0);
      expect(runtime.workspace.documentState().nodes[nodeId!]?.description).toBe('Reviewed');
      expect((await jsonCommand(root, ['done', 'set', nodeId!, 'true'])).code).toBe(0);
      expect(runtime.workspace.documentState().nodes[nodeId!]?.completedAt).toBeGreaterThan(0);
      expect((await jsonCommand(root, ['done', 'cycle', nodeId!])).code).toBe(0);
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
      const result = await jsonCommand(root, ['add', '--parent', targetPath, 'Structured parent']);
      expect(result.code).toBe(0);
      expect(result.data).toMatchObject({ kind: 'outline.operation' });
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
        expect((await jsonCommand(root, ['add', '@today', 'Concurrent TTY write'])).code).toBe(0);
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
      const reference = await jsonCommand(root, ['add', '@library', 'Reference target']);
      const referenceId = returnedIds(reference.data)[0]!;
      const rich = await jsonCommand(root, ['add', '--input', '-'], JSON.stringify({
        placement: {
          kind: 'last',
          parent: { target: { selector: { by: 'alias', alias: 'library' }, cardinality: 'one' } },
        },
        nodes: [{
          content: {
            text: 'alpha keyword omega',
            marks: [],
            inlineRefs: [{ offset: 10, target: { kind: 'node', nodeId: referenceId } }],
          },
          children: [],
        }],
      }));
      const richId = returnedIds(rich.data)[0]!;
      const consumedReference = await jsonCommand(root, [
        'text', 'replace', richId, '--find', 'keyword', '--replace', 'term', '--preview',
      ]);
      expect(consumedReference.code).toBe(2);
      expect(consumedReference.error).toMatchObject({ code: 'invalid_input' });
      expect(JSON.stringify(consumedReference.error)).toContain('inline reference');
      expect(runtime.workspace.documentState().nodes[richId]?.content.text).toBe('alpha keyword omega');

      const repeated = await jsonCommand(root, ['add', '@library', 'x x x']);
      const repeatedId = returnedIds(repeated.data)[0]!;
      const overBound = await jsonCommand(root, [
        'text', 'replace', repeatedId, '--find', 'x', '--replace', 'y',
        '--max-replacements', '2', '--preview',
      ]);
      expect(overBound.code).toBe(2);
      expect(JSON.stringify(overBound.error)).toContain('exceeding maxReplacements 2');

      const preview = await jsonCommand(root, [
        'text', 'replace', repeatedId, '--find', 'x', '--replace', 'y', '--preview',
      ]);
      expect(preview.code).toBe(0);
      expect((preview.data as Diff).destructive).toEqual([{ kind: 'replace', targetCount: 1 }]);
      expect(JSON.stringify((preview.data as Diff).normalizedChangeSet.operations)).toContain('"review":{"destructive":"replace"}');
      expect((await jsonCommand(root, ['add', '@library', 'Concurrent write'])).code).toBe(0);
      const stale = await jsonCommand(root, [
        'text', 'replace', repeatedId, '--find', 'x', '--replace', 'y',
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
      expect((await jsonCommand(root, ['add', '--input', '-'], JSON.stringify({
        placement: {
          kind: 'last',
          parent: { target: { selector: { by: 'alias', alias: 'library' }, cardinality: 'one' } },
        },
        nodes: [
          tree('Placement source', [tree('A'), tree('B'), tree('C')]),
          tree('Placement destination', [tree('X'), tree('Y')]),
        ],
      }))).code).toBe(0);
      const sourceId = nodeIdByText(runtime, 'Placement source');
      const destinationId = nodeIdByText(runtime, 'Placement destination');
      const aId = nodeIdByText(runtime, 'A');
      const bId = nodeIdByText(runtime, 'B');
      const cId = nodeIdByText(runtime, 'C');

      await mutateAndRevert(root, runtime, ['add', '--before', bId, 'Before B'], (operation) => {
        expect(childTexts(runtime, sourceId)).toEqual(['A', 'Before B', 'B', 'C']);
        expect(returnedIds(operation)).toHaveLength(1);
      });
      await mutateAndRevert(root, runtime, ['add', '--after', bId, 'After B'], (operation) => {
        expect(childTexts(runtime, sourceId)).toEqual(['A', 'B', 'After B', 'C']);
        expect(returnedIds(operation)).toHaveLength(1);
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
      expect((await jsonCommand(root, ['add', '--input', '-'], JSON.stringify({
        placement: {
          kind: 'last',
          parent: { target: { selector: { by: 'alias', alias: 'library' }, cardinality: 'one' } },
        },
        nodes: [
          tree('Reference replacement parent', [tree('Original subtree', [tree('Original child')])]),
          tree('Canonical reference target'),
        ],
      }))).code).toBe(0);
      const parentId = nodeIdByText(runtime, 'Reference replacement parent');
      const originalId = nodeIdByText(runtime, 'Original subtree');
      const originalChildId = nodeIdByText(runtime, 'Original child');
      const canonicalId = nodeIdByText(runtime, 'Canonical reference target');
      const operationCount = (await runtime.workspace.store.operations()).length;

      const invalidRetarget = await jsonCommand(root, ['reference', 'set', originalId, canonicalId]);
      expect(invalidRetarget).toMatchObject({ code: 3, error: { code: 'precondition_failed' } });
      expect((await runtime.workspace.store.operations()).length).toBe(operationCount);
      expect(runtime.workspace.documentState().nodes[originalId]?.parentId).toBe(parentId);

      await mutateAndRevert(root, runtime, ['reference', 'replace', originalId, canonicalId], () => {
        const state = runtime.workspace.documentState();
        expect(state.nodes[originalId]).toMatchObject({ parentId: 'trash', trashedFromParentId: parentId });
        expect(state.nodes[originalChildId]?.parentId).toBe(originalId);
        expect(state.nodes[parentId]?.children.map((id) => state.nodes[id])).toContainEqual(
          expect.objectContaining({ type: 'reference', targetId: canonicalId }),
        );
      });

      const invalidInline = await jsonCommand(root, ['reference', 'inline', originalId]);
      expect(invalidInline).toMatchObject({
        code: 2,
        error: { code: 'invalid_input', message: expect.stringContaining('requires REFERENCE') },
      });
      expect((await runtime.workspace.store.operations()).length).toBe(operationCount + 2);
      expect(runtime.workspace.documentState().nodes[originalId]?.parentId).toBe(parentId);

      await mutateAndRevert(root, runtime, ['reference', 'inline', originalId, canonicalId], () => {
        const state = runtime.workspace.documentState();
        expect(state.nodes[originalId]).toMatchObject({ parentId: 'trash', trashedFromParentId: parentId });
        expect(state.nodes[parentId]?.children.map((id) => state.nodes[id])).toContainEqual(
          expect.objectContaining({
            content: expect.objectContaining({
              inlineRefs: [expect.objectContaining({ target: { kind: 'node', nodeId: canonicalId } })],
            }),
          }),
        );
      });

      expect((await jsonCommand(root, ['reference', 'add', parentId, canonicalId])).code).toBe(0);
      const referenceId = Object.values(runtime.workspace.documentState().nodes).find((node) => (
        node.type === 'reference' && node.parentId === parentId && node.targetId === canonicalId
      ))?.id;
      expect(referenceId).toBeDefined();
      await mutateAndRevert(root, runtime, ['reference', 'inline', referenceId!], () => {
        const state = runtime.workspace.documentState();
        expect(state.nodes[referenceId!]).toBeUndefined();
        expect(state.nodes[parentId]?.children.map((id) => state.nodes[id])).toContainEqual(
          expect.objectContaining({
            content: expect.objectContaining({
              inlineRefs: [expect.objectContaining({ target: { kind: 'node', nodeId: canonicalId } })],
            }),
          }),
        );
      });
    } finally {
      await runtime.stop();
    }
  });
});

function returnedIds(value: unknown): string[] {
  const result = (value as { result?: Array<{ nodes?: unknown[] }> } | undefined)?.result;
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
): Promise<void> {
  const before = JSON.parse(JSON.stringify(runtime.workspace.documentState())) as unknown;
  const operationCount = (await runtime.workspace.store.operations()).length;
  const result = await jsonCommand(root, args);
  expect(result.code).toBe(0);
  const operation = result.data as Operation;
  const operationId = operation.operationId;
  expect(typeof operationId).toBe('string');
  expect(operation).toMatchObject({
    kind: 'outline.operation',
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

interface TestTree {
  readonly content: { readonly text: string; readonly marks: readonly []; readonly inlineRefs: readonly [] };
  readonly children: readonly TestTree[];
}

function tree(text: string, children: readonly TestTree[] = []): TestTree {
  return { content: { text, marks: [], inlineRefs: [] }, children };
}

async function createTrashedNode(
  root: string,
  runtime: OutlineRuntimeServer,
  text: string,
): Promise<string> {
  expect((await jsonCommand(root, ['add', '@today', text])).code).toBe(0);
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
