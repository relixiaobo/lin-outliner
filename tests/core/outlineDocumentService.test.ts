import { afterAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { OutlineDocumentService } from '../../src/main/outlineDocumentService';
import { canonicalSha256 } from '../../src/outline/contract/canonical';
import { OutlineClientSupervisor, type OutlineClient } from '../../src/outline/client';
import { OUTLINE_PROTOCOL_VERSION } from '../../src/outline/contract/version';
import { OutlineRuntimeServer } from '../../src/outline/runtime/server';
import { TimelineMemoryStore } from '../../src/main/agent/extensions/memory/TimelineMemoryStore';

const roots: string[] = [];
const MAIN_SOURCE = readFileSync(path.join(import.meta.dir, '../../src/main/main.ts'), 'utf8');
const OUTLINE_HOST_SOURCE = readFileSync(
  path.join(import.meta.dir, '../../src/main/hostDomain/outlineDesktopHost.ts'),
  'utf8',
);
const AGENT_HOST_SOURCE = readFileSync(
  path.join(import.meta.dir, '../../src/main/hostDomain/agentHost.ts'),
  'utf8',
);
const COMPOSITION_LIFECYCLE_SOURCE = readFileSync(
  path.join(import.meta.dir, '../../src/main/hostDomain/compositionLifecycle.ts'),
  'utf8',
);

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe('OutlineDocumentService', () => {
  test('keeps recovered desktop production wiring attached to the Runtime service', () => {
    expect(MAIN_SOURCE).toContain('createOutlineDesktopHost({');
    expect(OUTLINE_HOST_SOURCE).toContain('new OutlineDocumentService(supervisor)');
    expect(OUTLINE_HOST_SOURCE).toContain('documents.setDurabilityFailureHandler(');
    expect(AGENT_HOST_SOURCE).toContain('new TimelineMemoryStore(options.timeline)');
    expect(MAIN_SOURCE).toContain('outlineHost.observeProjection(({ event, update }) =>');
    expect(AGENT_HOST_SOURCE).toContain("code: 'memory-runtime-projection-observer-failed'");
    expect(COMPOSITION_LIFECYCLE_SOURCE).toContain(
      'dependencies.documents.replacePersonalAccessRanking(dependencies.nodeAccess.snapshot())',
    );
    expect(OUTLINE_HOST_SOURCE).toContain('documents.upsertPersonalAccessRanking(update.upserted)');
    expect(OUTLINE_HOST_SOURCE).toContain('documents.removePersonalAccessRanking(');
    expect(MAIN_SOURCE).not.toContain('outlineDocumentService');
  });

  test('closes request clients whose personal ranking bootstrap fails', async () => {
    let connectCalls = 0;
    let closeCalls = 0;
    const document = new OutlineDocumentService({
      connect: async () => {
        connectCalls += 1;
        return {
          syncDesktopPersonalAccessRanking: async () => {
            throw new Error('injected ranking bootstrap failure');
          },
          close: () => { closeCalls += 1; },
        } as unknown as OutlineClient;
      },
    });

    await expect(document.replacePersonalAccessRanking(new Map([
      ['node:ranked', { s: 1, tUpdate: 1 }],
    ]))).rejects.toThrow('injected ranking bootstrap failure');
    expect(connectCalls).toBe(2);
    expect(closeCalls).toBe(2);
    document.close();
  });

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
      const result = await mutation;
      expect(result.update).toMatchObject({ kind: 'delta', revision: 1 });
      expect(await document.latestAcceptedRevision()).toBe(1);
      await document.drainToRevision(1);
      expect(await document.durableRevision()).toBe(1);
      await document.unfreezeMutationAdmission();
      expect(document.getProjection().nodes.some((node) => node.content.text === 'Desktop mutation')).toBe(true);

      document.freezeMutationAdmission();
      await expect(document.runChanges([{
        op: 'create',
        placement: { kind: 'last', parent: oneToday() },
        nodes: [{ content: richText('Rejected during quit'), children: [] }],
      }])).rejects.toThrow('admission is frozen');
      await document.unfreezeMutationAdmission();

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
      expect(await document.durableRevision()).toBe(document.revision());
    } finally {
      document.close();
      await runtime.stop();
    }
  });

  test('plans Memory publication after earlier document mutations have updated the projection', async () => {
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
    const targetId = 'node:10000000-0000-4000-8000-000000000099';
    try {
      await document.init();
      await document.runChanges([{
        op: 'create',
        placement: { kind: 'last', parent: oneToday() },
        nodes: [{ id: targetId, content: richText('Generated text'), children: [] }],
      }]);

      let releaseUserEdit!: () => void;
      let markUserEditPlanning!: () => void;
      const userEditPlanning = new Promise<void>((resolve) => { markUserEditPlanning = resolve; });
      const userEditGate = new Promise<void>((resolve) => { releaseUserEdit = resolve; });
      const userEdit = document.runChangeSet(async (revision) => {
        markUserEditPlanning();
        await userEditGate;
        return {
          protocolVersion: OUTLINE_PROTOCOL_VERSION,
          kind: 'outline.changeset',
          base: { revision },
          operations: [{
            op: 'update',
            targets: oneId(targetId),
            changes: [{ kind: 'content', value: richText('User authoritative edit') }],
          }],
        };
      });
      await userEditPlanning;

      let validationCalls = 0;
      const publication = timeline.applyConsolidation(
        'memory:queued-user-edit-regression',
        1,
        canonicalSha256({ test: 'queued-user-edit-regression' }),
        [{ nodeId: targetId, action: 'update', text: 'Stale generated replacement' }],
        () => {
          validationCalls += 1;
          const target = document.getProjection().nodes.find((node) => node.id === targetId);
          if (target?.content.text === 'User authoritative edit') {
            throw new Error('Memory target changed before publication');
          }
        },
      );
      await Promise.resolve();
      expect(validationCalls).toBe(0);

      releaseUserEdit();
      await userEdit;
      await expect(publication).rejects.toThrow('Memory target changed before publication');
      expect(document.getProjection().nodes.find((node) => node.id === targetId)?.content.text)
        .toBe('User authoritative edit');
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
      expect(noChange.update).toEqual({
        kind: 'delta',
        revision,
        todayId: document.getProjection().todayId,
        changedNodes: [],
        removedIds: [],
      });
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

  test('lets locally admitted mutations reach the Runtime before installing the quit barrier', async () => {
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
      const first = document.runChanges([{
        op: 'create',
        placement: { kind: 'last', parent: oneToday() },
        nodes: [{ content: richText('Queued before quit one'), children: [] }],
      }]);
      const second = document.runChanges([{
        op: 'create',
        placement: { kind: 'last', parent: oneToday() },
        nodes: [{ content: richText('Queued before quit two'), children: [] }],
      }]);
      document.freezeMutationAdmission();
      const barrier = document.latestAcceptedRevision();

      const [firstResult, secondResult, targetRevision] = await Promise.all([first, second, barrier]);
      expect(firstResult.update.revision).toBe(1);
      expect(secondResult.update.revision).toBe(2);
      expect(targetRevision).toBe(2);
      await document.drainToRevision(targetRevision);
      await document.unfreezeMutationAdmission();
    } finally {
      document.close();
      await runtime.stop();
    }
  });

  test('keeps durable settlement separate from destructive acknowledgement', async () => {
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
      await document.runChanges([{
        op: 'create',
        placement: { kind: 'last', parent: oneToday() },
        nodes: [{ content: richText('Durable purge'), children: [] }],
      }]);
      const nodeId = document.getProjection().nodes.find((node) => node.content.text === 'Durable purge')!.id;

      const purge = [{
        op: 'lifecycle' as const,
        action: 'purge' as const,
        targets: {
          target: { selector: { by: 'id' as const, id: nodeId }, cardinality: 'one' as const },
        },
      }];
      await expect(document.runChanges(purge, { settlement: 'durable' })).rejects.toMatchObject({
        outlineError: { code: 'confirmation_required' },
      });
      expect(document.getProjection().nodes.some((node) => node.id === nodeId)).toBe(true);

      await document.runChanges(purge, {
        settlement: 'durable',
        acknowledgeDestructive: true,
      });
      expect(document.getProjection().nodes.some((node) => node.id === nodeId)).toBe(false);
    } finally {
      document.close();
      await runtime.stop();
    }
  });

  test('uses Runtime-ranked search and keeps sparse Node reads fresh in input order', async () => {
    const root = await makeRoot();
    let runtime = await OutlineRuntimeServer.start({ root, contentRoot: `${root}-content`, idleTimeoutMs: 60_000 });
    expect(runtime).not.toBeNull();
    if (!runtime) return;
    const document = new OutlineDocumentService(new OutlineClientSupervisor({
      root,
      noStart: true,
      origin: 'desktop',
    }));
    try {
      await document.init();
      await document.runChanges([{
        op: 'create',
        placement: { kind: 'last', parent: oneToday() },
        nodes: [{ content: richText('Ranked needle exact'), children: [] }],
      }]);
      await document.runChanges([{
        op: 'create',
        placement: { kind: 'last', parent: oneToday() },
        nodes: [{ content: richText('Prefix ranked needle extra'), children: [] }],
      }]);
      const first = document.getProjection().nodes.find((node) => node.content.text === 'Ranked needle exact')!;
      const second = document.getProjection().nodes.find((node) => node.content.text === 'Prefix ranked needle extra')!;

      const hits = await document.searchNodeHits('ranked needle', 10);
      expect(hits).toEqual(runtime.workspace.searchText('ranked needle', 10));
      expect(hits.map((hit) => hit.nodeId)).toEqual(expect.arrayContaining([first.id, second.id]));
      expect(document.projectionNodesByIds([second.id, 'node:missing', first.id]))
        .toEqual([second, first]);

      await runtime.stop();
      runtime = await OutlineRuntimeServer.start({ root, contentRoot: `${root}-content`, idleTimeoutMs: 60_000 });
      expect(runtime).not.toBeNull();
      if (!runtime) return;
      expect(await document.searchNodeHits('ranked needle', 10)).toEqual(
        runtime.workspace.searchText('ranked needle', 10),
      );
    } finally {
      document.close();
      await runtime?.stop();
    }
  });

  test('synchronizes personal access ranking into Runtime and restores it after reconnect', async () => {
    const root = await makeRoot();
    let runtime = await OutlineRuntimeServer.start({ root, contentRoot: `${root}-content`, idleTimeoutMs: 60_000 });
    expect(runtime).not.toBeNull();
    if (!runtime) return;
    const document = new OutlineDocumentService(new OutlineClientSupervisor({
      root,
      noStart: true,
      origin: 'desktop',
    }));
    try {
      await document.init();
      await document.runChanges([{
        op: 'create',
        placement: { kind: 'last', parent: oneToday() },
        nodes: [
          { content: richText('Personal access needle'), children: [] },
          { content: richText('Personal access needle'), children: [] },
        ],
      }]);
      const fixtures = document.getProjection().nodes
        .filter((node) => node.content.text === 'Personal access needle');
      expect(fixtures).toHaveLength(2);
      const preferredId = fixtures[1]!.id;
      await document.replacePersonalAccessRanking(new Map([
        [preferredId, { s: 20, tUpdate: Date.now() }],
      ]));
      expect((await document.searchNodeHits('personal access needle', 10))[0]?.nodeId).toBe(preferredId);

      await runtime.stop();
      runtime = await OutlineRuntimeServer.start({ root, contentRoot: `${root}-content`, idleTimeoutMs: 60_000 });
      expect(runtime).not.toBeNull();
      if (!runtime) return;
      expect((await document.searchNodeHits('personal access needle', 10))[0]?.nodeId).toBe(preferredId);
    } finally {
      document.close();
      await runtime?.stop();
    }
  });

  test('reports a background Runtime durability failure without delaying the accepted edit', async () => {
    const root = await makeRoot();
    let failAcknowledgement = true;
    const runtime = await OutlineRuntimeServer.start({
      root,
      contentRoot: `${root}-content`,
      idleTimeoutMs: 60_000,
      workspaceOptions: {
        durabilityIdleDelayMs: 1,
        durabilityMaxWaitMs: 1,
        storeOptions: {
          afterTransactionFsync: () => {
            if (!failAcknowledgement) return;
            failAcknowledgement = false;
            throw new Error('injected background durability failure');
          },
        },
      },
    });
    expect(runtime).not.toBeNull();
    if (!runtime) return;
    const document = new OutlineDocumentService(new OutlineClientSupervisor({
      root,
      noStart: true,
      origin: 'desktop',
    }), { durabilityMonitorDelayMs: 10 });
    let reportFailure!: (value: { error: Error; revision: number }) => void;
    const reported = new Promise<{ error: Error; revision: number }>((resolve) => { reportFailure = resolve; });
    document.setDurabilityFailureHandler((error, revision) => reportFailure({ error, revision }));
    try {
      await document.init();
      const accepted = await document.runChanges([{
        op: 'create',
        placement: { kind: 'last', parent: oneToday() },
        nodes: [{ content: richText('Accepted before background failure'), children: [] }],
      }]);
      expect(accepted.update.revision).toBe(1);

      await expect(reported).resolves.toMatchObject({
        error: { message: 'injected background durability failure' },
        revision: 1,
      });
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

function oneId(id: string) {
  return {
    target: { selector: { by: 'id' as const, id }, cardinality: 'one' as const },
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
