import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runOutlineCli } from '../../src/outline/cli';
import type { Diff, NoChangeResult, Operation } from '../../src/outline/contract';
import { OutlineRuntimeServer } from '../../src/outline/runtime/server';

const roots: string[] = [];

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe('outline mandatory CLI golden flows', () => {
  test('1. creates a complete STRING_MATCH table Search in one invocation and exactly reverts it', async () => {
    await withRuntime(async ({ runtime, cli }) => {
      await cli.json(['add', '@library', 'module alpha']);
      await cli.json(['add', '@library', 'unrelated note']);
      const before = snapshot(runtime);
      const operationCount = await countOperations(runtime);
      const callCount = cli.calls;

      const operation = operationResult(await cli.json([
        'search', 'create', '--title', 'Modules', '--match', 'module',
        '--view', 'table', '--sort', 'sys:updatedAt:desc',
      ]));
      expect(cli.calls - callCount).toBe(1);
      expect(await countOperations(runtime)).toBe(operationCount + 1);
      const searchId = returnedIds(operation)[0]!;
      const state = runtime.workspace.documentState();
      expect(state.nodes[searchId]).toMatchObject({ type: 'search', parentId: 'searches', content: { text: 'Modules' } });
      expect(state.nodes[searchId]!.children.map((id) => state.nodes[id]).filter((node) => node?.type === 'reference'))
        .toContainEqual(expect.objectContaining({ targetId: expect.any(String) }));
      const view = state.nodes[searchId]!.children.map((id) => state.nodes[id]).find((node) => node?.type === 'viewDef');
      expect(view).toMatchObject({ type: 'viewDef', viewMode: 'table' });
      expect(view!.children.map((id) => state.nodes[id])).toContainEqual(expect.objectContaining({
        type: 'sortRule', sortField: 'sys:updatedAt', sortDirection: 'desc',
      }));
      await exactRevert(runtime, operation, before, cli);
    });
  });

  test('2. creates a complete Projects table through one ChangeSet, one Diff, and one apply', async () => {
    await withRuntime(async ({ runtime, cli }) => {
      const before = snapshot(runtime);
      const operationsBefore = await countOperations(runtime);
      const changeSet = {
        protocolVersion: 1,
        kind: 'outline.changeset',
        source: { kind: 'cli', label: 'Projects table golden flow' },
        operations: [
          { op: 'create', resource: 'definition', definitionType: 'field', name: 'Project Status', config: { fieldType: 'plain' }, bind: 'status' },
          { op: 'create', resource: 'definition', definitionType: 'field', name: 'Project Budget', config: { fieldType: 'number', minValue: 0 }, bind: 'budget' },
          { op: 'create', placement: { kind: 'last', parent: oneAlias('library') }, nodes: [draft('Projects')], bind: 'projects' },
          { op: 'create', placement: { kind: 'last', parent: { binding: 'projects' } }, nodes: [draft('Alpha')], bind: 'alpha' },
          { op: 'create', placement: { kind: 'last', parent: { binding: 'projects' } }, nodes: [draft('Beta')], bind: 'beta' },
          { op: 'update', targets: { binding: 'alpha' }, changes: [
            { kind: 'field', action: 'set', field: { binding: 'status' }, value: 'Active' },
            { kind: 'field', action: 'set', field: { binding: 'budget' }, value: 100 },
          ] },
          { op: 'update', targets: { binding: 'beta' }, changes: [
            { kind: 'field', action: 'set', field: { binding: 'status' }, value: 'Planned' },
            { kind: 'field', action: 'set', field: { binding: 'budget' }, value: 50 },
          ] },
          { op: 'update', targets: { binding: 'projects' }, changes: [{
            kind: 'view', property: 'configuration', action: 'set', view: {
              mode: 'table', group: { binding: 'status' }, replace: {
                sort: [{ field: 'sys:updatedAt', direction: 'desc' }],
                display: [{ field: 'sys:name' }, { field: { binding: 'status' } }, { field: { binding: 'budget' } }],
              },
            },
          }] },
        ],
        return: [{ kind: 'outline', targets: { binding: 'projects' }, depth: 2, include: ['children', 'fields', 'view'], page: { limit: 100 } }],
      };
      const callsBefore = cli.calls;
      const preview = diffResult(await cli.json(['diff', '--input', '-'], JSON.stringify(changeSet)));
      expect(runtime.workspace.documentState()).toEqual(before);
      const operation = operationResult(await cli.json(['apply', '--input', '-'], JSON.stringify(preview)));
      expect(cli.calls - callsBefore).toBe(2);
      expect(await countOperations(runtime)).toBe(operationsBefore + 1);
      const projectId = preview.bindings.projects![0]!;
      const state = runtime.workspace.documentState();
      const project = state.nodes[projectId]!;
      expect(project.children.map((id) => state.nodes[id]?.content.text)).toEqual(expect.arrayContaining(['Alpha', 'Beta']));
      const view = project.children.map((id) => state.nodes[id]).find((node) => node?.type === 'viewDef');
      expect(view).toMatchObject({ viewMode: 'table', groupField: preview.bindings.status![0] });
      expect(operation.result?.[0]?.nodes.length).toBeGreaterThanOrEqual(3);
      await exactRevert(runtime, operation, before, cli);
    });
  });

  test('3. creates definitions and consumes their bindings on new and existing Nodes in one ChangeSet', async () => {
    await withRuntime(async ({ runtime, cli }) => {
      const existingId = returnedIds(operationResult(await cli.json(['add', '@library', 'Existing target'])))[0]!;
      const before = snapshot(runtime);
      const changeSet = {
        protocolVersion: 1, kind: 'outline.changeset', operations: [
          { op: 'create', resource: 'definition', definitionType: 'tag', name: 'Bound Tag', config: { showCheckbox: true }, bind: 'tag' },
          { op: 'create', resource: 'definition', definitionType: 'field', name: 'Bound Field', config: { fieldType: 'plain' }, bind: 'field' },
          { op: 'create', placement: { kind: 'last', parent: oneAlias('library') }, nodes: [draft('New target')], bind: 'created' },
          { op: 'update', targets: { binding: 'created' }, changes: [
            { kind: 'tag', action: 'add', tag: { binding: 'tag' } },
            { kind: 'field', action: 'set', field: { binding: 'field' }, value: 'new value' },
          ] },
          { op: 'update', targets: oneId(existingId), changes: [
            { kind: 'tag', action: 'add', tag: { binding: 'tag' } },
            { kind: 'field', action: 'set', field: { binding: 'field' }, value: 'existing value' },
          ] },
        ],
      };
      const settled = await diffApply(cli, changeSet);
      const state = runtime.workspace.documentState();
      const tagId = settled.diff.bindings.tag![0]!;
      const fieldId = settled.diff.bindings.field![0]!;
      for (const nodeId of [existingId, settled.diff.bindings.created![0]!]) {
        expect(state.nodes[nodeId]?.tags).toContain(tagId);
        expect(Object.values(state.nodes)).toContainEqual(expect.objectContaining({ type: 'fieldEntry', parentId: nodeId, fieldDefId: fieldId }));
      }
      await exactRevert(runtime, settled.operation, before, cli);
    });
  });

  test('4. ensures a date and creates a complete typed tree below its binding without an ID lookup', async () => {
    await withRuntime(async ({ runtime, cli }) => {
      const before = snapshot(runtime);
      const changeSet = {
        protocolVersion: 1, kind: 'outline.changeset', operations: [
          { op: 'ensure', resource: 'date', date: '2041-02-03', bind: 'date' },
          { op: 'create', placement: { kind: 'last', parent: { binding: 'date' } }, nodes: [draft('Daily tree', {
            description: 'Typed root', checkbox: true, done: true,
            children: [draft('const value = 1', { type: 'codeBlock', codeLanguage: 'typescript' })],
          })], bind: 'tree' },
        ],
      };
      const settled = await diffApply(cli, changeSet);
      const state = runtime.workspace.documentState();
      const rootId = settled.diff.bindings.tree![0]!;
      expect(state.nodes[rootId]).toMatchObject({
        parentId: settled.diff.bindings.date![0], description: 'Typed root',
      });
      expect(typeof state.nodes[rootId]!.completedAt).toBe('number');
      expect(state.nodes[rootId]!.completedAt).toBeGreaterThan(0);
      expect(state.nodes[state.nodes[rootId]!.children[0]!]).toMatchObject({ type: 'codeBlock', codeLanguage: 'typescript' });
      await exactRevert(runtime, settled.operation, before, cli);
    });
  });

  test('5. captures a typed tree to an ensured date with provenance in one invocation', async () => {
    await withRuntime(async ({ runtime, cli }) => {
      const before = snapshot(runtime);
      const callsBefore = cli.calls;
      const operation = operationResult(await cli.json([
        'capture', 'add', '--date', '2042-03-04', '--title', 'Captured article',
        '--metadata', JSON.stringify(captureProvenance()),
        '--tree', JSON.stringify([draft('Captured body', { description: 'Snapshot' })]),
      ]));
      expect(cli.calls - callsBefore).toBe(1);
      const captureId = returnedIds(operation)[0]!;
      const capture = runtime.workspace.documentState().nodes[captureId]!;
      expect(capture.capture).toMatchObject({ captureId: 'capture:golden', providerId: 'generic-webpage' });
      expect(runtime.workspace.documentState().nodes[capture.children[0]!]).toMatchObject({ content: { text: 'Captured body' } });
      await exactRevert(runtime, operation, before, cli);
    });
  });

  test('6. stages and adds a local image in one invocation, retains the asset, and reverts the Node', async () => {
    await withRuntime(async ({ root, runtime, cli }) => {
      const imagePath = path.join(root, 'pixel.png');
      await Bun.write(imagePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));
      const before = snapshot(runtime);
      const operationsBefore = await countOperations(runtime);
      const callsBefore = cli.calls;
      const operation = operationResult(await cli.json(['media', 'add', '@library', 'image', imagePath, '--name', 'Pixel']));
      expect(cli.calls - callsBefore).toBe(1);
      expect(await countOperations(runtime)).toBe(operationsBefore + 1);
      const mediaId = returnedIds(operation)[0]!;
      const assetId = runtime.workspace.documentState().nodes[mediaId]?.assetId;
      expect(assetId).toBeDefined();
      expect(await runtime.workspace.assets.show(assetId!)).toMatchObject({ assetId });
      await exactRevert(runtime, operation, before, cli);
      expect(await runtime.workspace.assets.show(assetId!)).toMatchObject({ assetId });
    });
  });

  test('7. applies done, tag, and field changes to a bounded many query selector', async () => {
    await withRuntime(async ({ runtime, cli }) => {
      for (const text of ['Batch target A', 'Batch target B', 'Batch target C']) await cli.json(['add', '@library', text]);
      const before = snapshot(runtime);
      const targets = {
        target: {
          selector: { by: 'query', query: { kind: 'rule', op: 'STRING_MATCH', text: 'Batch target' }, order: 'document', limit: 2 },
          cardinality: 'many', max: 2,
        },
      };
      const changeSet = {
        protocolVersion: 1, kind: 'outline.changeset', operations: [
          { op: 'create', resource: 'definition', definitionType: 'tag', name: 'Batch Tag', bind: 'tag' },
          { op: 'create', resource: 'definition', definitionType: 'field', name: 'Batch Field', config: { fieldType: 'plain' }, bind: 'field' },
          { op: 'update', targets, changes: [
            { kind: 'done', value: true },
            { kind: 'tag', action: 'add', tag: { binding: 'tag' } },
            { kind: 'field', action: 'set', field: { binding: 'field' }, value: 'bounded' },
          ] },
        ],
      };
      const settled = await diffApply(cli, changeSet);
      const changedTargets = Object.values(runtime.workspace.documentState().nodes)
        .filter((node) => node.content.text.startsWith('Batch target') && node.completedAt > 0);
      expect(changedTargets).toHaveLength(2);
      await exactRevert(runtime, settled.operation, before, cli);
    });
  });

  test('8. creates two Nodes and cross-references them through ChangeSet bindings', async () => {
    await withRuntime(async ({ runtime, cli }) => {
      const before = snapshot(runtime);
      const changeSet = {
        protocolVersion: 1, kind: 'outline.changeset', operations: [
          { op: 'create', placement: { kind: 'last', parent: oneAlias('library') }, nodes: [draft('Node A')], bind: 'a' },
          { op: 'create', placement: { kind: 'last', parent: oneAlias('library') }, nodes: [draft('Node B')], bind: 'b' },
          { op: 'update', targets: { binding: 'a' }, changes: [{ kind: 'reference', action: 'add', target: { binding: 'b' } }] },
        ],
      };
      const settled = await diffApply(cli, changeSet);
      const state = runtime.workspace.documentState();
      const a = settled.diff.bindings.a![0]!;
      const b = settled.diff.bindings.b![0]!;
      expect(a).not.toBe(b);
      expect(state.nodes[a]!.children.map((id) => state.nodes[id])).toContainEqual(expect.objectContaining({ type: 'reference', targetId: b }));
      await exactRevert(runtime, settled.operation, before, cli);
    });
  });

  test('9. previews and applies template backfill as one Operation', async () => {
    await withRuntime(async ({ runtime, cli }) => {
      const setup = await diffApply(cli, {
        protocolVersion: 1, kind: 'outline.changeset', operations: [
          { op: 'create', resource: 'definition', definitionType: 'tag', name: 'Template Golden', bind: 'tag' },
          { op: 'create', placement: { kind: 'last', parent: oneAlias('library') }, nodes: [draft('Tagged before backfill')], bind: 'target' },
          { op: 'update', targets: { binding: 'target' }, changes: [{ kind: 'tag', action: 'add', tag: { binding: 'tag' } }] },
          { op: 'create', placement: { kind: 'last', parent: { binding: 'tag' } }, nodes: [draft('Template child')], bind: 'template' },
        ],
      });
      const tagId = setup.diff.bindings.tag![0]!;
      const targetId = setup.diff.bindings.target![0]!;
      const before = snapshot(runtime);
      const callsBefore = cli.calls;
      const preview = diffResult(await cli.json(['template', 'apply', tagId, '--preview']));
      expect(preview.affected.some((entry) => entry.effect === 'create')).toBe(true);
      const operation = operationResult(await cli.json([
        'template', 'apply', tagId, '--expect-diff', preview.diffHash,
        '--idempotency-key', preview.normalizedChangeSet.idempotencyKey!,
      ]));
      expect(cli.calls - callsBefore).toBe(2);
      expect(runtime.workspace.documentState().nodes[targetId]!.children.map((id) => runtime.workspace.documentState().nodes[id]?.content.text))
        .toContain('Template child');
      await exactRevert(runtime, operation, before, cli);
    });
  });

  test('10. previews, confirms, and reverts Node/definition merge, purge, and Empty Trash', async () => {
    await withRuntime(async ({ runtime, cli }) => {
      const nodeSource = returnedIds(operationResult(await cli.json(['add', '@library', 'Merge source'])))[0]!;
      const nodeTarget = returnedIds(operationResult(await cli.json(['add', '@library', 'Merge target'])))[0]!;
      await previewApplyRevert(cli, runtime, ['merge', nodeSource, nodeTarget]);

      const defSource = returnedIds(operationResult(await cli.json(['definition', 'create', 'tag', 'Definition source'])))[0]!;
      const defTarget = returnedIds(operationResult(await cli.json(['definition', 'create', 'tag', 'Definition target'])))[0]!;
      await previewApplyRevert(cli, runtime, ['definition', 'merge', defSource, defTarget]);

      const purgeId = returnedIds(operationResult(await cli.json(['add', '@library', 'Purge target'])))[0]!;
      await cli.json(['trash', purgeId]);
      await previewApplyRevert(cli, runtime, ['purge', purgeId]);

      for (const text of ['Empty Trash A', 'Empty Trash B']) {
        const id = returnedIds(operationResult(await cli.json(['add', '@library', text])))[0]!;
        await cli.json(['trash', id]);
      }
      await previewApplyRevert(cli, runtime, ['purge', '@trash', '--contents']);
    });
  });

  test('11. repeated configure, set, and ensure calls converge without additional Operations', async () => {
    await withRuntime(async ({ runtime, cli }) => {
      const definitionId = returnedIds(operationResult(await cli.json(['definition', 'create', 'field', 'Idempotent Field'])))[0]!;
      const ownerId = returnedIds(operationResult(await cli.json(['add', '@library', 'Idempotent View'])))[0]!;
      const cases: readonly [readonly string[], readonly string[]][] = [
        [
          ['definition', 'configure', definitionId, 'field', '--patch', '{"nullable":false}'],
          ['definition', 'configure', definitionId, 'field', '--patch', '{"nullable":false}'],
        ],
        [
          ['view', 'set', ownerId, 'table', '--replace', '{"sort":[{"field":"sys:updatedAt","direction":"desc"}]}'],
          ['view', 'set', ownerId, 'table', '--replace', '{"sort":[{"field":"sys:updatedAt","direction":"desc"}]}'],
        ],
        [
          ['daily', 'ensure', '2043-04-05'],
          ['daily', 'ensure', '2043-04-05'],
        ],
      ];
      for (const [firstArgs, repeatedArgs] of cases) {
        const stateBefore = snapshot(runtime);
        const operationsBefore = await countOperations(runtime);
        const first = operationResult(await cli.json(firstArgs));
        expect(await countOperations(runtime)).toBe(operationsBefore + 1);
        const repeated = noChangeResult(await cli.json(repeatedArgs));
        expect(repeated).toMatchObject({ affectedNodeCount: 0, recovery: { state: 'not-required' } });
        expect(await countOperations(runtime)).toBe(operationsBefore + 1);
        if (firstArgs[0] === 'view') {
          const state = runtime.workspace.documentState();
          const view = state.nodes[ownerId]!.children.map((id) => state.nodes[id]).find((node) => node?.type === 'viewDef');
          expect(view!.children.map((id) => state.nodes[id]).filter((node) => node?.type === 'sortRule')).toHaveLength(1);
        }
        await exactRevert(runtime, first, stateBefore, cli);
      }
      expect(Object.values(runtime.workspace.documentState().nodes)
        .filter((node) => node.content.text === 'Idempotent Field' && node.type === 'fieldDef')).toHaveLength(1);
    });
  });

  test('12. exposes Operation ID, affected count, recovery state, returned IDs, and no-change recovery', async () => {
    await withRuntime(async ({ runtime, cli }) => {
      const before = snapshot(runtime);
      const operation = operationResult(await cli.json(['add', '@library', 'Visible operation result']));
      expect(operation.operationId).toMatch(/^operation:/);
      expect(operation.affectedNodeCount).toBeGreaterThan(0);
      expect(operation.recovery.state).toBe('available');
      expect(returnedIds(operation)).toHaveLength(1);
      const nodeId = returnedIds(operation)[0]!;
      const noChange = noChangeResult(await cli.json(['set', nodeId, '--text', 'Visible operation result']));
      expect(noChange).toMatchObject({ affectedNodeCount: 0, recovery: { state: 'not-required' } });
      expect((await runtime.workspace.store.operations()).some((entry) => entry.operationId === operation.operationId)).toBe(true);
      await exactRevert(runtime, operation, before, cli);
    });
  });

  test('13. replaces literal text over one bounded query with one reviewed Operation and exact revert', async () => {
    await withRuntime(async ({ runtime, cli }) => {
      const referenceId = returnedIds(operationResult(await cli.json(['add', '@library', 'Reference target'])))[0]!;
      const setup = await diffApply(cli, {
        protocolVersion: 1, kind: 'outline.changeset', operations: [
          {
            op: 'create', placement: { kind: 'last', parent: oneAlias('library') }, bind: 'rich', nodes: [{
              content: {
                text: 'keyword 1 keyword 1',
                marks: [{ start: 0, end: 9, type: 'bold' }],
                inlineRefs: [{ offset: 10, target: { kind: 'node', nodeId: referenceId } }],
              },
              children: [],
            }],
          },
          {
            op: 'create', placement: { kind: 'last', parent: oneAlias('library') }, bind: 'described', nodes: [draft('Description target', {
              description: 'Keyword 1 appears here',
            })],
          },
          { op: 'create', placement: { kind: 'last', parent: oneAlias('library') }, nodes: [draft('Unrelated target')] },
        ],
      });
      const richId = setup.diff.bindings.rich![0]!;
      const describedId = setup.diff.bindings.described![0]!;
      const before = snapshot(runtime);
      const operationsBefore = await countOperations(runtime);
      const callsBefore = cli.calls;
      const args = [
        'text', 'replace', '--matching', 'keyword 1', '--max', '10',
        '--find', 'keyword 1', '--replace', 'replacement', '--field', 'both',
        '--case-sensitive', 'false', '--max-replacements', '10',
      ] as const;

      const preview = diffResult(await cli.json([...args, '--preview']));
      expect(preview.destructive).toContainEqual({ kind: 'replace', targetCount: 2 });
      expect(runtime.workspace.documentState()).toEqual(before);
      const operation = operationResult(await cli.json([
        ...args, '--expect-diff', preview.diffHash, '--yes',
        '--idempotency-key', preview.normalizedChangeSet.idempotencyKey!,
      ]));
      expect(cli.calls - callsBefore).toBe(2);
      expect(await countOperations(runtime)).toBe(operationsBefore + 1);
      expect(operation).toMatchObject({ affectedNodeCount: 2, recovery: { state: 'available' } });

      const state = runtime.workspace.documentState();
      expect(state.nodes[richId]?.content).toEqual({
        text: 'replacement replacement',
        marks: [{ start: 0, end: 11, type: 'bold' }],
        inlineRefs: [{ offset: 12, target: { kind: 'node', nodeId: referenceId } }],
      });
      expect(state.nodes[describedId]?.description).toBe('replacement appears here');
      expect(Object.values(state.nodes)).toContainEqual(expect.objectContaining({ content: { text: 'Unrelated target', marks: [], inlineRefs: [] } }));

      const noChangePreview = diffResult(await cli.json([...args, '--preview']));
      const repeated = noChangeResult(await cli.json([
        ...args, '--expect-diff', noChangePreview.diffHash, '--yes',
        '--idempotency-key', noChangePreview.normalizedChangeSet.idempotencyKey!,
      ]));
      expect(repeated).toMatchObject({ affectedNodeCount: 0, recovery: { state: 'not-required' } });
      expect(await countOperations(runtime)).toBe(operationsBefore + 1);
      await exactRevert(runtime, operation, before, cli);
    });
  });
});

async function previewApplyRevert(
  cli: CliHarness,
  runtime: OutlineRuntimeServer,
  args: readonly string[],
): Promise<void> {
  const before = snapshot(runtime);
  const operationsBefore = await countOperations(runtime);
  const callsBefore = cli.calls;
  const preview = diffResult(await cli.json([...args, '--preview']));
  expect(preview.destructive.length).toBeGreaterThan(0);
  const operation = operationResult(await cli.json([
    ...args, '--expect-diff', preview.diffHash, '--yes',
    '--idempotency-key', preview.normalizedChangeSet.idempotencyKey!,
  ]));
  expect(cli.calls - callsBefore).toBe(2);
  expect(await countOperations(runtime)).toBe(operationsBefore + 1);
  await exactRevert(runtime, operation, before, cli);
}

async function diffApply(cli: CliHarness, changeSet: unknown): Promise<{ diff: Diff; operation: Operation }> {
  const diff = diffResult(await cli.json(['diff', '--input', '-'], JSON.stringify(changeSet)));
  const operation = operationResult(await cli.json(['apply', '--input', '-'], JSON.stringify(diff)));
  return { diff, operation };
}

async function exactRevert(
  runtime: OutlineRuntimeServer,
  operation: Operation,
  before: unknown,
  cli: CliHarness,
): Promise<void> {
  const reverted = operationResult(await cli.json(['revert', operation.operationId]));
  expect(reverted.revertsOperationId).toBe(operation.operationId);
  expect(runtime.workspace.documentState()).toEqual(before);
  const log = await cli.json(['log', '--operation', operation.operationId]);
  expect((log as { operations: Operation[] }).operations[0]?.recovery.state).toBe('reverted');
}

interface CliHarness {
  calls: number;
  json(args: readonly string[], stdin?: string): Promise<unknown>;
}

async function withRuntime(
  run: (context: { root: string; runtime: OutlineRuntimeServer; cli: CliHarness }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'tenon-outline-golden-'));
  roots.push(root);
  const runtime = await OutlineRuntimeServer.start({ root, idleTimeoutMs: 60_000 });
  expect(runtime).not.toBeNull();
  if (!runtime) return;
  const cli: CliHarness = {
    calls: 0,
    async json(args, stdin = '') {
      this.calls += 1;
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
      const response = JSON.parse(stdout) as { ok: boolean; data?: unknown; error?: unknown };
      expect({ code, response }).toMatchObject({ code: 0, response: { ok: true } });
      return response.data;
    },
  };
  try {
    await run({ root, runtime, cli });
  } finally {
    await runtime.stop();
  }
}

function operationResult(value: unknown): Operation {
  const operation = value as Operation;
  expect(operation.kind).toBe('outline.operation');
  expect(typeof operation.operationId).toBe('string');
  expect(typeof operation.affectedNodeCount).toBe('number');
  expect(operation.recovery.state).toBe('available');
  return operation;
}

function noChangeResult(value: unknown): NoChangeResult {
  expect(value).toMatchObject({ kind: 'outline.no-change' });
  return value as NoChangeResult;
}

function diffResult(value: unknown): Diff {
  const diff = value as Diff;
  expect(diff.kind).toBe('outline.diff');
  expect(typeof diff.diffHash).toBe('string');
  return diff;
}

function returnedIds(operation: Operation): string[] {
  return (operation.result?.[0]?.nodes ?? []).flatMap((node) => (
    node && typeof node === 'object' && typeof (node as { id?: unknown }).id === 'string'
      ? [(node as { id: string }).id]
      : []
  ));
}

function snapshot(runtime: OutlineRuntimeServer): unknown {
  return JSON.parse(JSON.stringify(runtime.workspace.documentState())) as unknown;
}

async function countOperations(runtime: OutlineRuntimeServer): Promise<number> {
  return (await runtime.workspace.store.operations()).length;
}

function draft(text: string, patch: Record<string, unknown> = {}) {
  return { content: { text, marks: [], inlineRefs: [] }, children: [], ...patch };
}

function oneAlias(alias: 'library') {
  return { target: { selector: { by: 'alias', alias }, cardinality: 'one' } };
}

function oneId(id: string) {
  return { target: { selector: { by: 'id', id }, cardinality: 'one' } };
}

function captureProvenance() {
  return {
    schemaVersion: 1,
    captureId: 'capture:golden',
    createdBy: 'import',
    capturedAt: '2026-08-24T00:00:00.000Z',
    origin: 'test',
    providerId: 'generic-webpage',
    app: { name: 'Outline CLI golden flow' },
    source: {
      kind: 'article',
      title: 'Golden source',
      original: { kind: 'remote-url', url: 'https://example.com', preview: 'web-preview' },
      providerId: 'generic-webpage',
    },
    status: 'saved',
    intent: 'capture',
    warnings: [],
  };
}
