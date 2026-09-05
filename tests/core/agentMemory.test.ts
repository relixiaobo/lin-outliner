import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  decodeMemoryConsolidationOutput,
  decodeMemoryStage1Output,
  MEMORY_TAG_DEFINITIONS,
} from '../../src/core/agent/memory';
import type { Thread, ThreadItem, Turn } from '../../src/core/agent/protocol';
import { createTextSearchIndex } from '../../src/core/textSearchIndex';
import {
  MemoryControlStore,
  type MemoryGeneratedNodeRecord,
} from '../../src/main/agent/extensions/memory/MemoryControlStore';
import { MemoryExtension, type MemoryThreadHost } from '../../src/main/agent/extensions/memory/MemoryExtension';
import { MemoryMutationIndex } from '../../src/main/agent/extensions/memory/MemoryMutationIndex';
import { collectMemoryEvidence } from '../../src/main/agent/extensions/memory/Phase1';
import { Phase1 } from '../../src/main/agent/extensions/memory/Phase1';
import { MemoryPipeline } from '../../src/main/agent/extensions/memory/MemoryPipeline';
import { Phase2 } from '../../src/main/agent/extensions/memory/Phase2';
import {
  canonicalMemoryGraph,
  timelineNodeFingerprint,
  TimelineMemoryStore,
  type TimelineMemoryHost,
} from '../../src/main/agent/extensions/memory/TimelineMemoryStore';
import {
  DAILY_NOTES_ID,
  LIBRARY_ID,
  RECENTS_ID,
  SCHEMA_ID,
  SEARCHES_ID,
  TAG_DAY_ID,
  TRASH_ID,
  WORKSPACE_ID,
  type DocumentProjection,
  type NodeProjection,
  type ProjectionUpdate,
} from '../../src/core/types';
import type { SqliteDatabase } from '../../src/main/agent/persistence/sqlite';
import {
  OutlineContractError,
  OUTLINE_PROTOCOL_VERSION,
  outlineError,
  type Change,
  type Operation,
  type TargetRef,
} from '../../src/outline/contract';
import { closeAgentServices } from '../../src/main/agent/closeAgentServices';
import { replayableModelCall } from '../fixtures/agentToolCallHistory';
import { formatNodeReferenceMarker } from '../../src/core/referenceMarkup';

const THREAD_ID = '018f0f24-7b2e-7a3f-8a4b-123456789abc';
const TURN_ID = '018f0f24-7b2e-7a3f-8a4b-123456789abd';
const ITEM_ID = '018f0f24-7b2e-7a3f-8a4b-123456789abe';
const MEMORY_NODE_ID = 'node:018f0f24-7b2e-4a3f-8a4b-123456789abf';
const EPISODE_NODE_ID = 'node:018f0f24-7b2e-4a3f-8a4b-123456789ac0';
const BELIEF_NODE_ID = 'node:018f0f24-7b2e-4a3f-8a4b-123456789ac1';

const stores: MemoryControlStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

describe('Codex Memory contracts', () => {
  test('strictly decodes bounded extraction and consolidation output', () => {
    expect(decodeMemoryStage1Output({
      dates: [{
        sourceDate: '2026-07-24',
        headline: statement('A durable decision'),
        episode: statement('The user selected the clean replacement.'),
        beliefs: [statement('The project is pre-release.')],
        questions: [],
        guidance: [statement('Do not preserve compatibility paths.')],
      }],
    }).dates[0]?.sourceDate).toBe('2026-07-24');
    expect(() => decodeMemoryStage1Output({ dates: [], extra: true })).toThrow('unknown field');
    expect(() => decodeMemoryStage1Output({ dates: [{ sourceDate: 'July 24' }] })).toThrow();

    expect(decodeMemoryConsolidationOutput({
      changes: [{ nodeId: MEMORY_NODE_ID, action: 'keep' }],
    }).changes).toHaveLength(1);
    expect(decodeMemoryConsolidationOutput({
      changes: [{
        nodeId: MEMORY_NODE_ID,
        action: 'update',
        text: 'Updated Memory',
        sourceNodeIds: [EPISODE_NODE_ID],
      }],
    }).changes[0]).toMatchObject({ action: 'update', sourceNodeIds: [EPISODE_NODE_ID] });
    expect(() => decodeMemoryConsolidationOutput({
      changes: [{ nodeId: MEMORY_NODE_ID, action: 'update', text: 'Missing lineage' }],
    })).toThrow('sourceNodeIds');
    expect(() => decodeMemoryConsolidationOutput({
      changes: [{ nodeId: MEMORY_NODE_ID, action: 'delete', text: 'not allowed' }],
    })).toThrow('unknown field');
    expect(decodeMemoryConsolidationOutput({
      changes: [{
        temporaryId: 'new:follow-up',
        action: 'create',
        parentId: EPISODE_NODE_ID,
        category: 'question',
        text: 'Which constraint should be retained?',
        sourceNodeIds: [EPISODE_NODE_ID],
      }],
    }).changes[0]).toMatchObject({ action: 'create', category: 'question' });
  });

  test('repairs a renamed protected Memory tag definition moved out of Schema', async () => {
    const projection = memoryProjection();
    for (const definition of MEMORY_TAG_DEFINITIONS) {
      const node = projection.nodes.find((entry) => entry.id === definition.tagId)!;
      node.locked = true;
      node.parentId = SCHEMA_ID;
    }
    const movedDefinition = MEMORY_TAG_DEFINITIONS[0]!;
    const movedNode = projection.nodes.find((entry) => entry.id === movedDefinition.tagId)!;
    movedNode.content = { text: 'renamed-memory', spans: [] };
    movedNode.parentId = TRASH_ID;
    const state = mutableTimelineHost(projection);
    const timeline = new TimelineMemoryStore(state.host);

    await timeline.ensureTagDefinitions();

    expect(state.calls).toHaveLength(1);
    expect(state.calls[0]?.changes).toEqual([
      expect.objectContaining({
        op: 'ensure',
        resource: 'definition',
        id: movedDefinition.tagId,
        name: movedDefinition.name,
      }),
    ]);
    expect(state.projection().nodes.find((entry) => entry.id === movedDefinition.tagId)).toMatchObject({
      content: { text: movedDefinition.name },
      parentId: SCHEMA_ID,
      locked: true,
    });
  });

  test('persists immutable admission, disable intervals, and reset barriers', () => {
    const store = memoryStore();
    const status = store.status();
    store.writeAdmission({
      threadId: THREAD_ID,
      turnId: TURN_ID,
      featureModeAtAdmission: 'enabled',
      threadModeAtAdmission: 'enabled',
      eligibleAtAdmission: true,
      featureModeGeneration: status.featureModeGeneration,
      resetEpoch: status.resetEpoch,
      memoryVisibilityGeneration: status.memoryVisibilityGeneration,
      admittedAt: 10,
    });
    expect(store.admission(TURN_ID)?.eligibleAtAdmission).toBe(true);
    expect(() => store.writeAdmission({ ...store.admission(TURN_ID)!, eligibleAtAdmission: false })).toThrow('immutable');

    store.setFeatureMode('disabled', [TURN_ID], 20);
    expect(store.featureMode()).toBe('disabled');
    expect(store.isTurnExcluded(TURN_ID)).toBe(true);
    const generation = store.status().featureModeGeneration;
    store.setFeatureMode('enabled', [], 30);
    expect(store.status().featureModeGeneration).toBe(generation + 1);
    expect(store.admission(TURN_ID)?.eligibleAtAdmission).toBe(true);
    expect(store.isTurnExcluded(TURN_ID)).toBe(true);

    const resetPublication = publication('reset', {
      epoch: 1,
      excludedTurnIds: [TURN_ID],
      containerIds: [],
    });
    store.preparePublication(resetPublication);
    store.finalizeReset(resetPublication.id, 1, [TURN_ID]);
    expect(store.status().resetEpoch).toBe(1);

    const oldTurn = userTurn('old history', undefined, { kind: 'user' }, 'turn:old-epoch', 'item:old-epoch');
    store.writeAdmission({ ...admissionSnapshot(oldTurn), admittedAt: 15 });
    const newTurn = userTurn('new history', undefined, { kind: 'user' }, 'turn:new-epoch', 'item:new-epoch');
    store.writeAdmission({ ...admissionSnapshot(newTurn), resetEpoch: 1, admittedAt: 40 });
    const thread = rootThread([oldTurn, newTurn]);
    expect(collectMemoryEvidence({ thread, turns: thread.turns ?? [] }, store).items.map((item) => item.content))
      .toEqual(['new history']);
  });

  test('skips the orphan-admission sweep while a Thread is hidden from root enumeration', async () => {
    // The sweep deletes every admission row whose Turn it cannot enumerate, so it
    // is only sound over a complete list. A quarantined Thread is filtered out of
    // `persistentRootThreads()`, which would make its Turns look deleted and
    // discard its extraction state for good — a permanent write out of a
    // quarantine that is supposed to last one session.
    const quarantinedTurn = userTurn('history behind a quarantine', undefined, { kind: 'user' }, 'turn:hidden', 'item:hidden');
    const hidden = rootThread([quarantinedTurn]);

    for (const hasHiddenRootThreads of [true, false]) {
      const store = memoryStore();
      store.writeAdmission(admissionSnapshot(quarantinedTurn));
      expect(store.admission(quarantinedTurn.id)).not.toBeNull();
      const extension = new MemoryExtension(store, new TimelineMemoryStore(mutableTimelineHost(memoryProjection()).host));
      extension.bindHost({
        ...memoryThreadHost(hidden),
        // What quarantine looks like to this consumer either way: the Thread is
        // simply absent. The flag is the only thing that tells it the absence is
        // not a deletion, so it is the only variable here.
        persistentRootThreads: () => [],
        hasHiddenRootThreads: () => hasHiddenRootThreads,
      });
      await extension.prepareForTurnAdmission();
      // Flag set: the row survives. Flag clear: the sweep runs over an empty set
      // and deletes it — which is exactly what the flag exists to prevent.
      expect(store.admission(quarantinedTurn.id) === null).toBe(!hasHiddenRootThreads);
    }
  });

  test('coalesces concurrent turn-admission preparation and retries a failed attempt', async () => {
    const store = memoryStore();
    const timeline = new TimelineMemoryStore(mutableTimelineHost(memoryProjection()).host);
    const extension = new MemoryExtension(store, timeline);
    extension.bindHost(memoryThreadHost(rootThread([])));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const error = new Error('Tag definition read failed');
    const ensure = spyOn(timeline, 'ensureTagDefinitions').mockImplementationOnce(async () => {
      await gate;
      throw error;
    });
    try {
      const first = extension.prepareForTurnAdmission();
      const second = extension.prepareForTurnAdmission();
      expect(first).toBe(second);
      expect(ensure).toHaveBeenCalledTimes(1);
      const failed = Promise.allSettled([first, second]);
      release();
      expect(await failed).toEqual([
        { status: 'rejected', reason: error }, { status: 'rejected', reason: error },
      ]);
      ensure.mockRestore();
      const retryEnsure = spyOn(timeline, 'ensureTagDefinitions');
      try {
        const retry = extension.prepareForTurnAdmission();
        expect(extension.prepareForTurnAdmission()).toBe(retry);
        await retry;
        await extension.prepareForTurnAdmission();
        expect(retryEnsure).toHaveBeenCalledTimes(1);
      } finally {
        retryEnsure.mockRestore();
      }
    } finally {
      ensure.mockRestore();
      await extension.stopWorker();
    }
  });

  test('commits rollback invalidation atomically and removes stale origins', () => {
    const store = memoryStore();
    expect(store.claimOrigin(ITEM_ID, THREAD_ID, TURN_ID, '2026-07-24', 'hash')).toBe(true);
    const node = generatedNode();
    store.replaceGeneratedNodes(THREAD_ID, [node], [{
      nodeId: node.nodeId,
      threadId: THREAD_ID,
      turnId: TURN_ID,
      originItemId: ITEM_ID,
    }]);
    const suppression = store.generatedNodeIdsSupportedOnlyByTurns([TURN_ID]);
    expect(suppression).toEqual({ nodeIds: [MEMORY_NODE_ID], complete: true });
    store.prepareRollback({
      rollbackId: 'rollback:1',
      threadId: THREAD_ID,
      omittedTurnIds: [TURN_ID],
      beforeVersion: 1,
      afterVersion: 2,
      suppressedNodeIds: suppression.nodeIds,
      suppressAllGenerated: false,
    });
    store.commitRollback('rollback:1');
    expect(store.rollback('rollback:1')?.status).toBe('committed');
    expect(store.isOriginClaimed(ITEM_ID)).toBe(false);
    expect(store.generatedNodeIdsWithoutCurrentSupport()).toEqual([MEMORY_NODE_ID]);
    expect(store.nextJob()?.kind).toBe('rollback');
  });

  test('removes citation usage contributed by a rolled-back response Turn', () => {
    const store = memoryStore();
    const citationTurnId = 'turn:citation';
    expect(store.claimOrigin(ITEM_ID, THREAD_ID, TURN_ID, '2026-07-24', 'hash')).toBe(true);
    store.recordCitationUsage({
      citationItemId: 'item:citation',
      citationTurnId,
      nodeId: MEMORY_NODE_ID,
      originItemIds: [ITEM_ID],
    }, 10);
    expect(store.usageForNode(MEMORY_NODE_ID).count).toBe(1);

    store.prepareRollback({
      rollbackId: 'rollback:citation',
      threadId: THREAD_ID,
      omittedTurnIds: [citationTurnId],
      beforeVersion: 1,
      afterVersion: 2,
      suppressedNodeIds: [],
      suppressAllGenerated: false,
    });
    store.commitRollback('rollback:citation');

    expect(store.usageForNode(MEMORY_NODE_ID).count).toBe(0);
    expect(store.isOriginClaimed(ITEM_ID)).toBe(true);
  });

  test('recognizes only canonical Daily Memory hierarchy and preserves stray tags', () => {
    const projection = memoryProjection();
    const graph = canonicalMemoryGraph(projection);
    expect(graph.containers.map((entry) => entry.node.id)).toEqual([MEMORY_NODE_ID]);
    expect(graph.nodes.map((entry) => entry.node.id)).toEqual([MEMORY_NODE_ID, EPISODE_NODE_ID, BELIEF_NODE_ID]);
    expect(graph.strayTaggedNodeIds).toEqual(['stray:1']);

    const store = memoryStore();
    const extension = new MemoryExtension(store, new TimelineMemoryStore(readOnlyTimelineHost(projection)));
    expect(extension.settings().status.strayTaggedNodeCount).toBe(1);
  });

  test('routes Memory lookup without injecting prose and counts only an inline citation of an exact get', () => {
    const { extension, store, targetThread, activeTurn, projection } = memoryUsageHarness();
    const context = extension.contributeThreadContext(targetThread);
    expect(context?.additionalContext?.memory?.value).toContain('use outline find');
    expect(context?.additionalContext?.memory?.value).toContain('outline --json get');
    expect(context?.additionalContext?.memory?.value).toContain('[[node://UUID]]');
    expect(context?.additionalContext?.memory?.value).not.toContain('Belief');

    completeOutlineGet(extension, targetThread, activeTurn, projection, [MEMORY_NODE_ID]);
    completeMemoryTurn(
      extension,
      targetThread,
      completedResponseTurn(activeTurn, `Used the saved preference ${formatNodeReferenceMarker(MEMORY_NODE_ID)}.`),
    );
    expect(store.usageForNode(MEMORY_NODE_ID).count).toBe(1);
  });

  test('ignores a default summary get for citation accounting', () => {
    const { extension, store, targetThread, activeTurn, projection } = memoryUsageHarness();
    extension.contributeThreadContext(targetThread);
    completeOutlineGet(extension, targetThread, activeTurn, projection, [MEMORY_NODE_ID], {
      command: `outline get ${MEMORY_NODE_ID}`,
    });
    completeMemoryTurn(
      extension,
      targetThread,
      completedResponseTurn(activeTurn, formatNodeReferenceMarker(MEMORY_NODE_ID)),
    );
    expect(store.usageForNode(MEMORY_NODE_ID).count).toBe(0);
  });

  test('does not count find results, ordinary Nodes, failed gets, or uncited Memory reads', () => {
    const { extension, store, targetThread, activeTurn, projection } = memoryUsageHarness();
    extension.contributeThreadContext(targetThread);
    completeOutlineGet(extension, targetThread, activeTurn, projection, [MEMORY_NODE_ID], {
      command: `outline find ${MEMORY_NODE_ID}`,
    });
    completeOutlineGet(extension, targetThread, activeTurn, projection, ['ordinary:1']);
    completeOutlineGet(extension, targetThread, activeTurn, projection, [MEMORY_NODE_ID], { ok: false });
    completeOutlineGet(extension, targetThread, activeTurn, projection, [MEMORY_NODE_ID]);

    completeMemoryTurn(extension, targetThread, completedResponseTurn(activeTurn));
    expect(store.usageForNode(MEMORY_NODE_ID).count).toBe(0);
  });

  test('does not count literal Memory markers in code or existing Markdown links', () => {
    const { extension, store, targetThread, activeTurn, projection } = memoryUsageHarness();
    extension.contributeThreadContext(targetThread);
    completeOutlineGet(extension, targetThread, activeTurn, projection, [MEMORY_NODE_ID]);
    const marker = formatNodeReferenceMarker(MEMORY_NODE_ID);
    const response = [
      `Inline code: \`${marker}\``,
      `\`\`\`text\n${marker}\n\`\`\``,
      `[Existing link](https://example.test/${marker} "${marker}")`,
    ].join('\n\n');

    completeMemoryTurn(extension, targetThread, completedResponseTurn(activeTurn, response));
    expect(store.usageForNode(MEMORY_NODE_ID).count).toBe(0);
  });

  test('deduplicates shown Memory Nodes and bounds inline citation accounting', () => {
    const projection = memoryProjection(10);
    const { extension, store, targetThread, activeTurn } = memoryUsageHarness(projection);
    const memoryNodeIds = canonicalMemoryGraph(projection).nodes.map((entry) => entry.node.id);
    extension.contributeThreadContext(targetThread);
    completeOutlineGet(extension, targetThread, activeTurn, projection, memoryNodeIds);
    completeOutlineGet(extension, targetThread, activeTurn, projection, memoryNodeIds);

    completeMemoryTurn(
      extension,
      targetThread,
      completedResponseTurn(activeTurn, memoryNodeIds.map(formatNodeReferenceMarker).join(' ')),
    );
    expect(memoryNodeIds.map((nodeId) => store.usageForNode(nodeId).count > 0)).toEqual([
      ...Array.from({ length: 8 }, () => true),
      ...Array.from({ length: memoryNodeIds.length - 8 }, () => false),
    ]);
  });

  test('admits only local non-Automation evidence and reuses the claimed source date', () => {
    const store = memoryStore();
    const thread = rootThread([
      userTurn('remember local evidence'),
      userTurn('automation evidence', undefined, { kind: 'feature', feature: 'automation' }, 'turn:auto', 'item:auto'),
      userTurn('forked evidence', undefined, { kind: 'user' }, 'turn:fork', 'item:fork', 'thread:origin'),
    ]);
    for (const turn of thread.turns ?? []) {
      store.writeAdmission({
        threadId: THREAD_ID,
        turnId: turn.id,
        featureModeAtAdmission: 'enabled',
        threadModeAtAdmission: 'enabled',
        eligibleAtAdmission: true,
        featureModeGeneration: 0,
        resetEpoch: 0,
        memoryVisibilityGeneration: 0,
        admittedAt: 1,
      });
    }
    expect(store.claimOrigin(ITEM_ID, THREAD_ID, TURN_ID, '2020-01-02', 'old-hash')).toBe(true);
    const evidence = collectMemoryEvidence({ thread, turns: thread.turns ?? [] }, store);
    expect(evidence.items.map((item) => item.content)).toEqual(['remember local evidence']);
    expect(evidence.items[0]?.sourceDate).toBe('2020-01-02');
  });

  test('keeps completed tool evidence attributable to its presentation arguments', () => {
    const store = memoryStore();
    const baseTurn = userTurn('run the tools');
    const provenance = (id: string) => ({
      originThreadId: THREAD_ID,
      originTurnId: baseTurn.id,
      originItemId: id,
    });
    const turn: Turn = {
      ...baseTurn,
      items: [
        {
          type: 'commandExecution',
          id: 'memory-command',
          provenance: provenance('memory-command'),
          command: 'npm test',
          description: 'Run tests',
          cwd: '/workspace',
          processId: null,
          status: 'completed',
          commandActions: [],
          aggregatedOutput: '42 tests passed',
          exitCode: 0,
          durationMs: 10,
          outputRef: null,
          modelCall: replayableModelCall('bash', { command: 'npm test' }),
        },
        {
          type: 'mcpToolCall',
          id: 'memory-mcp',
          provenance: provenance('memory-mcp'),
          server: 'docs',
          tool: 'search',
          status: 'completed',
          arguments: { query: 'canonical history' },
          pluginId: null,
          result: { matches: 2 },
          error: null,
          durationMs: 5,
          outputRef: null,
          modelCall: replayableModelCall('docs__search', { query: 'canonical history' }),
        },
        {
          type: 'dynamicToolCall',
          id: 'memory-dynamic',
          provenance: provenance('memory-dynamic'),
          namespace: null,
          tool: 'file_read',
          arguments: { file_path: '/workspace/spec.md' },
          status: 'completed',
          contentItems: [{ type: 'text', text: 'spec contents' }],
          success: true,
          durationMs: 4,
          outputRef: null,
          modelCall: replayableModelCall('file_read', { file_path: '/workspace/spec.md' }),
        },
      ],
    };
    store.writeAdmission(admissionSnapshot(turn));
    const thread = rootThread([turn]);
    const content = collectMemoryEvidence({ thread, turns: [turn] }, store).items
      .map((item) => item.content).join('\n');

    expect(content).toContain('"command":"npm test"');
    expect(content).toContain('"cwd":"/workspace"');
    expect(content).toContain('"tool":"docs.search"');
    expect(content).toContain('"query":"canonical history"');
    expect(content).toContain('"file_path":"/workspace/spec.md"');
  });

  test('fingerprints all eligible evidence while sending only the latest bounded window', () => {
    const store = memoryStore();
    const turns = Array.from({ length: 501 }, (_, index) => userTurn(
      `evidence ${index}`,
      undefined,
      { kind: 'user' },
      `turn:long:${index}`,
      `item:long:${index}`,
    ));
    const thread = rootThread(turns);
    for (const turn of turns) store.writeAdmission(admissionSnapshot(turn));

    const first = collectMemoryEvidence({ thread, turns }, store);
    expect(first.items).toHaveLength(500);
    expect(first.items[0]?.originItemId).toBe('item:long:1');
    expect(first.items.at(-1)?.originItemId).toBe('item:long:500');

    const next = userTurn(
      'evidence 501',
      undefined,
      { kind: 'user' },
      'turn:long:501',
      'item:long:501',
    );
    store.writeAdmission(admissionSnapshot(next));
    const second = collectMemoryEvidence({ thread, turns: [...turns, next] }, store);
    expect(second.sourceVersion).not.toBe(first.sourceVersion);
    expect(second.items[0]?.originItemId).toBe('item:long:2');
    expect(second.items.at(-1)?.originItemId).toBe('item:long:501');
  });

  test('never backfills activity admitted while global or Thread Memory is disabled', () => {
    const store = memoryStore();
    const globalDisabledTurn = userTurn(
      'global disabled activity',
      undefined,
      { kind: 'user' },
      'turn:global-disabled',
      'item:global-disabled',
    );
    const threadDisabledTurn = userTurn(
      'thread disabled activity',
      undefined,
      { kind: 'user' },
      'turn:thread-disabled',
      'item:thread-disabled',
    );
    const enabledTurn = userTurn(
      'eligible activity',
      undefined,
      { kind: 'user' },
      'turn:enabled',
      'item:enabled',
    );
    const thread = rootThread([globalDisabledTurn, threadDisabledTurn, enabledTurn]);
    const extension = new MemoryExtension(store, new TimelineMemoryStore(readOnlyTimelineHost(memoryProjection())));
    extension.bindHost(memoryThreadHost(thread));

    store.setFeatureMode('disabled', []);
    extension.contributeTurnAdmission(admissionContext(thread, globalDisabledTurn));
    store.setFeatureMode('enabled', []);
    store.setThreadMode(thread.id, 'disabled');
    extension.contributeTurnAdmission(admissionContext(thread, threadDisabledTurn));
    store.setThreadMode(thread.id, 'enabled');
    extension.contributeTurnAdmission(admissionContext(thread, enabledTurn));

    const evidence = collectMemoryEvidence({ thread, turns: thread.turns ?? [] }, store);
    expect(evidence.items.map((item) => item.content)).toEqual(['eligible activity']);
    expect(store.admission(globalDisabledTurn.id)?.eligibleAtAdmission).toBe(false);
    expect(store.admission(threadDisabledTurn.id)?.eligibleAtAdmission).toBe(false);
  });

  test('keeps incremental mutation membership equivalent to a full projection scan', () => {
    const projection = memoryProjection();
    const index = new MemoryMutationIndex(projection);
    expect(index.debugSnapshot()).toEqual(fullScanMemoryMutationSnapshot(projection));
    expect(index.canonicalNodesInGraphOrder().map((entry) => entry.node.id))
      .toEqual(canonicalMemoryGraph(projection).nodes.map((entry) => entry.node.id));

    applyMemoryIndexDelta(projection, index, [patchProjectionNode(projection, 'ordinary:1', {
      content: { text: 'Ordinary edit', spans: [] },
    })]);
    expect(index.debugSnapshot()).toEqual(fullScanMemoryMutationSnapshot(projection));

    applyMemoryIndexDelta(projection, index, [patchProjectionNode(projection, 'day', {
      content: { text: '2026-07-25', spans: [] },
    })]);
    expect(index.debugSnapshot()).toEqual(fullScanMemoryMutationSnapshot(projection));
    expect(index.canonicalNodesInGraphOrder().map((entry) => entry.node.id))
      .toEqual(canonicalMemoryGraph(projection).nodes.map((entry) => entry.node.id));

    applyMemoryIndexDelta(projection, index, [
      patchProjectionNode(projection, 'day', { children: [] }),
      patchProjectionNode(projection, MEMORY_NODE_ID, { parentId: TRASH_ID }),
    ]);
    expect(index.debugSnapshot()).toEqual(fullScanMemoryMutationSnapshot(projection));
    expect(index.fullRebuildCount()).toBe(1);
  });

  test('degrades cyclic ancestor state without hanging canonical classification', () => {
    const projection = memoryProjection();
    const index = new MemoryMutationIndex(projection);
    const cyclicEpisode = patchProjectionNode(projection, EPISODE_NODE_ID, { parentId: BELIEF_NODE_ID });

    expect(() => index.applyProjectionUpdate({
      kind: 'delta',
      revision: 1,
      todayId: projection.todayId,
      changedNodes: [cyclicEpisode],
      removedIds: [],
    })).not.toThrow();
    replaceProjectionNodes(projection, [cyclicEpisode]);

    expect(index.canonicalNodesInGraphOrder().map((entry) => entry.node.id)).toEqual([MEMORY_NODE_ID]);
  });

  test('reconciles Runtime projection events without full graph scans', async () => {
    const store = memoryStore();
    const projection = memoryProjection();
    projection.nodes.find((entry) => entry.id === WORKSPACE_ID)!.children.push('ordinary:2');
    projection.nodes.push(node('ordinary:2', WORKSPACE_ID, [], [], 'Ordinary outline node'));
    const timeline = new TimelineMemoryStore(readOnlyTimelineHost(projection));
    seedGeneratedGraph(store, timeline);
    const extension = new MemoryExtension(store, timeline);
    extension.initializeMutationIndex(projection);
    const originalGraph = timeline.graph.bind(timeline);
    let fullGraphReads = 0;
    Object.assign(timeline, {
      graph: (override?: DocumentProjection) => {
        fullGraphReads += 1;
        return originalGraph(override);
      },
    });
    const wakes: string[] = [];
    Object.assign(extension as unknown as Record<string, unknown>, {
      initialized: true,
      pipeline: {
        wakeGlobal: (reason: string) => wakes.push(reason),
        close: async () => undefined,
      },
    });
    const renamedDay = patchProjectionNode(projection, 'day', {
      content: { text: '2026-07-25', spans: [] },
    });
    replaceProjectionNodes(projection, [renamedDay]);
    extension.projectionChanged(memoryProjectionDelivery({
      kind: 'delta',
      revision: 1,
      todayId: projection.todayId,
      changedNodes: [renamedDay],
      removedIds: [],
    }, true));
    expect(store.generatedNodes().every((entry) => entry.userAuthoritative)).toBe(true);
    expect(extension.mutationIndexFullRebuildCount()).toBe(1);
    expect(extension.graphDigestComputationCount()).toBe(0);
    const firstGraphTimer = (extension as unknown as { graphChangeTimer?: ReturnType<typeof setTimeout> })
      .graphChangeTimer;

    const renamedBelief = patchProjectionNode(projection, BELIEF_NODE_ID, {
      content: { text: 'Edited belief', spans: [] },
    });
    replaceProjectionNodes(projection, [renamedBelief]);
    extension.projectionChanged(memoryProjectionDelivery({
      kind: 'delta',
      revision: 2,
      todayId: projection.todayId,
      changedNodes: [renamedBelief],
      removedIds: [],
    }, true));
    expect((extension as unknown as { graphChangeTimer?: ReturnType<typeof setTimeout> }).graphChangeTimer)
      .toBe(firstGraphTimer);
    await extension.stopWorker();
    expect(extension.graphDigestComputationCount()).toBe(1);
    expect(fullGraphReads).toBe(0);
    expect(wakes).toEqual(['memory-graph-changed']);
  });

  test('does not rearm graph work while the worker is stopping and contains wake failures', async () => {
    const store = memoryStore();
    const projection = memoryProjection();
    const timeline = new TimelineMemoryStore(readOnlyTimelineHost(projection));
    const errors: string[] = [];
    const extension = new MemoryExtension(store, timeline, {
      onError: (_error, operation) => errors.push(operation),
    });
    extension.initializeMutationIndex(projection);
    let releaseClose = () => undefined;
    const closing = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    Object.assign(extension as unknown as Record<string, unknown>, {
      initialized: true,
      pipeline: {
        wakeGlobal: () => { throw new Error('closed pipeline'); },
        close: () => closing,
      },
    });
    const renamedBelief = patchProjectionNode(projection, BELIEF_NODE_ID, {
      content: { text: 'Changed before stop', spans: [] },
    });
    replaceProjectionNodes(projection, [renamedBelief]);
    extension.projectionChanged(memoryProjectionDelivery({
      kind: 'delta',
      revision: 1,
      todayId: projection.todayId,
      changedNodes: [renamedBelief],
      removedIds: [],
    }, true));

    const stopping = extension.stopWorker();
    expect(errors).toEqual(['graph-wake']);
    expect((extension as unknown as { graphChangeTimer?: ReturnType<typeof setTimeout> }).graphChangeTimer)
      .toBeUndefined();

    const renamedAgain = patchProjectionNode(projection, BELIEF_NODE_ID, {
      content: { text: 'Changed during stop', spans: [] },
    });
    replaceProjectionNodes(projection, [renamedAgain]);
    extension.projectionChanged(memoryProjectionDelivery({
      kind: 'delta',
      revision: 2,
      todayId: projection.todayId,
      changedNodes: [renamedAgain],
      removedIds: [],
    }, true));
    expect((extension as unknown as { graphChangeTimer?: ReturnType<typeof setTimeout> }).graphChangeTimer)
      .toBeUndefined();

    releaseClose();
    await expect(stopping).resolves.toBeUndefined();
    expect(errors).toEqual(['graph-wake']);
  });

  test('removes every generated descendant when an ancestor enters Trash', async () => {
    const store = memoryStore();
    const projection = memoryProjection();
    const timeline = new TimelineMemoryStore(readOnlyTimelineHost(projection));
    seedGeneratedGraph(store, timeline);
    const extension = new MemoryExtension(store, timeline);
    extension.initializeMutationIndex(projection);
    const day = patchProjectionNode(projection, 'day', { children: [] });
    const container = patchProjectionNode(projection, MEMORY_NODE_ID, { parentId: TRASH_ID });
    replaceProjectionNodes(projection, [day, container]);

    extension.projectionChanged(memoryProjectionDelivery({
      kind: 'delta',
      revision: 1,
      todayId: projection.todayId,
      changedNodes: [day, container],
      removedIds: [],
    }, true));
    expect(store.generatedNodes()).toEqual([]);
    expect(extension.mutationIndexFullRebuildCount()).toBe(1);
    await extension.stopWorker();
  });

  test('preserves generated cleanup and wake semantics for sparse canonical graph exits', async () => {
    const scenarios: Array<{
      readonly name: string;
      readonly mutate: (projection: DocumentProjection) => ProjectionUpdate;
      readonly remainingNodeIds: readonly string[];
    }> = [
      {
        name: 'memory tag removal',
        mutate: (projection) => {
          const container = patchProjectionNode(projection, MEMORY_NODE_ID, { tags: [] });
          replaceProjectionNodes(projection, [container]);
          return {
            kind: 'delta',
            revision: 1,
            todayId: projection.todayId,
            changedNodes: [container],
            removedIds: [],
          };
        },
        remainingNodeIds: [],
      },
      {
        name: 'id-only deletion',
        mutate: (projection) => {
          replaceProjectionNodes(projection, [], [BELIEF_NODE_ID]);
          return {
            kind: 'delta',
            revision: 1,
            todayId: projection.todayId,
            changedNodes: [],
            removedIds: [BELIEF_NODE_ID],
          };
        },
        remainingNodeIds: [MEMORY_NODE_ID, EPISODE_NODE_ID].sort(),
      },
      {
        name: 'day moved out of Daily Notes',
        mutate: (projection) => {
          const day = patchProjectionNode(projection, 'day', { parentId: WORKSPACE_ID });
          replaceProjectionNodes(projection, [day]);
          return {
            kind: 'delta',
            revision: 1,
            todayId: projection.todayId,
            changedNodes: [day],
            removedIds: [],
          };
        },
        remainingNodeIds: [],
      },
    ];

    for (const scenario of scenarios) {
      const store = memoryStore();
      const projection = memoryProjection();
      const timeline = new TimelineMemoryStore(readOnlyTimelineHost(projection));
      seedGeneratedGraph(store, timeline);
      const extension = new MemoryExtension(store, timeline);
      extension.initializeMutationIndex(projection);
      const wakes: string[] = [];
      Object.assign(extension as unknown as Record<string, unknown>, {
        initialized: true,
        pipeline: {
          wakeGlobal: (reason: string) => wakes.push(reason),
          close: async () => undefined,
        },
      });

      extension.projectionChanged(memoryProjectionDelivery(scenario.mutate(projection), true));

      expect(store.generatedNodes().map((entry) => entry.nodeId).sort(), scenario.name)
        .toEqual(scenario.remainingNodeIds);
      expect(extension.mutationIndexFullRebuildCount(), scenario.name).toBe(1);
      await extension.stopWorker();
      expect(wakes, scenario.name).toEqual(['memory-graph-changed']);
    }
  });

  test('reconciles every generated descendant when its container moves to another day', async () => {
    const store = memoryStore();
    const projection = memoryProjection();
    const timeline = new TimelineMemoryStore(readOnlyTimelineHost(projection));
    seedGeneratedGraph(store, timeline);
    const extension = new MemoryExtension(store, timeline);
    extension.initializeMutationIndex(projection);
    const wakes: string[] = [];
    Object.assign(extension as unknown as Record<string, unknown>, {
      initialized: true,
      pipeline: {
        wakeGlobal: (reason: string) => wakes.push(reason),
        close: async () => undefined,
      },
    });
    const firstDay = patchProjectionNode(projection, 'day', { children: [] });
    const secondDay = node('day:2', 'week', [MEMORY_NODE_ID], [TAG_DAY_ID], '2026-07-25');
    const week = patchProjectionNode(projection, 'week', { children: ['day', secondDay.id] });
    const container = patchProjectionNode(projection, MEMORY_NODE_ID, { parentId: secondDay.id });
    replaceProjectionNodes(projection, [firstDay, secondDay, week, container]);

    extension.projectionChanged(memoryProjectionDelivery({
      kind: 'delta',
      revision: 1,
      todayId: projection.todayId,
      changedNodes: [firstDay, secondDay, week, container],
      removedIds: [],
    }, true));

    expect(store.generatedNodes()).not.toEqual([]);
    expect(store.generatedNodes().every((entry) => entry.userAuthoritative)).toBe(true);
    expect(extension.mutationIndexFullRebuildCount()).toBe(1);
    await extension.stopWorker();
    expect(wakes).toEqual(['memory-graph-changed']);
  });

  test('wakes for a derived source-date change without generated control rows', async () => {
    const store = memoryStore();
    const projection = memoryProjection();
    const timeline = new TimelineMemoryStore(readOnlyTimelineHost(projection));
    const extension = new MemoryExtension(store, timeline);
    extension.initializeMutationIndex(projection);
    const wakes: string[] = [];
    Object.assign(extension as unknown as Record<string, unknown>, {
      initialized: true,
      pipeline: {
        wakeGlobal: (reason: string) => wakes.push(reason),
        close: async () => undefined,
      },
    });
    const renamedDay = patchProjectionNode(projection, 'day', {
      content: { text: '2026-07-25', spans: [] },
    });
    replaceProjectionNodes(projection, [renamedDay]);

    extension.projectionChanged(memoryProjectionDelivery({
      kind: 'delta',
      revision: 1,
      todayId: projection.todayId,
      changedNodes: [renamedDay],
      removedIds: [],
    }, true));
    await extension.stopWorker();

    expect(store.generatedNodes()).toEqual([]);
    expect(wakes).toEqual(['memory-graph-changed']);
  });

  test('caches generated Node reads until a write invalidates them', () => {
    const database = new Database(':memory:');
    let generatedSelects = 0;
    const instrumented: SqliteDatabase = {
      exec: (sql) => database.exec(sql),
      prepare: (sql) => {
        if (/^SELECT \* FROM generated_nodes ORDER BY/.test(sql.trim())) generatedSelects += 1;
        return database.prepare(sql) as unknown as ReturnType<SqliteDatabase['prepare']>;
      },
      close: () => database.close(),
    };
    const store = new MemoryControlStore(':memory:', instrumented);
    stores.push(store);
    store.replaceGeneratedNodes(THREAD_ID, [generatedNode()], []);

    expect(store.generatedNodes()).toHaveLength(1);
    expect(store.generatedNodeIds().has(MEMORY_NODE_ID)).toBe(true);
    expect(store.generatedNodesById().get(MEMORY_NODE_ID)).toBeDefined();
    expect(store.generatedNodes()).toHaveLength(1);
    expect(generatedSelects).toBe(1);

    store.markNodeUserAuthoritative(MEMORY_NODE_ID);
    expect(store.generatedNodesById().get(MEMORY_NODE_ID)?.userAuthoritative).toBe(true);
    expect(generatedSelects).toBe(2);
  });

  test('queries unsupported generated Nodes with one cached join', () => {
    const database = new Database(':memory:');
    let unsupportedJoinSelects = 0;
    const instrumented: SqliteDatabase = {
      exec: (sql) => database.exec(sql),
      prepare: (sql) => {
        const normalized = sql.replace(/\s+/g, ' ').trim();
        if (
          normalized.includes('FROM generated_nodes AS generated')
          && normalized.includes('LEFT JOIN node_lineage AS lineage')
          && normalized.includes('LEFT JOIN origin_claims AS origin')
        ) unsupportedJoinSelects += 1;
        return database.prepare(sql) as unknown as ReturnType<SqliteDatabase['prepare']>;
      },
      close: () => database.close(),
    };
    const store = new MemoryControlStore(':memory:', instrumented);
    stores.push(store);
    const unsupportedOriginId = 'item:unsupported';
    expect(store.claimOrigin(ITEM_ID, THREAD_ID, TURN_ID, '2026-07-24', 'hash')).toBe(true);
    store.replaceGeneratedNodes(THREAD_ID, [
      generatedNode(),
      { ...generatedNode(), nodeId: EPISODE_NODE_ID },
    ], [
      { nodeId: MEMORY_NODE_ID, threadId: THREAD_ID, turnId: TURN_ID, originItemId: ITEM_ID },
      { nodeId: EPISODE_NODE_ID, threadId: THREAD_ID, turnId: TURN_ID, originItemId: unsupportedOriginId },
    ]);

    expect(store.generatedNodeIdsWithoutCurrentSupport()).toEqual([EPISODE_NODE_ID]);
    expect(store.generatedNodeIdsWithoutCurrentSupport()).toEqual([EPISODE_NODE_ID]);
    expect(unsupportedJoinSelects).toBe(1);

    expect(store.claimOrigin(unsupportedOriginId, THREAD_ID, TURN_ID, '2026-07-24', 'hash:second')).toBe(true);
    expect(store.generatedNodeIdsWithoutCurrentSupport()).toEqual([]);
    expect(unsupportedJoinSelects).toBe(2);
  });

  test('invalidates polluted origins before global reconciliation', () => {
    const store = memoryStore();
    expect(store.claimOrigin(ITEM_ID, THREAD_ID, TURN_ID, '2026-07-24', 'hash')).toBe(true);
    store.markThreadPolluted(THREAD_ID, 10);
    expect(store.source(THREAD_ID)?.polluted).toBe(true);
    expect(store.isOriginClaimed(ITEM_ID)).toBe(false);
    expect(store.nextJob(10)?.kind).toBe('phase2');
  });

  test('withdraws prior generated lineage when extraction now has no output', () => {
    const store = memoryStore();
    expect(store.claimOrigin(ITEM_ID, THREAD_ID, TURN_ID, '2026-07-24', 'hash')).toBe(true);
    store.replaceGeneratedNodes(THREAD_ID, [generatedNode()], [{
      nodeId: MEMORY_NODE_ID,
      threadId: THREAD_ID,
      turnId: TURN_ID,
      originItemId: ITEM_ID,
    }]);
    store.finalizeStage1NoOutput(THREAD_ID, 'empty-version', 10);
    expect(store.source(THREAD_ID)).toMatchObject({
      sourceVersion: 'empty-version',
      status: 'succeededNoOutput',
    });
    expect(store.lineageForNode(MEMORY_NODE_ID)).toEqual([]);
    expect(store.generatedNodeIdsWithoutCurrentSupport()).toEqual([MEMORY_NODE_ID]);
    expect(store.nextJob(10)?.kind).toBe('phase2');
  });

  test('treats generated Node moves and tag changes as authoritative user edits', () => {
    const movedStore = memoryStore();
    const movedProjection = memoryProjection();
    const movedTimeline = new TimelineMemoryStore(readOnlyTimelineHost(movedProjection));
    const movedEntry = canonicalMemoryGraph(movedProjection).nodes.find((entry) => entry.node.id === BELIEF_NODE_ID)!;
    movedStore.replaceGeneratedNodes(THREAD_ID, [{
      nodeId: movedEntry.node.id,
      category: movedEntry.category,
      sourceDate: movedEntry.sourceDate,
      fingerprint: timelineNodeFingerprint(movedEntry),
      userAuthoritative: false,
      generatedAt: 1,
    }], []);
    const movedExtension = new MemoryExtension(movedStore, movedTimeline);
    movedExtension.bindHost(memoryThreadHost(rootThread([])));
    movedExtension.initializeMutationIndex(movedProjection);
    const movedBelief = movedProjection.nodes.find((entry) => entry.id === BELIEF_NODE_ID)!;
    movedBelief.content = { text: 'System publication text', spans: [] };
    movedExtension.projectionChanged({
      update: {
        kind: 'delta', revision: 1, todayId: movedProjection.todayId,
        changedNodes: [movedBelief], removedIds: [],
      },
      operation: memoryPublicationOperation(),
    });
    expect(movedStore.generatedNodes()[0]?.userAuthoritative).toBe(false);
    movedBelief.content = { text: 'Belief', spans: [] };
    movedExtension.projectionChanged({
      update: {
        kind: 'delta', revision: 2, todayId: movedProjection.todayId,
        changedNodes: [movedBelief], removedIds: [],
      },
    });
    expect(movedStore.generatedNodes()[0]?.userAuthoritative).toBe(false);

    const secondEpisode = node('episode:2', MEMORY_NODE_ID, [BELIEF_NODE_ID], ['tag:d-episode'], 'Second episode');
    movedProjection.nodes.push(secondEpisode);
    const container = movedProjection.nodes.find((entry) => entry.id === MEMORY_NODE_ID)!;
    container.children = [EPISODE_NODE_ID, secondEpisode.id];
    const firstEpisode = movedProjection.nodes.find((entry) => entry.id === EPISODE_NODE_ID)!;
    firstEpisode.children = [];
    const belief = movedProjection.nodes.find((entry) => entry.id === BELIEF_NODE_ID)!;
    belief.parentId = secondEpisode.id;
    movedExtension.projectionChanged({
      update: {
        kind: 'delta', revision: 3, todayId: movedProjection.todayId,
        changedNodes: [secondEpisode, container, firstEpisode, belief], removedIds: [],
      },
    });
    expect(movedStore.generatedNodes()[0]?.userAuthoritative).toBe(true);

    const taggedStore = memoryStore();
    const taggedProjection = memoryProjection();
    const taggedTimeline = new TimelineMemoryStore(readOnlyTimelineHost(taggedProjection));
    const taggedEntry = canonicalMemoryGraph(taggedProjection).nodes.find((entry) => entry.node.id === BELIEF_NODE_ID)!;
    taggedStore.replaceGeneratedNodes(THREAD_ID, [{
      nodeId: taggedEntry.node.id,
      category: taggedEntry.category,
      sourceDate: taggedEntry.sourceDate,
      fingerprint: timelineNodeFingerprint(taggedEntry),
      userAuthoritative: false,
      generatedAt: 1,
    }], []);
    const taggedExtension = new MemoryExtension(taggedStore, taggedTimeline);
    taggedExtension.bindHost(memoryThreadHost(rootThread([])));
    taggedExtension.initializeMutationIndex(taggedProjection);
    const taggedBelief = taggedProjection.nodes.find((entry) => entry.id === BELIEF_NODE_ID)!;
    taggedBelief.tags.push('tag:personal');
    taggedExtension.projectionChanged({
      update: {
        kind: 'delta', revision: 1, todayId: taggedProjection.todayId,
        changedNodes: [taggedBelief], removedIds: [],
      },
    });
    expect(taggedStore.generatedNodes()[0]?.userAuthoritative).toBe(true);
  });

  test('publishes created consolidation Nodes with durable evidence lineage', async () => {
    const store = memoryStore();
    const timelineState = mutableTimelineHost(memoryProjection());
    const timeline = new TimelineMemoryStore(timelineState.host);
    seedGeneratedGraph(store, timeline);
    const phase = new Phase2(store, timeline, {
      run: async () => JSON.stringify({
        changes: [{
          temporaryId: 'new:open-question',
          action: 'create',
          parentId: EPISODE_NODE_ID,
          category: 'question',
          text: 'Which deployment constraint remains unresolved?',
          sourceNodeIds: [BELIEF_NODE_ID],
        }],
      }),
    }, () => rootThread([]));

    await expect(phase.run(new AbortController().signal)).resolves.toBe('published');
    const question = timeline.graph().nodes.find((entry) => entry.category === 'question');
    expect(question?.node.content.text).toBe('Which deployment constraint remains unresolved?');
    expect(store.generatedNodes().find((entry) => entry.nodeId === question?.node.id)).toMatchObject({
      category: 'question',
      userAuthoritative: false,
    });
    expect(store.lineageForNode(question!.node.id).map((entry) => entry.originItemId)).toEqual([ITEM_ID]);
  });

  test('replaces updated consolidation lineage with every cited current origin', async () => {
    const store = memoryStore();
    const projection = memoryProjection();
    const questionId = 'question:merge-source';
    const secondThreadId = 'thread:second';
    const secondTurnId = 'turn:second';
    const secondItemId = 'item:second';
    projection.nodes.push(node(questionId, EPISODE_NODE_ID, [], ['tag:d-question'], 'Second source'));
    projection.nodes.find((entry) => entry.id === EPISODE_NODE_ID)!.children.push(questionId);
    const timelineState = mutableTimelineHost(projection);
    const timeline = new TimelineMemoryStore(timelineState.host);
    seedGeneratedGraph(store, timeline);
    expect(store.claimOrigin(secondItemId, secondThreadId, secondTurnId, '2026-07-24', 'second-hash')).toBe(true);
    const question = timeline.graph().nodes.find((entry) => entry.node.id === questionId)!;
    store.replaceGeneratedNodes(secondThreadId, [{
      nodeId: questionId,
      category: question.category,
      sourceDate: question.sourceDate,
      fingerprint: timelineNodeFingerprint(question),
      userAuthoritative: false,
      generatedAt: Date.now(),
    }], [{
      nodeId: questionId,
      threadId: secondThreadId,
      turnId: secondTurnId,
      originItemId: secondItemId,
    }]);
    const phase = new Phase2(store, timeline, {
      run: async () => JSON.stringify({
        changes: [
          {
            nodeId: BELIEF_NODE_ID,
            action: 'update',
            text: 'Merged belief',
            sourceNodeIds: [BELIEF_NODE_ID, questionId],
          },
          { nodeId: questionId, action: 'delete' },
        ],
      }),
    }, () => rootThread([]));

    await expect(phase.run(new AbortController().signal)).resolves.toBe('published');
    expect(timeline.graph().nodes.find((entry) => entry.node.id === BELIEF_NODE_ID)?.node.content.text).toBe('Merged belief');
    expect(store.lineageForNode(BELIEF_NODE_ID).map((entry) => entry.originItemId)).toEqual([ITEM_ID, secondItemId]);
    expect(store.generatedNodes().some((entry) => entry.nodeId === questionId)).toBe(false);
  });

  test('deletes a complete generated consolidation subtree but never a retained descendant', async () => {
    const store = memoryStore();
    const timelineState = mutableTimelineHost(memoryProjection());
    const timeline = new TimelineMemoryStore(timelineState.host);
    seedGeneratedGraph(store, timeline);
    const deleteAll = new Phase2(store, timeline, {
      run: async () => JSON.stringify({
        changes: [
          { nodeId: MEMORY_NODE_ID, action: 'delete' },
          { nodeId: EPISODE_NODE_ID, action: 'delete' },
          { nodeId: BELIEF_NODE_ID, action: 'delete' },
        ],
      }),
    }, () => rootThread([]));
    await expect(deleteAll.run(new AbortController().signal)).resolves.toBe('published');
    expect(timeline.graph().nodes).toEqual([]);
    expect(store.generatedNodes()).toEqual([]);

    const protectedStore = memoryStore();
    const protectedProjection = memoryProjection();
    protectedProjection.nodes.push(node('ordinary:child', EPISODE_NODE_ID, [], [], 'User note'));
    protectedProjection.nodes.find((entry) => entry.id === EPISODE_NODE_ID)!.children.push('ordinary:child');
    const protectedTimeline = new TimelineMemoryStore(mutableTimelineHost(protectedProjection).host);
    seedGeneratedGraph(protectedStore, protectedTimeline);
    const unsafeDelete = new Phase2(protectedStore, protectedTimeline, {
      run: async () => JSON.stringify({
        changes: [
          { nodeId: MEMORY_NODE_ID, action: 'delete' },
          { nodeId: EPISODE_NODE_ID, action: 'delete' },
          { nodeId: BELIEF_NODE_ID, action: 'delete' },
        ],
      }),
    }, () => rootThread([]));
    await expect(unsafeDelete.run(new AbortController().signal)).rejects.toThrow('retained descendants');
  });

  test('reconciles rollback cleanup in bounded batches without exposing unsupported Nodes early', async () => {
    const store = memoryStore();
    const projection = memoryProjection();
    const episode = projection.nodes.find((entry) => entry.id === EPISODE_NODE_ID)!;
    for (let index = 0; index < 241; index += 1) {
      const nodeId = `belief:batch:${String(index).padStart(3, '0')}`;
      projection.nodes.push(node(nodeId, EPISODE_NODE_ID, [], ['tag:d-belief'], `Belief ${index}`));
      episode.children.push(nodeId);
    }
    const timelineState = mutableTimelineHost(projection);
    const timeline = new TimelineMemoryStore(timelineState.host);
    seedGeneratedGraph(store, timeline);
    store.prepareRollback({
      rollbackId: 'rollback:batched',
      threadId: THREAD_ID,
      omittedTurnIds: [TURN_ID],
      beforeVersion: 1,
      afterVersion: 2,
      suppressedNodeIds: store.generatedNodes().map((entry) => entry.nodeId),
      suppressAllGenerated: false,
    });
    store.commitRollback('rollback:batched');
    const phase = new Phase2(store, timeline, {
      run: async () => JSON.stringify({ changes: [] }),
    }, () => rootThread([]));

    await expect(phase.run(new AbortController().signal)).resolves.toBe('published');
    expect(store.rollback('rollback:batched')?.status).toBe('committed');
    expect(store.generatedNodeIdsWithoutCurrentSupport().length).toBeGreaterThan(0);
    expect(timeline.graph().nodes.length).toBeLessThanOrEqual(4);

    await expect(phase.run(new AbortController().signal)).resolves.toBe('published');
    expect(store.rollback('rollback:batched')?.status).toBe('reconciled');
    expect(store.generatedNodeIdsWithoutCurrentSupport()).toEqual([]);
    expect(timeline.graph().nodes).toEqual([]);
  });

  test('releases generated ancestors that must retain ordinary descendants during rollback cleanup', async () => {
    const store = memoryStore();
    const projection = memoryProjection();
    projection.nodes.push(node('ordinary:retained', EPISODE_NODE_ID, [], [], 'Retained user note'));
    projection.nodes.find((entry) => entry.id === EPISODE_NODE_ID)!.children.push('ordinary:retained');
    const timeline = new TimelineMemoryStore(mutableTimelineHost(projection).host);
    seedGeneratedGraph(store, timeline);
    store.prepareRollback({
      rollbackId: 'rollback:retained-descendant',
      threadId: THREAD_ID,
      omittedTurnIds: [TURN_ID],
      beforeVersion: 1,
      afterVersion: 2,
      suppressedNodeIds: store.generatedNodes().map((entry) => entry.nodeId),
      suppressAllGenerated: false,
    });
    store.commitRollback('rollback:retained-descendant');
    const phase = new Phase2(store, timeline, {
      run: async () => JSON.stringify({ changes: [] }),
    }, () => rootThread([]));

    await expect(phase.run(new AbortController().signal)).resolves.toBe('published');
    expect(store.rollback('rollback:retained-descendant')?.status).toBe('reconciled');
    expect(store.generatedNodes().map((entry) => ({ nodeId: entry.nodeId, userAuthoritative: entry.userAuthoritative })))
      .toEqual([
        { nodeId: MEMORY_NODE_ID, userAuthoritative: true },
        { nodeId: EPISODE_NODE_ID, userAuthoritative: true },
      ]);
    expect(store.lineageForNode(MEMORY_NODE_ID)).toEqual([]);
    expect(store.lineageForNode(EPISODE_NODE_ID)).toEqual([]);
    expect(timeline.projection().nodes.some((entry) => entry.id === 'ordinary:retained')).toBe(true);
  });

  test('keeps Reset preparation durable and clears obsolete rollback state on finalization', () => {
    const store = memoryStore();
    store.prepareRollback({
      rollbackId: 'rollback:before-reset',
      threadId: THREAD_ID,
      omittedTurnIds: [TURN_ID],
      beforeVersion: 1,
      afterVersion: 2,
      suppressedNodeIds: [],
      suppressAllGenerated: true,
    });
    const resetPublication = publication('reset', {
      epoch: 1,
      excludedTurnIds: [TURN_ID],
      containerIds: [MEMORY_NODE_ID],
    });
    store.prepareReset(resetPublication, 20);
    expect(store.isTurnExcluded(TURN_ID)).toBe(true);
    expect(store.nextJob(20)?.kind).toBe('reset');

    store.finalizeReset(resetPublication.id, 1, [TURN_ID]);
    expect(store.status().resetEpoch).toBe(1);
    expect(store.activeRollbacks()).toEqual([]);
    expect(store.nextJob(20)).toBeNull();
  });

  test('rejects a Phase 1 result when Thread Memory is disabled during model work', async () => {
    const store = memoryStore();
    const thread = rootThread([userTurn(
      'remember the selected architecture',
      undefined,
      { kind: 'user' },
      'turn:phase1-user-edit',
      'item:phase1-user-edit',
    )]);
    const extension = new MemoryExtension(store, new TimelineMemoryStore(readOnlyTimelineHost(memoryProjection())));
    extension.bindHost(memoryThreadHost(thread));
    extension.contributeTurnAdmission(admissionContext(thread, thread.turns![0]!));
    let resolveModel!: (value: string) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const modelOutput = new Promise<string>((resolve) => { resolveModel = resolve; });
    const phase = new Phase1(
      store,
      new TimelineMemoryStore(readOnlyTimelineHost(memoryProjection())),
      {
        run: async () => {
          markStarted();
          return modelOutput;
        },
      },
      () => true,
    );
    const run = phase.run({ thread, turns: thread.turns ?? [] }, new AbortController().signal);
    await started;
    store.setThreadMode(THREAD_ID, 'disabled', 20);
    resolveModel(JSON.stringify({
      dates: [{
        sourceDate: '2026-07-24',
        headline: statement('Architecture decision', ['item:phase1-user-edit']),
        episode: statement('The user selected the clean architecture.', ['item:phase1-user-edit']),
        beliefs: [statement('The project uses the clean architecture.', ['item:phase1-user-edit'])],
        questions: [],
        guidance: [statement('Preserve the selected architecture.', ['item:phase1-user-edit'])],
      }],
    }));
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
    expect(store.preparedPublications()).toEqual([]);
  });

  test('preserves a user edit made while Phase 1 model work is running', async () => {
    const store = memoryStore();
    const timelineState = mutableTimelineHost(memoryProjection());
    const timeline = new TimelineMemoryStore(timelineState.host);
    seedGeneratedGraph(store, timeline);
    const thread = rootThread([userTurn(
      'remember the selected architecture',
      undefined,
      { kind: 'user' },
      'turn:phase1-user-edit',
      'item:phase1-user-edit',
    )]);
    store.writeAdmission(admissionSnapshot(thread.turns![0]!));
    let resolveModel!: (value: string) => void;
    const modelOutput = new Promise<string>((resolve) => { resolveModel = resolve; });
    const phase = new Phase1(store, timeline, { run: () => modelOutput }, () => true);

    const run = phase.run({ thread, turns: thread.turns ?? [] }, new AbortController().signal);
    timelineState.projection().nodes.find((entry) => entry.id === BELIEF_NODE_ID)!.content = {
      text: 'User authoritative edit',
      spans: [],
    };
    resolveModel(JSON.stringify({
      dates: [{
        sourceDate: '2026-07-24',
        headline: statement('Architecture decision', ['item:phase1-user-edit']),
        episode: statement('The user selected the clean architecture.', ['item:phase1-user-edit']),
        beliefs: [statement('Generated replacement belief', ['item:phase1-user-edit'])],
        questions: [],
        guidance: [],
      }],
    }));

    await expect(run).resolves.toBe('published');
    expect(timelineState.projection().nodes.find((entry) => entry.id === BELIEF_NODE_ID)?.content.text)
      .toBe('User authoritative edit');
    expect(store.generatedNodes().find((entry) => entry.nodeId === BELIEF_NODE_ID)?.userAuthoritative).toBe(true);
    expect(timeline.graph().nodes.some((entry) => (
      entry.category === 'belief' && entry.node.content.text === 'Generated replacement belief'
    ))).toBe(true);
  });

  test('records exact per-statement evidence lineage instead of same-day Cartesian support', async () => {
    const store = memoryStore();
    const timeline = new TimelineMemoryStore(mutableTimelineHost(memoryProjection()).host);
    const first = userTurn('remember the architecture', undefined, { kind: 'user' }, 'turn:lineage:a', 'item:lineage:a');
    const second = userTurn('remember the review rule', undefined, { kind: 'user' }, 'turn:lineage:b', 'item:lineage:b');
    const thread = rootThread([first, second]);
    store.writeAdmission(admissionSnapshot(first));
    store.writeAdmission(admissionSnapshot(second));
    const phase = new Phase1(store, timeline, {
      run: async () => JSON.stringify({
        dates: [{
          sourceDate: '2026-07-24',
          headline: statement('Durable project choices', ['item:lineage:a', 'item:lineage:b']),
          episode: statement('The user established project constraints.', ['item:lineage:a', 'item:lineage:b']),
          beliefs: [statement('The project uses the selected architecture.', ['item:lineage:a'])],
          questions: [],
          guidance: [statement('Apply the review rule.', ['item:lineage:b'])],
        }],
      }),
    }, () => true);

    await expect(phase.run({ thread, turns: thread.turns ?? [] }, new AbortController().signal))
      .resolves.toBe('published');
    const belief = timeline.graph().nodes.find((entry) => entry.node.content.text === 'The project uses the selected architecture.');
    const guidance = timeline.graph().nodes.find((entry) => entry.node.content.text === 'Apply the review rule.');
    expect(store.lineageForNode(belief!.node.id).map((edge) => edge.originItemId)).toEqual(['item:lineage:a']);
    expect(store.lineageForNode(guidance!.node.id).map((edge) => edge.originItemId)).toEqual(['item:lineage:b']);
  });

  test('rebuilds Phase 1 targets after waiting for the write gate', async () => {
    const store = memoryStore();
    const timelineState = mutableTimelineHost(memoryProjection());
    const timeline = new TimelineMemoryStore(timelineState.host);
    seedGeneratedGraph(store, timeline);
    const thread = rootThread([userTurn(
      'remember the selected architecture',
      undefined,
      { kind: 'user' },
      'turn:phase1-gate-race',
      'item:phase1-gate-race',
    )]);
    store.writeAdmission(admissionSnapshot(thread.turns![0]!));
    let releaseGate!: () => void;
    let gateEntered!: () => void;
    const entered = new Promise<void>((resolve) => { gateEntered = resolve; });
    const gate = timeline.withWriteGate(async () => {
      gateEntered();
      await new Promise<void>((resolve) => { releaseGate = resolve; });
    });
    await entered;
    let modelStarted!: () => void;
    const started = new Promise<void>((resolve) => { modelStarted = resolve; });
    const phase = new Phase1(store, timeline, {
      run: async () => {
        modelStarted();
        return JSON.stringify({
          dates: [{
            sourceDate: '2026-07-24',
            headline: statement('Architecture decision', ['item:phase1-gate-race']),
            episode: statement('The user selected the clean architecture.', ['item:phase1-gate-race']),
            beliefs: [statement('Generated replacement belief', ['item:phase1-gate-race'])],
            questions: [],
            guidance: [],
          }],
        });
      },
    }, () => true);
    const run = phase.run({ thread, turns: thread.turns ?? [] }, new AbortController().signal);
    await started;
    timelineState.projection().nodes.find((entry) => entry.id === BELIEF_NODE_ID)!.content = {
      text: 'Concurrent edit before preparation',
      spans: [],
    };
    releaseGate();
    await gate;

    await expect(run).resolves.toBe('published');
    expect(timelineState.projection().nodes.find((entry) => entry.id === BELIEF_NODE_ID)?.content.text)
      .toBe('Concurrent edit before preparation');
    expect(store.generatedNodes().find((entry) => entry.nodeId === BELIEF_NODE_ID)?.userAuthoritative).toBe(true);
    expect(timeline.graph().nodes.some((entry) => (
      entry.category === 'belief' && entry.node.content.text === 'Generated replacement belief'
    ))).toBe(true);
  });

  test('rechecks a Phase 2 deletion subtree after waiting for the write gate', async () => {
    const store = memoryStore();
    const timelineState = mutableTimelineHost(memoryProjection());
    const timeline = new TimelineMemoryStore(timelineState.host);
    seedGeneratedGraph(store, timeline);
    let releaseGate!: () => void;
    let gateEntered!: () => void;
    const entered = new Promise<void>((resolve) => { gateEntered = resolve; });
    const gate = timeline.withWriteGate(async () => {
      gateEntered();
      await new Promise<void>((resolve) => { releaseGate = resolve; });
    });
    await entered;
    let modelStarted!: () => void;
    const started = new Promise<void>((resolve) => { modelStarted = resolve; });
    const phase = new Phase2(store, timeline, {
      run: async () => {
        modelStarted();
        return JSON.stringify({
          changes: [
            { nodeId: MEMORY_NODE_ID, action: 'delete' },
            { nodeId: EPISODE_NODE_ID, action: 'delete' },
            { nodeId: BELIEF_NODE_ID, action: 'delete' },
          ],
        });
      },
    }, () => rootThread([]));
    const run = phase.run(new AbortController().signal);
    await started;
    const projection = timelineState.projection();
    projection.nodes.push(node('ordinary:late-child', BELIEF_NODE_ID, [], [], 'Late user note'));
    projection.nodes.find((entry) => entry.id === BELIEF_NODE_ID)!.children.push('ordinary:late-child');
    releaseGate();
    await gate;

    await expect(run).rejects.toThrow('retained descendants');
    expect(store.preparedPublications()).toEqual([]);
    expect(timelineState.deletedNodeIds).toEqual([]);
    expect(timelineState.projection().nodes.some((entry) => entry.id === 'ordinary:late-child')).toBe(true);
  });

  test('linearizes Thread Memory disable with the publication write gate', async () => {
    const store = memoryStore();
    const timeline = new TimelineMemoryStore(readOnlyTimelineHost(memoryProjection()));
    const thread = rootThread([]);
    const extension = new MemoryExtension(store, timeline);
    extension.bindHost(memoryThreadHost(thread));
    let releaseGate!: () => void;
    let gateEntered!: () => void;
    const entered = new Promise<void>((resolve) => { gateEntered = resolve; });
    const gate = timeline.withWriteGate(async () => {
      gateEntered();
      await new Promise<void>((resolve) => { releaseGate = resolve; });
    });
    await entered;
    let completed = false;
    const disabling = extension.setThreadMode(thread.id, 'disabled').then(() => { completed = true; });
    await Promise.resolve();
    expect(completed).toBe(false);
    expect(store.threadMode(thread.id)).toBe('enabled');
    releaseGate();
    await gate;
    await disabling;
    expect(store.threadMode(thread.id)).toBe('disabled');
  });

  test('suspends an in-flight Memory worker when the global feature is disabled', async () => {
    const store = memoryStore();
    const thread = { ...rootThread([]), updatedAt: 10 };
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => { started = resolve; });
    let interrupted = false;
    const phase1 = {
      run: async (_source: unknown, signal: AbortSignal) => {
        started();
        await new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            interrupted = true;
            const error = new Error('interrupted');
            error.name = 'AbortError';
            reject(error);
          }, { once: true });
        });
        return 'unchanged' as const;
      },
    };
    const pipeline = new MemoryPipeline(
      store,
      new TimelineMemoryStore(readOnlyTimelineHost(memoryProjection())),
      phase1 as unknown as Phase1,
      {} as Phase2,
      { persistentRootThreads: () => [thread], readSource: () => ({ thread, turns: [] }) },
      { now: () => 10, minThreadIdleMs: 0, maxThreadAgeMs: 100 },
    );
    await pipeline.start();
    await didStart;
    pipeline.suspend();
    await Promise.resolve();
    expect(interrupted).toBe(true);
    expect(store.nextJob(10)?.kind).toBe('phase1');
    await pipeline.close();
  });

  test('keeps the Memory control store open until Thread shutdown completes', async () => {
    const store = new MemoryControlStore(
      ':memory:',
      new Database(':memory:') as unknown as SqliteDatabase,
    );
    const extension = new MemoryExtension(
      store,
      new TimelineMemoryStore(readOnlyTimelineHost(memoryProjection())),
    );
    const events: string[] = [];

    await closeAgentServices(extension, {
      close: async () => {
        events.push('threads:closing');
        expect(store.status().featureMode).toBe('enabled');
        events.push('rollback-hooks:closed');
      },
    });

    expect(events).toEqual(['threads:closing', 'rollback-hooks:closed']);
    expect(() => store.status()).toThrow();
  });

  test('replays a prepared Reset without a receipt before starting workers', async () => {
    const store = memoryStore();
    const timelineState = mutableTimelineHost(memoryProjection());
    const timeline = new TimelineMemoryStore(timelineState.host);
    const resetPublication = publication('reset', {
      epoch: 1,
      excludedTurnIds: [TURN_ID],
      containerIds: [MEMORY_NODE_ID],
    });
    store.prepareReset(resetPublication, 20);
    const pipeline = new MemoryPipeline(
      store,
      timeline,
      {} as Phase1,
      {} as Phase2,
      { persistentRootThreads: () => [], readSource: () => null },
      {
        minThreadIdleMs: 0,
        recoverResetPublication: async (record, receiptMatches) => {
          expect(receiptMatches).toBe(false);
          const payload = record.payload as typeof resetPublication.payload;
          await timeline.reset(record.id, record.generation, record.digest, payload.containerIds);
          store.finalizeReset(record.id, payload.epoch, payload.excludedTurnIds);
        },
      },
    );

    await pipeline.start();
    await pipeline.close();
    expect(timelineState.deletedNodeIds).toEqual([MEMORY_NODE_ID]);
    expect(timelineState.projection().nodes.some((entry) => entry.id === 'stray:1')).toBe(true);
    expect(store.status().resetEpoch).toBe(1);
    expect(store.publication(resetPublication.id)?.status).toBe('finalized');
  });

  test('finalizes a prepared Reset with a matching receipt without deleting twice', async () => {
    const store = memoryStore();
    const timelineState = mutableTimelineHost(memoryProjection());
    const timeline = new TimelineMemoryStore(timelineState.host);
    const resetPublication = publication('reset', {
      epoch: 1,
      excludedTurnIds: [TURN_ID],
      containerIds: [MEMORY_NODE_ID],
    });
    store.prepareReset(resetPublication, 20);
    await timeline.reset(
      resetPublication.id,
      resetPublication.generation,
      resetPublication.digest,
      [MEMORY_NODE_ID],
    );
    expect(timelineState.deletedNodeIds).toEqual([MEMORY_NODE_ID]);
    const pipeline = new MemoryPipeline(
      store,
      timeline,
      {} as Phase1,
      {} as Phase2,
      { persistentRootThreads: () => [], readSource: () => null },
      {
        minThreadIdleMs: 0,
        recoverResetPublication: async (record, receiptMatches) => {
          expect(receiptMatches).toBe(true);
          const payload = record.payload as typeof resetPublication.payload;
          store.finalizeReset(record.id, payload.epoch, payload.excludedTurnIds);
        },
      },
    );
    await pipeline.start();
    await pipeline.close();
    expect(timelineState.deletedNodeIds).toEqual([MEMORY_NODE_ID]);
    expect(store.publication(resetPublication.id)?.status).toBe('finalized');
  });

  test('finalizes an unknown-settlement publication from its idempotency receipt without writing twice', async () => {
    const store = memoryStore();
    const timelineState = mutableTimelineHost(memoryProjection(), { failAfterCommitOnce: true });
    const timeline = new TimelineMemoryStore(timelineState.host);
    const turn = userTurn('Remember the recovery contract.');
    const thread = rootThread([turn]);
    store.writeAdmission(admissionSnapshot(turn));
    const phase1 = new Phase1(store, timeline, {
      run: async () => JSON.stringify({
        dates: [{
          sourceDate: '2026-07-24',
          headline: statement('Recovery contract'),
          episode: statement('The Runtime receipt resolves unknown settlement.'),
          beliefs: [statement('Memory publication is idempotent.')],
          questions: [],
          guidance: [],
        }],
      }),
    }, () => true);

    await expect(phase1.run({ thread, turns: [turn] }, new AbortController().signal)).rejects.toMatchObject({
      outlineError: { code: 'operation_settlement_unknown' },
    });
    expect(store.preparedPublications()).toHaveLength(1);
    expect(timelineState.calls).toHaveLength(1);
    expect(timelineState.calls[0]?.options?.settlement).toBe('durable');

    const pipeline = new MemoryPipeline(
      store,
      timeline,
      phase1,
      {} as Phase2,
      { persistentRootThreads: () => [], readSource: () => null },
    );
    await pipeline.recover();
    await pipeline.close();

    expect(store.preparedPublications()).toEqual([]);
    expect(store.source(THREAD_ID)?.sourceVersion).toBeDefined();
    expect(timelineState.calls).toHaveLength(1);
  });
});

function memoryStore(): MemoryControlStore {
  const store = new MemoryControlStore(
    ':memory:',
    new Database(':memory:') as unknown as SqliteDatabase,
  );
  stores.push(store);
  return store;
}

function publication(kind: 'reset', payload: unknown) {
  return {
    id: 'memory:reset:test',
    kind,
    status: 'prepared' as const,
    generation: 1,
    featureGeneration: 0,
    resetEpoch: 0,
    digest: 'digest',
    payload,
    createdAt: 1,
  };
}

function statement(text: string, originItemIds: readonly string[] = [ITEM_ID]) {
  return { text, originItemIds };
}

function admissionSnapshot(turn: Turn) {
  return {
    threadId: THREAD_ID,
    turnId: turn.id,
    featureModeAtAdmission: 'enabled' as const,
    threadModeAtAdmission: 'enabled' as const,
    eligibleAtAdmission: true,
    featureModeGeneration: 0,
    resetEpoch: 0,
    memoryVisibilityGeneration: 0,
    admittedAt: turn.startedAt,
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('Timed out waiting for test condition');
}

function generatedNode(): MemoryGeneratedNodeRecord {
  return {
    nodeId: MEMORY_NODE_ID,
    category: 'memory',
    sourceDate: '2026-07-24',
    fingerprint: 'fingerprint',
    userAuthoritative: false,
    generatedAt: 1,
  };
}

function seedGeneratedGraph(store: MemoryControlStore, timeline: TimelineMemoryStore): void {
  expect(store.claimOrigin(ITEM_ID, THREAD_ID, TURN_ID, '2026-07-24', 'hash')).toBe(true);
  const entries = timeline.graph().nodes;
  store.replaceGeneratedNodes(
    THREAD_ID,
    entries.map((entry) => ({
      nodeId: entry.node.id,
      category: entry.category,
      sourceDate: entry.sourceDate,
      fingerprint: timelineNodeFingerprint(entry),
      userAuthoritative: false,
      generatedAt: Date.now(),
    })),
    entries.map((entry) => ({
      nodeId: entry.node.id,
      threadId: THREAD_ID,
      turnId: TURN_ID,
      originItemId: ITEM_ID,
    })),
  );
}

function rootThread(turns: readonly Turn[]): Thread {
  return {
    id: THREAD_ID,
    sessionId: THREAD_ID,
    parentThreadId: null,
    forkedFromId: null,
    name: null,
    preview: '',
    ephemeral: false,
    source: 'app',
    threadSource: 'user',
    modelProvider: 'test',
    cwd: '/tmp',
    createdAt: 1,
    updatedAt: 1,
    status: { type: 'idle' },
    historyMode: 'full',
    turns,
  };
}

function userTurn(
  text: string,
  nodeReference?: string,
  trigger: Turn['provenance']['trigger'] = { kind: 'user' },
  turnId = TURN_ID,
  itemId = ITEM_ID,
  originThreadId = THREAD_ID,
): Turn {
  const startedAt = new Date(2026, 6, 24).getTime();
  const author = trigger.kind === 'feature'
    ? { kind: 'feature' as const, feature: trigger.feature, ...(trigger.ref ? { ref: trigger.ref } : {}) }
    : { kind: 'reader' as const };
  const item: ThreadItem = {
    type: 'userMessage',
    author,
    id: itemId,
    clientId: null,
    acceptedAt: startedAt,
    provenance: { originThreadId, originTurnId: turnId, originItemId: itemId },
    content: [
      { type: 'text', text },
      ...(nodeReference ? [{ type: 'nodeReference' as const, nodeId: nodeReference }] : []),
    ],
  };
  return {
    id: turnId,
    items: [item],
    itemsView: 'full',
    provenance: { originThreadId: THREAD_ID, originTurnId: turnId, trigger },
    status: 'completed',
    error: null,
    execution: {
      modelProvider: 'test',
      model: 'test',
      reasoningEffort: 'medium',
      diagnosticsRef: null,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: null },
    },
    startedAt,
    completedAt: new Date(2026, 6, 24).getTime(),
    durationMs: 0,
  };
}

function admissionContext(thread: Thread, turn: Turn) {
  return {
    thread,
    turnId: turn.id,
    provenance: turn.provenance,
    configuration: {
      profileId: 'default',
      model: 'test',
      reasoningEffort: 'medium' as const,
      tools: [],
      skills: [],
      plugins: [],
      mcpServers: [],
      developerInstructions: [],
    },
    threadBarrier: { kind: 'thread' as const, threadId: thread.id, generation: 0 },
    hostBarrier: { kind: 'hostRootTurns' as const, generation: 0 },
  };
}

function memoryProjectionDelivery(
  update: ProjectionUpdate,
  _affectsMemory: boolean,
): { readonly update: ProjectionUpdate } {
  return { update };
}

function memoryPublicationOperation(): Operation {
  return {
    source: {
      kind: 'automation',
      label: 'Memory publication generation 1',
      fingerprint: 'digest',
    },
  } as unknown as Operation;
}

function patchProjectionNode(
  projection: DocumentProjection,
  nodeId: string,
  patch: Partial<NodeProjection>,
): NodeProjection {
  const current = projection.nodes.find((entry) => entry.id === nodeId);
  if (!current) throw new Error(`Missing test projection Node: ${nodeId}`);
  return { ...current, ...patch } as NodeProjection;
}

function replaceProjectionNodes(
  projection: DocumentProjection,
  changedNodes: readonly NodeProjection[],
  removedIds: readonly string[] = [],
): void {
  const changedById = new Map(changedNodes.map((entry) => [entry.id, entry]));
  const removed = new Set(removedIds);
  projection.nodes = projection.nodes
    .filter((entry) => !removed.has(entry.id))
    .map((entry) => changedById.get(entry.id) ?? entry);
  for (const entry of changedNodes) {
    if (!projection.nodes.some((candidate) => candidate.id === entry.id)) projection.nodes.push(entry);
  }
}

function applyMemoryIndexDelta(
  projection: DocumentProjection,
  index: MemoryMutationIndex,
  changedNodes: readonly NodeProjection[],
  removedIds: readonly string[] = [],
): void {
  index.applyProjectionUpdate({
    kind: 'delta',
    revision: index.revision() + 1,
    todayId: projection.todayId,
    changedNodes,
    removedIds,
  });
  replaceProjectionNodes(projection, changedNodes, removedIds);
}

function fullScanMemoryMutationSnapshot(projection: DocumentProjection) {
  const nodes = new Map(projection.nodes.map((entry) => [entry.id, entry]));
  const graph = canonicalMemoryGraph(projection);
  const owned = new Set<string>();
  for (const container of graph.containers) {
    const pending = [container.node.id];
    while (pending.length > 0) {
      const nodeId = pending.pop()!;
      if (owned.has(nodeId)) continue;
      owned.add(nodeId);
      pending.push(...(nodes.get(nodeId)?.children ?? []));
    }
  }
  return {
    owned: [...owned].sort(),
    canonical: graph.nodes.map((entry) => entry.node.id).sort(),
    canonicalFingerprints: graph.nodes
      .map((entry) => [entry.node.id, timelineNodeFingerprint(entry)] as const)
      .sort(([left], [right]) => left.localeCompare(right)),
  };
}

function memoryProjection(extraBeliefs = 0): DocumentProjection {
  const beliefIds = [
    BELIEF_NODE_ID,
    ...Array.from({ length: extraBeliefs }, (_, index) => (
      `node:10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`
    )),
  ];
  const nodes = [
    node(WORKSPACE_ID, undefined, [DAILY_NOTES_ID, 'ordinary:1']),
    node(DAILY_NOTES_ID, WORKSPACE_ID, ['year']),
    node('year', DAILY_NOTES_ID, ['week']),
    node('week', 'year', ['day']),
    node('day', 'week', [MEMORY_NODE_ID], [TAG_DAY_ID], '2026-07-24'),
    node(MEMORY_NODE_ID, 'day', [EPISODE_NODE_ID], ['tag:d-memory'], 'Daily memory'),
    node(EPISODE_NODE_ID, MEMORY_NODE_ID, beliefIds, ['tag:d-episode'], 'Episode'),
    node(BELIEF_NODE_ID, EPISODE_NODE_ID, [], ['tag:d-belief'], 'Belief'),
    ...beliefIds.slice(1).map((nodeId, index) => (
      node(nodeId, EPISODE_NODE_ID, [], ['tag:d-belief'], `Belief ${index + 2}`)
    )),
    node('ordinary:1', WORKSPACE_ID, ['stray:1']),
    node('stray:1', 'ordinary:1', [], ['tag:d-guidance'], 'Stray'),
    ...MEMORY_TAG_DEFINITIONS.map((definition) => node(definition.tagId, SCHEMA_ID, [], [], definition.name, 'tagDef')),
  ];
  return {
    workspaceId: 'workspace',
    rootId: WORKSPACE_ID,
    libraryId: LIBRARY_ID,
    dailyNotesId: DAILY_NOTES_ID,
    schemaId: SCHEMA_ID,
    searchesId: SEARCHES_ID,
    recentsId: RECENTS_ID,
    trashId: TRASH_ID,
    todayId: 'day',
    nodes,
  };
}

function node(
  id: string,
  parentId: string | undefined,
  children: string[],
  tags: string[] = [],
  text = id,
  type = 'text',
): NodeProjection {
  return {
    id,
    ...(parentId ? { parentId } : {}),
    children,
    content: { text, spans: [] },
    tags,
    createdAt: 1,
    updatedAt: 1,
    locked: false,
    type,
    fieldEntries: [],
    references: [],
  } as NodeProjection;
}

function readOnlyTimelineHost(projection: DocumentProjection): TimelineMemoryHost {
  return {
    getProjection: () => projection,
    runChanges: async () => undefined,
    runPlannedChanges: async (build) => {
      await build(projection);
      return undefined;
    },
    log: async () => [],
  };
}

function mutableTimelineHost(
  initial: DocumentProjection,
  behavior: { failAfterCommitOnce?: boolean } = {},
) {
  let projection = initial;
  let failAfterCommit = behavior.failAfterCommitOnce === true;
  const deletedNodeIds: string[] = [];
  const calls: Array<{
    readonly changes: readonly Change[];
    readonly options: Parameters<TimelineMemoryHost['runChanges']>[1];
  }> = [];
  const operationByIdempotencyKey = new Map<string, Operation>();
  const runChanges: TimelineMemoryHost['runChanges'] = async (changes, options) => {
    calls.push({ changes, options });
    const idempotencyKey = options?.idempotencyKey;
    if (idempotencyKey && operationByIdempotencyKey.has(idempotencyKey)) return undefined;
    const bindings = new Map<string, string>();
    for (const change of changes) {
      applyMemoryTestChange(change, bindings);
    }
    if (idempotencyKey) {
      operationByIdempotencyKey.set(idempotencyKey, {
        source: options?.source,
      } as unknown as Operation);
    }
    if (failAfterCommit) {
      failAfterCommit = false;
      throw new OutlineContractError(outlineError(
        'operation_settlement_unknown',
        'durability',
        'The Memory publication committed but acknowledgement was lost.',
        { retryable: true },
      ));
    }
    return undefined;
  };
  const host: TimelineMemoryHost = {
    getProjection: () => projection,
    runChanges,
    runPlannedChanges: async (build, options) => {
      const changes = await build(projection);
      return changes && changes.length > 0 ? runChanges(changes, options) : undefined;
    },
    log: async ({ idempotencyKey }) => {
      const operation = idempotencyKey ? operationByIdempotencyKey.get(idempotencyKey) : undefined;
      return operation ? [operation] : [];
    },
  };

  function applyMemoryTestChange(change: Change, bindings: Map<string, string>): void {
    if (change.op === 'ensure') {
      if (change.resource === 'definition') {
        const definitionId = change.id;
        const existing = projection.nodes.find((entry) => entry.id === definitionId);
        if (!existing) {
          const created = node(definitionId, SCHEMA_ID, [], [], change.name, 'tagDef');
          created.locked = true;
          projection.nodes.push(created);
        } else {
          existing.type = 'tagDef';
          existing.content = { text: change.name, spans: [] };
          existing.parentId = SCHEMA_ID;
          existing.locked = true;
        }
        bindings.set(change.bind, definitionId);
        return;
      }
      const existing = projection.nodes.find((entry) => (
        entry.tags.includes(TAG_DAY_ID) && entry.content.text === change.date
      ));
      if (!existing) throw new Error(`Missing test Daily Note: ${change.date}`);
      bindings.set(change.bind, existing.id);
      return;
    }
    if (change.op === 'create' && 'placement' in change) {
      if (!('parent' in change.placement)) {
        throw new Error('Memory test create requires a parent placement');
      }
      const parentId = resolveMemoryTestTarget(change.placement.parent, bindings);
      for (const input of change.nodes) {
        if (!input.id) throw new Error('Memory test create requires a stable Node ID');
        const created = node(
          input.id,
          parentId,
          input.children.map((child) => child.id).filter((id): id is string => Boolean(id)),
          [...(input.tags ?? [])],
          input.content?.text ?? '',
        );
        projection.nodes = [
          ...projection.nodes.map((entry) => entry.id === parentId
            ? { ...entry, children: [...entry.children, created.id] }
            : entry),
          created,
        ];
        if (change.bind) bindings.set(change.bind, created.id);
      }
      return;
    }
    if (change.op === 'update') {
      const nodeId = resolveMemoryTestTarget(change.targets, bindings);
      projection.nodes = projection.nodes.map((entry) => {
        if (entry.id !== nodeId) return entry;
        let updated = entry;
        for (const instruction of change.changes) {
          if (instruction.kind === 'content') updated = { ...updated, content: instruction.value };
          if (instruction.kind === 'tag') {
            const tagId = resolveMemoryTestTarget(instruction.tag, bindings);
            updated = {
              ...updated,
              tags: instruction.action === 'add'
                ? [...new Set([...updated.tags, tagId])]
                : updated.tags.filter((candidate) => candidate !== tagId),
            };
          }
        }
        return updated;
      });
      return;
    }
    if (change.op !== 'lifecycle' || change.action !== 'purge') {
      throw new Error(`Unsupported Memory test Change: ${change.op}`);
    }
    const nodeId = resolveMemoryTestTarget(change.targets, bindings);
    deletedNodeIds.push(nodeId);
    const index = new Map(projection.nodes.map((entry) => [entry.id, entry]));
    const removed = new Set<string>();
    const stack = [nodeId];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (removed.has(current)) continue;
      removed.add(current);
      stack.push(...(index.get(current)?.children ?? []));
    }
    projection = {
      ...projection,
      nodes: projection.nodes
        .filter((entry) => !removed.has(entry.id))
        .map((entry) => ({ ...entry, children: entry.children.filter((childId) => !removed.has(childId)) })),
    };
  }

  return { host, calls, deletedNodeIds, projection: () => projection };
}

function resolveMemoryTestTarget(target: TargetRef, bindings: ReadonlyMap<string, string>): string {
  if ('binding' in target) {
    const nodeId = bindings.get(target.binding);
    if (!nodeId) throw new Error(`Missing Memory test binding: ${target.binding}`);
    return nodeId;
  }
  if (target.target.selector.by !== 'id') throw new Error('Memory test host supports only ID selectors');
  return target.target.selector.id;
}

function memoryThreadHost(thread: Thread): MemoryThreadHost {
  return {
    persistentRootThreads: () => [thread],
    hasHiddenRootThreads: () => false,
    activeRootUserTurns: () => [],
    interruptRootTurns: async () => undefined,
    readThread: () => ({ thread }),
    readTurnForHost: (_threadId, turnId) => thread.turns?.find((turn) => turn.id === turnId) ?? null,
    isThreadNavigable: (threadId) => threadId === thread.id,
    historyRollbackMarker: () => null,
    runInternalMemoryTurn: async () => '',
    tryStartTurnIfIdle: async () => null,
    withThreadAdmissionBarrier: async (_threadId, operation) => operation({ kind: 'thread', threadId: THREAD_ID, generation: 0 }),
    withHostRootTurnAdmissionBarrier: async (operation) => operation({ kind: 'hostRootTurns', generation: 0 }),
  };
}

function memoryUsageHarness(projection = memoryProjection()) {
  const store = memoryStore();
  const timeline = new TimelineMemoryStore(readOnlyTimelineHost(projection));
  seedGeneratedGraph(store, timeline);
  const targetThreadId = 'thread:target';
  const targetTurnId = 'turn:target';
  const activeTurn: Turn = {
    ...userTurn('Use relevant Memory', undefined, { kind: 'user' }, targetTurnId, 'item:target', targetThreadId),
    status: 'inProgress',
    completedAt: null,
    durationMs: null,
  };
  const targetThread: Thread = {
    ...rootThread([activeTurn]),
    id: targetThreadId,
    sessionId: targetThreadId,
    status: { type: 'active', activeFlags: [] },
  };
  const extension = new MemoryExtension(store, timeline);
  extension.bindHost({
    ...memoryThreadHost(targetThread),
    persistentRootThreads: () => [targetThread],
  });
  extension.contributeTurnAdmission(admissionContext(targetThread, activeTurn));
  return { activeTurn, extension, projection, store, targetThread };
}

function completeOutlineGet(
  extension: MemoryExtension,
  thread: Thread,
  turn: Turn,
  projection: DocumentProjection,
  nodeIds: readonly string[],
  options: { readonly command?: string; readonly ok?: boolean } = {},
): void {
  const target = nodeIds.length === 1
    ? { selector: { by: 'id' as const, id: nodeIds[0]! }, cardinality: 'one' as const }
    : {
        selector: { by: 'ids' as const, ids: [...nodeIds] },
        cardinality: 'many' as const,
        max: nodeIds.length,
      };
  const data = {
    projection: {
      kind: 'node' as const,
      targets: { target },
      page: { limit: Math.max(1, nodeIds.length) },
    },
    revision: 1,
    anchors: {
      workspaceId: projection.workspaceId,
      rootId: projection.rootId,
      libraryId: projection.libraryId,
      dailyNotesId: projection.dailyNotesId,
      schemaId: projection.schemaId,
      searchesId: projection.searchesId,
      recentsId: projection.recentsId,
      trashId: projection.trashId,
      todayId: projection.todayId,
    },
    nodes: nodeIds.map((nodeId) => projection.nodes.find((entry) => entry.id === nodeId))
      .filter((entry): entry is NodeProjection => entry !== undefined),
  };
  const command = options.command ?? `outline --json get ${nodeIds.join(' ')}`;
  const stdout = command.includes('--json')
    ? JSON.stringify({
        protocolVersion: OUTLINE_PROTOCOL_VERSION,
        requestId: 'cli:memory-citation-test',
        ok: true,
        command: 'get',
        data,
      })
    : JSON.stringify(data);
  extension.onToolCompleted({
    threadId: thread.id,
    turnId: turn.id,
    itemId: `item:get:${nodeIds.join(':')}`,
    identity: { namespace: null, name: 'bash' },
    arguments: { command },
    result: options.ok === false
      ? { ok: false, tool: 'bash', error: { code: 'command_failed', message: 'Failed' } }
      : { ok: true, tool: 'bash', data: { stdout, stderr: '', interrupted: false, exitCode: 0 } },
    error: null,
  });
}

function completeMemoryTurn(extension: MemoryExtension, thread: Thread, turn: Turn): void {
  extension.onNotification({
    type: 'turn/completed',
    threadId: thread.id,
    turnId: turn.id,
    turn,
  });
}

function completedResponseTurn(activeTurn: Turn, text = 'Completed response'): Turn {
  const answerId = `item:answer:${activeTurn.id}`;
  return {
    ...activeTurn,
    status: 'completed',
    items: [
      ...activeTurn.items,
      {
        type: 'agentMessage',
        id: answerId,
        provenance: {
          originThreadId: activeTurn.provenance.originThreadId,
          originTurnId: activeTurn.id,
          originItemId: answerId,
        },
        text,
        phase: 'final_answer',
        memoryCitation: null,
      },
    ],
    completedAt: 2,
    durationMs: 1,
  };
}
