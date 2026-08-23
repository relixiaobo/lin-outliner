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
    const runtime = await OutlineRuntimeServer.start({ root, idleTimeoutMs: 60_000 });
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

      const unacknowledged = await jsonCommand(root, ['purge', nodeId!, '--expect-diff', purgeDiff.diffHash]);
      expect(unacknowledged.code).toBe(4);
      expect(unacknowledged.error).toMatchObject({ code: 'confirmation_required' });
      expect(runtime.workspace.documentState().nodes[nodeId!]).toBeDefined();

      const purged = await jsonCommand(root, [
        'purge', nodeId!, '--expect-diff', purgeDiff.diffHash, '--yes',
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
    const runtime = await OutlineRuntimeServer.start({ root, idleTimeoutMs: 60_000 });
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
});

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
