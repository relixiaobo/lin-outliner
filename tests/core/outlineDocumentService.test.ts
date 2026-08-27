import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { OutlineDocumentService } from '../../src/main/outlineDocumentService';
import { canonicalSha256 } from '../../src/outline/contract/canonical';
import { OutlineClientSupervisor } from '../../src/outline/client';
import { OutlineRuntimeServer } from '../../src/outline/runtime/server';
import { TimelineMemoryStore } from '../../src/main/agent/extensions/memory/TimelineMemoryStore';

const roots: string[] = [];

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe('OutlineDocumentService', () => {
  test('tracks mutation settlement and resyncs through a Runtime restart', async () => {
    const root = await makeRoot();
    let runtime = await OutlineRuntimeServer.start({ root, contentRoot: `${root}-content`, idleTimeoutMs: 60_000 });
    expect(runtime).not.toBeNull();
    if (!runtime) return;
    const document = new OutlineDocumentService(new OutlineClientSupervisor({
      root,
      noStart: true,
      origin: 'desktop',
    }));
    const deliveries: Array<{ update: { kind: 'full' | 'delta' } }> = [];
    const unsubscribe = document.onProjectionChanged((delivery) => deliveries.push(delivery));
    try {
      await document.init();
      const mutation = document.runChanges([{
        op: 'create',
        placement: { kind: 'last', parent: oneToday() },
        nodes: [{ content: richText('Desktop mutation'), children: [] }],
        bind: 'created',
      }]);
      expect(document.latestAcceptedMutationSequence()).toBe(1);
      const result = await mutation;
      expect(result.update).toMatchObject({ kind: 'delta', revision: 1 });
      await document.drainMutations(1);
      expect(document.settledMutationSequence()).toBe(1);
      expect(document.getProjection().nodes.some((node) => node.content.text === 'Desktop mutation')).toBe(true);

      document.freezeMutationAdmission();
      await expect(document.runChanges([{
        op: 'create',
        placement: { kind: 'last', parent: oneToday() },
        nodes: [{ content: richText('Rejected during quit'), children: [] }],
      }])).rejects.toThrow('admission is frozen');
      document.unfreezeMutationAdmission();

      await runtime.stop();
      runtime = await OutlineRuntimeServer.start({ root, contentRoot: `${root}-content`, idleTimeoutMs: 60_000 });
      expect(runtime).not.toBeNull();
      if (!runtime) return;
      await runtime.workspace.mutate(createRequest('Runtime restart mutation'));

      await waitFor(() => (
        document.getProjection().nodes.some((node) => node.content.text === 'Runtime restart mutation')
      ));
      expect(deliveries.some((delivery) => delivery.update.kind === 'full')).toBe(true);
    } finally {
      unsubscribe();
      document.close();
      await runtime?.stop();
    }
  });

  test('does not submit an empty ChangeSet when Memory tag definitions already exist', async () => {
    const root = await makeRoot();
    const runtime = await OutlineRuntimeServer.start({ root, contentRoot: `${root}-content`, idleTimeoutMs: 60_000 });
    expect(runtime).not.toBeNull();
    if (!runtime) return;
    const document = new OutlineDocumentService(new OutlineClientSupervisor({
      root,
      noStart: true,
      origin: 'desktop',
    }));
    const timeline = new TimelineMemoryStore(document);
    try {
      await document.init();
      await timeline.ensureTagDefinitions();
      await timeline.ensureTagDefinitions();

      expect(await document.log({ limit: 10 })).toHaveLength(1);
    } finally {
      document.close();
      await runtime.stop();
    }
  });

  test('keeps the desktop revision valid after a semantic no-change settlement', async () => {
    const root = await makeRoot();
    const runtime = await OutlineRuntimeServer.start({ root, contentRoot: `${root}-content`, idleTimeoutMs: 60_000 });
    expect(runtime).not.toBeNull();
    if (!runtime) return;
    const document = new OutlineDocumentService(new OutlineClientSupervisor({
      root,
      noStart: true,
      origin: 'desktop',
    }));
    try {
      await document.init();
      const ensure = [{
        op: 'ensure' as const,
        resource: 'definition' as const,
        definitionType: 'tag' as const,
        name: 'Convergent tag',
        bind: 'convergentTag',
      }];
      await document.runChanges(ensure);
      const revision = document.revision();
      const noChange = await document.runChanges(ensure);
      expect(noChange.update).toMatchObject({ kind: 'full', revision });
      expect(Number.isFinite(document.revision())).toBe(true);

      const next = await document.runChanges([{
        op: 'create',
        placement: { kind: 'last', parent: oneToday() },
        nodes: [{ content: richText('After no-change'), children: [] }],
      }]);
      expect(next.update.revision).toBe(revision + 1);
    } finally {
      document.close();
      await runtime.stop();
    }
  });
});

function oneToday() {
  return {
    target: { selector: { by: 'alias' as const, alias: 'today' as const }, cardinality: 'one' as const },
  };
}

function richText(text: string) {
  return { text, marks: [], inlineRefs: [] };
}

function createRequest(text: string) {
  const payload = { kind: 'create', text };
  return {
    origin: 'local-user' as const,
    changeSetHash: canonicalSha256(payload),
    diffHash: canonicalSha256({ ...payload, kind: 'diff' }),
    summary: `Created ${text}.`,
    execute: (core: Parameters<Parameters<
      typeof import('../../src/outline/runtime/runtimeWorkspace').OutlineRuntimeWorkspace.prototype.mutate
    >[0]['execute']>[0]) => {
      core.createNode(core.projection().todayId, null, text);
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for OutlineDocumentService state.');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'tenon-outline-document-service-'));
  roots.push(root);
  return root;
}
