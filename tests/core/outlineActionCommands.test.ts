import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildConfigIndex } from '../../src/core/configProjection';
import type { CreateCaptureInput } from '../../src/core/launcher/sources';
import { plainText } from '../../src/core/types';
import { runOutlineActionCommand } from '../../src/main/outlineActionCommands';
import type { OutlineDocumentService, OutlineMutationOptions } from '../../src/main/outlineDocumentService';
import type { Change, ChangeSet, Operation } from '../../src/outline/contract';
import {
  OutlineRuntimeWorkspace,
  applyOutlineDiff,
  diffOutlineChangeSet,
} from '../../src/outline/runtime';

const roots: string[] = [];

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe('Outline action commands', () => {
  test('settles a capture with tag inheritance and child metadata as one Operation', async () => {
    const workspace = await makeWorkspace();
    const before = await workspace.store.operations();
    const input: CreateCaptureInput = {
      destinationParentId: workspace.projection().todayId,
      title: plainText('Captured article'),
      tag: 'article',
      tagExtends: 'capture',
      children: [{
        content: plainText('Summary'),
        tags: ['review'],
        fields: [{ name: 'Status', value: 'Ready' }],
        children: [],
      }],
    };

    await runOutlineActionCommand(runtimeDocument(workspace), 'create_capture', { input });

    const state = workspace.documentState();
    const nodes = Object.values(state.nodes);
    const captureTag = nodes.find((node) => node.type === 'tagDef' && node.content.text === 'capture')!;
    const articleTag = nodes.find((node) => node.type === 'tagDef' && node.content.text === 'article')!;
    const reviewTag = nodes.find((node) => node.type === 'tagDef' && node.content.text === 'review')!;
    const statusField = nodes.find((node) => node.type === 'fieldDef' && node.content.text === 'Status')!;
    const root = nodes.find((node) => node.content.text === 'Captured article')!;
    const child = nodes.find((node) => node.parentId === root.id && node.content.text === 'Summary')!;
    const fieldEntry = nodes.find((node) => (
      node.type === 'fieldEntry' && node.parentId === child.id && node.fieldDefId === statusField.id
    ))!;

    expect(buildConfigIndex(state).tag(articleTag.id)?.extends).toBe(captureTag.id);
    expect(root.tags).toContain(articleTag.id);
    expect(child.tags).toContain(reviewTag.id);
    expect(nodes.find((node) => node.parentId === fieldEntry.id)?.content.text).toBe('Ready');
    expect((await workspace.store.operations()).length - before.length).toBe(1);
  });

  test('does not attach an existing same-named tag to the requested supertag', async () => {
    const workspace = await makeWorkspace();
    const seeded = await settle(workspace, [{
      op: 'ensure', resource: 'definition', definitionType: 'tag', name: 'video', bind: 'video',
    }]);
    const videoTagId = seeded.diff.bindings.video![0]!;
    const before = await workspace.store.operations();

    await runOutlineActionCommand(runtimeDocument(workspace), 'create_capture', {
      input: {
        destinationParentId: workspace.projection().todayId,
        title: plainText('Captured video'),
        tag: 'video',
        tagExtends: 'capture',
      } satisfies CreateCaptureInput,
    });

    const state = workspace.documentState();
    const captured = Object.values(state.nodes).find((node) => node.content.text === 'Captured video')!;
    expect(captured.tags).toContain(videoTagId);
    expect(buildConfigIndex(state).tag(videoTagId)?.extends).toBeUndefined();
    expect((await workspace.store.operations()).length - before.length).toBe(1);
  });
});

function runtimeDocument(workspace: OutlineRuntimeWorkspace): OutlineDocumentService {
  return {
    getProjection: () => workspace.projection(),
    runChanges: async (changes: readonly Change[], options: OutlineMutationOptions = {}) => {
      const settled = await settle(workspace, changes);
      return {
        update: {
          kind: 'full' as const,
          revision: workspace.revision(),
          projection: workspace.projection(),
        },
        ...(options.focus ? {
          focus: typeof options.focus === 'function'
            ? options.focus(settled.operation, settled.diff, {
              kind: 'full',
              revision: workspace.revision(),
              projection: workspace.projection(),
            })
            : options.focus,
        } : {}),
      };
    },
  } as unknown as OutlineDocumentService;
}

async function settle(
  workspace: OutlineRuntimeWorkspace,
  operations: readonly Change[],
): Promise<{ diff: Awaited<ReturnType<typeof diffOutlineChangeSet>>; operation: Operation }> {
  const changeSet: ChangeSet = { protocolVersion: 1, kind: 'outline.changeset', operations: [...operations] };
  const diff = await diffOutlineChangeSet(workspace, changeSet);
  const operation = await applyOutlineDiff(workspace, diff, { origin: 'local-user' });
  return { diff, operation };
}

async function makeWorkspace(): Promise<OutlineRuntimeWorkspace> {
  const root = await mkdtemp(path.join(tmpdir(), 'tenon-outline-actions-'));
  roots.push(root);
  return OutlineRuntimeWorkspace.open(root, { instanceId: `runtime:${crypto.randomUUID()}` });
}
