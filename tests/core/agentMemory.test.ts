import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  decodeMemoryConsolidationOutput,
  decodeMemoryStage1Output,
  MEMORY_TAG_DEFINITIONS,
} from '../../src/core/agent/memory';
import type { Thread, ThreadItem, Turn } from '../../src/core/agent/protocol';
import type { DocumentSystemReceipt } from '../../src/core/documentSystem';
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
import type { ProjectionChangedDelivery } from '../../src/main/documentService';
import { closeAgentServices } from '../../src/main/agent/closeAgentServices';
import { replayableModelCall } from '../fixtures/agentToolCallHistory';

const THREAD_ID = '018f0f24-7b2e-7a3f-8a4b-123456789abc';
const TURN_ID = '018f0f24-7b2e-7a3f-8a4b-123456789abd';
const ITEM_ID = '018f0f24-7b2e-7a3f-8a4b-123456789abe';
const MEMORY_NODE_ID = '018f0f24-7b2e-7a3f-8a4b-123456789abf';
const EPISODE_NODE_ID = '018f0f24-7b2e-7a3f-8a4b-123456789ac0';

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
    expect(graph.nodes.map((entry) => entry.node.id)).toEqual([MEMORY_NODE_ID, EPISODE_NODE_ID, 'belief:1']);
    expect(graph.strayTaggedNodeIds).toEqual(['stray:1']);

    const store = memoryStore();
    const extension = new MemoryExtension(store, new TimelineMemoryStore(readOnlyTimelineHost(projection)));
    expect(extension.settings().status.strayTaggedNodeCount).toBe(1);
  });

  test('filters rollback-invalidated generated Memory but preserves explicit references', () => {
    const store = memoryStore();
    const projection = memoryProjection();
    const timeline = new TimelineMemoryStore(readOnlyTimelineHost(projection));
    const thread = rootThread([userTurn('remember this decision')]);
    const extension = new MemoryExtension(store, timeline);
    extension.bindHost(memoryThreadHost(thread));
    extension.contributeTurnAdmission(admissionContext(thread, thread.turns![0]!));
    expect(store.claimOrigin(ITEM_ID, THREAD_ID, TURN_ID, '2026-07-24', 'hash')).toBe(true);
    store.replaceGeneratedNodes(THREAD_ID, [generatedNode()], [{
      nodeId: MEMORY_NODE_ID,
      threadId: THREAD_ID,
      turnId: TURN_ID,
      originItemId: ITEM_ID,
    }]);
    store.prepareRollback({
      rollbackId: 'rollback:filter',
      threadId: THREAD_ID,
      omittedTurnIds: [TURN_ID],
      beforeVersion: 1,
      afterVersion: 2,
      suppressedNodeIds: [MEMORY_NODE_ID],
      suppressAllGenerated: false,
    });
    const filtered = extension.filterProjection(projection, {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      itemId: ITEM_ID,
    });
    expect(filtered.nodes.some((node) => node.id === MEMORY_NODE_ID)).toBe(false);

    const referenced = rootThread([userTurn('read this', MEMORY_NODE_ID)]);
    const referencedExtension = new MemoryExtension(store, timeline);
    referencedExtension.bindHost(memoryThreadHost(referenced));
    const explicit = referencedExtension.filterProjection(projection, {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      itemId: ITEM_ID,
    });
    expect(explicit.nodes.some((node) => node.id === MEMORY_NODE_ID)).toBe(true);

    store.markNodeUserAuthoritative(MEMORY_NODE_ID);
    const authoritative = extension.filterProjection(projection, {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      itemId: ITEM_ID,
    });
    expect(authoritative.nodes.some((node) => node.id === MEMORY_NODE_ID)).toBe(true);
  });

  test('caches projection filtering metadata and one targeted Turn read', () => {
    const store = memoryStore();
    const projection = memoryProjection();
    const timeline = new TimelineMemoryStore(readOnlyTimelineHost(projection));
    const originalGraph = timeline.graph.bind(timeline);
    let fullGraphReads = 0;
    Object.assign(timeline, {
      graph: (override?: DocumentProjection) => {
        fullGraphReads += 1;
        return originalGraph(override);
      },
    });
    const thread = rootThread([userTurn('read this', MEMORY_NODE_ID)]);
    const includeTurnsRequests: Array<boolean | undefined> = [];
    const turnReads: Array<{ threadId: ThreadId; turnId: TurnId }> = [];
    const extension = new MemoryExtension(store, timeline);
    extension.bindHost({
      ...memoryThreadHost(thread),
      readThread: (input) => {
        includeTurnsRequests.push(input.includeTurns);
        return { thread };
      },
      readTurnForHost: (threadId, turnId) => {
        turnReads.push({ threadId, turnId });
        return thread.turns?.find((turn) => turn.id === turnId) ?? null;
      },
    });

    const filtered = extension.filterProjection(projection, {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      itemId: ITEM_ID,
    });
    const filteredAgain = extension.filterProjection(projection, {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      itemId: 'item:second-tool',
    });

    expect(filtered.nodes.some((node) => node.id === MEMORY_NODE_ID)).toBe(true);
    expect(filteredAgain).toEqual(filtered);
    expect(includeTurnsRequests).toEqual([undefined]);
    expect(turnReads).toEqual([{ threadId: THREAD_ID, turnId: TURN_ID }]);
    expect(extension.mutationIndexFullRebuildCount()).toBe(1);
    expect(fullGraphReads).toBe(0);
  });

  test('retries a targeted Turn read after a transient miss', () => {
    const store = memoryStore();
    const projection = memoryProjection();
    const timeline = new TimelineMemoryStore(readOnlyTimelineHost(projection));
    const turn = userTurn('read this', MEMORY_NODE_ID);
    const thread = rootThread([turn]);
    let readableTurn: Turn | null = null;
    let turnReads = 0;
    const extension = new MemoryExtension(store, timeline);
    extension.bindHost({
      ...memoryThreadHost(thread),
      readTurnForHost: () => {
        turnReads += 1;
        return readableTurn;
      },
    });
    const causation = { threadId: THREAD_ID, turnId: TURN_ID, itemId: ITEM_ID };

    const before = extension.filterProjection(projection, causation);
    expect(before.nodes.some((entry) => entry.id === MEMORY_NODE_ID)).toBe(false);

    readableTurn = turn;
    const after = extension.filterProjection(projection, causation);
    const afterAgain = extension.filterProjection(projection, causation);
    expect(after.nodes.some((entry) => entry.id === MEMORY_NODE_ID)).toBe(true);
    expect(afterAgain).toBe(after);
    expect(turnReads).toBe(2);
  });

  test('updates cached explicit references when a user Item is appended', () => {
    const store = memoryStore();
    const projection = memoryProjection();
    const timeline = new TimelineMemoryStore(readOnlyTimelineHost(projection));
    const turn = {
      ...userTurn('Start without a reference'),
      status: 'inProgress' as const,
      completedAt: null,
      durationMs: null,
    };
    const thread = {
      ...rootThread([turn]),
      status: { type: 'active' as const, activeFlags: [] },
    };
    const extension = new MemoryExtension(store, timeline);
    extension.bindHost(memoryThreadHost(thread));
    extension.contributeTurnAdmission(admissionContext(thread, turn));
    seedGeneratedGraph(store, timeline);
    store.prepareRollback({
      rollbackId: 'rollback:item-cache',
      threadId: THREAD_ID,
      omittedTurnIds: ['turn:omitted'],
      beforeVersion: 1,
      afterVersion: 2,
      suppressedNodeIds: [MEMORY_NODE_ID, EPISODE_NODE_ID, 'belief:1'],
      suppressAllGenerated: false,
    });
    extension.onNotification({ type: 'turn/started', threadId: THREAD_ID, turnId: TURN_ID, turn });

    const before = extension.filterProjection(projection, {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      itemId: ITEM_ID,
    });
    expect(before.nodes.some((entry) => entry.id === MEMORY_NODE_ID)).toBe(false);

    const steered = userTurn(
      'Read this',
      MEMORY_NODE_ID,
      { kind: 'user' },
      TURN_ID,
      'item:steered',
    ).items[0]!;
    extension.onNotification({
      type: 'items/completed',
      threadId: THREAD_ID,
      turnId: TURN_ID,
      items: [steered],
      completedAt: Date.now(),
    });
    const after = extension.filterProjection(projection, {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      itemId: 'item:after-steer',
    });
    expect(after.nodes.some((entry) => entry.id === MEMORY_NODE_ID)).toBe(true);
  });

  test('ignores Item reference notifications without active Turn filter state', () => {
    const projection = memoryProjection();
    const extension = new MemoryExtension(
      memoryStore(),
      new TimelineMemoryStore(readOnlyTimelineHost(projection)),
    );
    const item = userTurn(
      'Read this',
      MEMORY_NODE_ID,
      { kind: 'user' },
      'turn:orphan',
      'item:orphan',
    ).items[0]!;

    extension.onNotification({
      type: 'items/completed',
      threadId: THREAD_ID,
      turnId: 'turn:orphan',
      items: [item],
      completedAt: Date.now(),
    });

    const states = (extension as unknown as {
      turnProjectionFilters: ReadonlyMap<string, unknown>;
    }).turnProjectionFilters;
    expect(states.size).toBe(0);
  });

  test('reuses filtered read views until a visibility write invalidates them', () => {
    const store = memoryStore();
    const projection = memoryProjection();
    const timeline = new TimelineMemoryStore(readOnlyTimelineHost(projection));
    const thread = rootThread([userTurn('Use relevant Memory')]);
    const extension = new MemoryExtension(store, timeline);
    extension.bindHost(memoryThreadHost(thread));
    extension.contributeTurnAdmission(admissionContext(thread, thread.turns![0]!));
    seedGeneratedGraph(store, timeline);
    store.prepareRollback({
      rollbackId: 'rollback:filtered-views',
      threadId: THREAD_ID,
      omittedTurnIds: ['turn:omitted'],
      beforeVersion: 1,
      afterVersion: 2,
      suppressedNodeIds: [MEMORY_NODE_ID, EPISODE_NODE_ID, 'belief:1'],
      suppressAllGenerated: false,
    });
    const causation = { threadId: THREAD_ID, turnId: TURN_ID, itemId: ITEM_ID };
    const nodes = new Map(projection.nodes.map((entry) => [entry.id, entry]));
    const sourceTextIndex = createTextSearchIndex([
      {
        id: 'belief:1',
        kind: 'text',
        fields: [{ key: 'title', text: 'Durable probe belief' }],
      },
      {
        id: 'ordinary:1',
        kind: 'text',
        fields: [{ key: 'title', text: 'Ordinary note' }],
      },
    ]);

    const firstProjection = extension.filterProjection(projection, causation);
    const secondProjection = extension.filterProjection(projection, causation);
    const firstReadModel = extension.filterProjectionIndex({ projection, nodes }, causation);
    const secondReadModel = extension.filterProjectionIndex({ projection, nodes }, causation);
    const firstTextIndex = extension.filterTextSearchIndex(sourceTextIndex, causation);
    const secondTextIndex = extension.filterTextSearchIndex(sourceTextIndex, causation);
    expect(secondProjection).toBe(firstProjection);
    expect(secondReadModel).toBe(firstReadModel);
    expect(secondTextIndex).toBe(firstTextIndex);
    expect(firstReadModel.nodes.has('belief:1')).toBe(false);
    expect(firstTextIndex.search('durable probe')).toEqual([]);

    const filterStates = (extension as unknown as {
      turnProjectionFilters: ReadonlyMap<string, {
        projectionCache?: { mutationRevision: number };
        projectionIndexCache?: { mutationRevision: number };
      }>;
    }).turnProjectionFilters;
    const firstMutationRevision = filterStates.get(TURN_ID)?.projectionIndexCache?.mutationRevision;
    if (firstMutationRevision === undefined) throw new Error('Expected a cached projection mutation revision');

    const ordinaryIndex = projection.nodes.findIndex((entry) => entry.id === 'ordinary:1');
    if (ordinaryIndex < 0) throw new Error('Expected ordinary fixture Node');
    const updatedOrdinary = patchProjectionNode(projection, 'ordinary:1', {
      content: { text: 'Updated ordinary note', spans: [] },
      updatedAt: 2,
    });
    projection.nodes.splice(ordinaryIndex, 1, updatedOrdinary);
    nodes.set(updatedOrdinary.id, updatedOrdinary);
    extension.projectionChanged(memoryProjectionDelivery({
      kind: 'delta',
      revision: 1,
      todayId: projection.todayId,
      changedNodes: [updatedOrdinary],
      removedIds: [],
    }, false));

    const updatedProjection = extension.filterProjection(projection, causation);
    const updatedReadModel = extension.filterProjectionIndex({ projection, nodes }, causation);
    const updatedTextIndex = extension.filterTextSearchIndex(sourceTextIndex, causation);
    expect(updatedProjection).not.toBe(firstProjection);
    expect(updatedReadModel).not.toBe(firstReadModel);
    expect(updatedTextIndex).not.toBe(firstTextIndex);
    expect(updatedReadModel.nodes.get('ordinary:1')?.content.text).toBe('Updated ordinary note');
    expect(filterStates.get(TURN_ID)?.projectionCache?.mutationRevision)
      .toBeGreaterThan(firstMutationRevision);
    expect(filterStates.get(TURN_ID)?.projectionIndexCache?.mutationRevision)
      .toBeGreaterThan(firstMutationRevision);

    store.markNodeUserAuthoritative('belief:1');
    const refreshedReadModel = extension.filterProjectionIndex({ projection, nodes }, causation);
    const refreshedTextIndex = extension.filterTextSearchIndex(sourceTextIndex, causation);
    expect(refreshedReadModel).not.toBe(updatedReadModel);
    expect(refreshedTextIndex).not.toBe(updatedTextIndex);
    expect(refreshedReadModel.nodes.get('belief:1')?.parentId).toBeUndefined();
    expect(refreshedTextIndex.search('durable probe').map((entry) => entry.id)).toEqual(['belief:1']);
  });

  test('keeps Memory projection root-only even when a child explicitly references a Memory Node', () => {
    const store = memoryStore();
    const projection = memoryProjection();
    const timeline = new TimelineMemoryStore(readOnlyTimelineHost(projection));
    const child = {
      ...rootThread([userTurn('read this', MEMORY_NODE_ID)]),
      parentThreadId: 'thread:parent',
      threadSource: 'subagent' as const,
    };
    const extension = new MemoryExtension(store, timeline);
    extension.bindHost(memoryThreadHost(child));

    const filtered = extension.filterProjection(projection, {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      itemId: ITEM_ID,
    });
    expect(filtered.nodes.some((node) => node.id === MEMORY_NODE_ID)).toBe(false);
    expect(filtered.nodes.some((node) => node.id === EPISODE_NODE_ID)).toBe(false);
  });

  test('routes Memory lookup without injecting prose and counts only an inline citation of an exact read', () => {
    const { extension, store, targetThread, activeTurn } = memoryUsageHarness();
    const context = extension.contributeThreadContext(targetThread);
    expect(context?.additionalContext?.memory?.value).toContain('use node_search');
    expect(context?.additionalContext?.memory?.value).toContain('[[node:^exact-id]]');
    expect(context?.additionalContext?.memory?.value).not.toContain('Daily memory');
    expect(context?.additionalContext?.memory?.value).not.toContain('Belief');

    completeNodeRead(extension, targetThread, activeTurn, [MEMORY_NODE_ID]);
    completeMemoryTurn(
      extension,
      targetThread,
      completedResponseTurn(activeTurn, `Used the saved preference [[node:^${MEMORY_NODE_ID}]].`),
    );
    expect(store.usageForNode(MEMORY_NODE_ID).count).toBe(1);
  });

  test('does not count ordinary Nodes, failed reads, or uncited Memory reads', () => {
    const { extension, store, targetThread, activeTurn } = memoryUsageHarness();
    extension.contributeThreadContext(targetThread);
    completeNodeRead(extension, targetThread, activeTurn, ['ordinary:1']);
    completeNodeRead(extension, targetThread, activeTurn, [MEMORY_NODE_ID], false);
    completeNodeRead(extension, targetThread, activeTurn, [MEMORY_NODE_ID]);

    completeMemoryTurn(extension, targetThread, completedResponseTurn(activeTurn));
    expect(store.usageForNode(MEMORY_NODE_ID).count).toBe(0);
  });

  test('does not count literal Memory markers in code or existing Markdown links', () => {
    const { extension, store, targetThread, activeTurn } = memoryUsageHarness();
    extension.contributeThreadContext(targetThread);
    completeNodeRead(extension, targetThread, activeTurn, [MEMORY_NODE_ID]);
    const marker = `[[node:^${MEMORY_NODE_ID}]]`;
    const response = [
      `Inline code: \`${marker}\``,
      `\`\`\`text\n${marker}\n\`\`\``,
      `[Existing link](https://example.test/${marker} "${marker}")`,
    ].join('\n\n');

    completeMemoryTurn(extension, targetThread, completedResponseTurn(activeTurn, response));
    expect(store.usageForNode(MEMORY_NODE_ID).count).toBe(0);
  });

  test('deduplicates actually read Memory Nodes and bounds inline citation accounting', () => {
    const { extension, store, targetThread, activeTurn, projection } = memoryUsageHarness(memoryProjection(10));
    const memoryNodeIds = canonicalMemoryGraph(projection).nodes.map((entry) => entry.node.id);
    extension.contributeThreadContext(targetThread);
    completeNodeRead(extension, targetThread, activeTurn, memoryNodeIds);
    completeNodeRead(extension, targetThread, activeTurn, memoryNodeIds);

    const inlineCitations = memoryNodeIds.map((nodeId) => `[[node:^${nodeId}]]`).join(' ');
    completeMemoryTurn(extension, targetThread, completedResponseTurn(activeTurn, inlineCitations));
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

  test('allows explicit eligible foreground Memory writes and rejects Automation causation', () => {
    const store = memoryStore();
    const projection = memoryProjection();
    const thread = rootThread([userTurn('remember this preference')]);
    const extension = new MemoryExtension(store, new TimelineMemoryStore(readOnlyTimelineHost(projection)));
    extension.bindHost(memoryThreadHost(thread));
    extension.contributeTurnAdmission(admissionContext(thread, thread.turns![0]!));
    expect(extension.authorizeMutation('apply_tag', {
      nodeId: 'ordinary:1',
      tagId: 'tag:d-memory',
    }, {}, projection)).toBe(true);
    expect(extension.authorizeMutation('apply_tag', {
      nodeId: 'ordinary:1',
      tagId: 'tag:d-memory',
    }, {
      origin: 'agent',
      causation: { threadId: THREAD_ID, turnId: TURN_ID, itemId: ITEM_ID },
    }, projection)).toBe(true);

    const automation = rootThread([userTurn(
      'remember this preference',
      undefined,
      { kind: 'feature', feature: 'automation' },
      'turn:auto',
      'item:auto',
    )]);
    const denied = new MemoryExtension(store, new TimelineMemoryStore(readOnlyTimelineHost(projection)));
    denied.bindHost(memoryThreadHost(automation));
    denied.contributeTurnAdmission(admissionContext(automation, automation.turns![0]!));
    expect(store.admission('turn:auto')?.eligibleAtAdmission).toBe(false);
    expect(() => denied.authorizeMutation('apply_tag', {
      nodeId: 'ordinary:1',
      tagId: 'tag:d-memory',
    }, {
      origin: 'agent',
      causation: { threadId: THREAD_ID, turnId: 'turn:auto', itemId: 'item:auto' },
    }, projection)).toThrow('not authorized');
  });

  test('resolves reserved Memory tag names only from structured tag fields', () => {
    const projection = memoryProjection();
    const extension = new MemoryExtension(
      memoryStore(),
      new TimelineMemoryStore(readOnlyTimelineHost(projection)),
    );
    const richText = (text: string) => ({ text, marks: [], inlineRefs: [] });
    const tree = (tags: string[] = [], children: unknown[] = []) => ({
      content: richText('Tree node'),
      tags,
      children,
    });

    expect(extension.authorizeMutation('create_tag_and_tagged_node', {
      parentId: 'ordinary:1',
      content: richText('Named tag'),
      name: ' D-MEMORY ',
    }, {}, projection)).toBe(true);
    expect(extension.authorizeMutation('create_nodes_from_tree', {
      parentId: 'ordinary:1',
      nodes: [tree([], [tree(['d-belief'])])],
    }, {}, projection)).toBe(true);

    const pasteCases = [
      { firstMeta: { tags: ['d-question'] }, children: [], siblingsAfter: [] },
      { firstMeta: {}, children: [tree([], [tree(['d-guidance'])])], siblingsAfter: [] },
      { firstMeta: {}, children: [], siblingsAfter: [tree(['d-episode'])] },
    ];
    for (const args of pasteCases) {
      expect(extension.authorizeMutation('paste_nodes_into_node', {
        nodeId: 'ordinary:1',
        content: richText('Paste'),
        ...args,
      }, {}, projection)).toBe(true);
    }

    expect(extension.authorizeMutation('create_node', {
      parentId: 'ordinary:1',
      text: 'Ordinary text mentioning tag:d-memory and d-memory',
    }, {}, projection)).toBe(false);
    expect(extension.authorizeMutation('create_tag_and_tagged_node', {
      parentId: 'ordinary:1',
      content: richText('d-memory appears only in content'),
      name: 'ordinary-tag',
    }, {}, projection)).toBe(false);
  });

  test('rejects feature Turns that would move stray tagged content into the canonical graph', () => {
    const store = memoryStore();
    const projection = memoryProjection();
    const removedIds = new Set([MEMORY_NODE_ID, EPISODE_NODE_ID, 'belief:1']);
    projection.nodes = projection.nodes
      .filter((entry) => !removedIds.has(entry.id))
      .map((entry) => entry.id === 'day'
        ? { ...entry, children: [] }
        : entry.id === 'ordinary:1'
          ? { ...entry, children: ['stray:1', 'stray:memory'] }
          : entry);
    projection.nodes.push(node('stray:memory', 'ordinary:1', [], ['tag:d-memory'], 'Stray memory'));
    expect(canonicalMemoryGraph(projection).containers).toEqual([]);

    const automation = rootThread([userTurn(
      'Move the tagged node',
      undefined,
      { kind: 'feature', feature: 'automation' },
      'turn:auto-canonicalize',
      'item:auto-canonicalize',
    )]);
    const extension = new MemoryExtension(store, new TimelineMemoryStore(readOnlyTimelineHost(projection)));
    extension.bindHost(memoryThreadHost(automation));
    extension.contributeTurnAdmission(admissionContext(automation, automation.turns![0]!));
    const meta = {
      origin: 'agent' as const,
      causation: {
        threadId: THREAD_ID,
        turnId: 'turn:auto-canonicalize',
        itemId: 'item:auto-canonicalize',
      },
    };

    expect(() => extension.authorizeMutation('move_node', {
      nodeId: 'stray:memory',
      parentId: 'day',
      index: null,
    }, meta, projection)).toThrow('not authorized');
    expect(() => extension.authorizeMutation('apply_node_text_patch', {
      nodeId: 'ordinary:1',
      patch: { ops: [] },
    }, meta, projection)).toThrow('not authorized');
    expect(() => extension.authorizeMutation('apply_node_text_patch', {
      nodeId: 'stray:memory',
      patch: { ops: [] },
    }, meta, projection)).not.toThrow();
  });

  test('classifies Memory mutations by command targets instead of Daily Note ancestors', () => {
    const store = memoryStore();
    const projection = memoryProjection();
    projection.nodes.find((entry) => entry.id === WORKSPACE_ID)!.children.push('ordinary:2');
    projection.nodes.push(node('ordinary:2', WORKSPACE_ID, [], [], 'Ordinary outline node'));
    const automation = rootThread([userTurn(
      'Maintain the daily note',
      undefined,
      { kind: 'feature', feature: 'automation' },
      'turn:automation-targets',
      'item:automation-targets',
    )]);
    const extension = new MemoryExtension(store, new TimelineMemoryStore(readOnlyTimelineHost(projection)));
    extension.bindHost(memoryThreadHost(automation));
    extension.contributeTurnAdmission(admissionContext(automation, automation.turns![0]!));
    const meta = {
      origin: 'agent' as const,
      causation: {
        threadId: THREAD_ID,
        turnId: 'turn:automation-targets',
        itemId: 'item:automation-targets',
      },
    };

    expect(extension.authorizeMutation('create_node', {
      id: 'node:018f0f24-7b2e-7a3f-8a4b-123456789a01',
      parentId: 'day',
      index: null,
      text: 'Ordinary Daily Note sibling',
    }, meta, projection)).toBe(false);
    expect(() => extension.authorizeMutation('create_node', {
      id: 'node:018f0f24-7b2e-7a3f-8a4b-123456789a02',
      parentId: MEMORY_NODE_ID,
      index: null,
      text: 'Memory descendant',
    }, meta, projection)).toThrow('not authorized');
    expect(() => extension.authorizeMutation('move_node', {
      nodeId: 'day',
      parentId: DAILY_NOTES_ID,
      index: null,
    }, meta, projection)).toThrow('not authorized');
    expect(() => extension.authorizeMutation('undo', {
      historyOrigin: 'agent',
      steps: 1,
      historyMutation: {
        status: 'known',
        targets: [{
          operationId: 'op:ordinary',
          affectedNodeIds: ['ordinary:2'],
          affectedNodeCount: 1,
          affectsMemory: false,
        }],
      },
    }, meta, projection)).not.toThrow();
    expect(() => extension.authorizeMutation('undo', {
      historyOrigin: 'agent',
      steps: 1,
      historyMutation: {
        status: 'known',
        targets: [{
          operationId: 'op:memory',
          affectedNodeIds: [MEMORY_NODE_ID],
          affectedNodeCount: 1,
          affectsMemory: true,
        }],
      },
    }, meta, projection)).toThrow('not authorized');
    expect(() => extension.authorizeMutation('undo', {
      historyOrigin: 'agent',
      steps: 1,
    }, meta, projection)).toThrow('not authorized');
    expect(() => extension.authorizeMutation('undo', {
      historyOrigin: 'all',
      steps: 1,
      historyMutation: { status: 'unknown', targets: [] },
    }, meta, projection)).toThrow('not authorized');
    expect(() => extension.authorizeMutation('undo', {
      historyOrigin: 'agent',
      steps: 1,
      historyMutation: {
        status: 'known',
        targets: [{
          operationId: 'op:legacy',
          affectedNodeIds: ['ordinary:2'],
          affectedNodeCount: 1,
        }],
      },
    }, meta, projection)).toThrow('not authorized');
    expect(() => extension.authorizeMutation('redo', {
      historyOrigin: 'agent',
      steps: 1,
      historyMutation: {
        status: 'known',
        targets: [{
          operationId: 'op:truncated',
          affectedNodeIds: ['ordinary:2'],
          affectedNodeCount: 2,
          affectedNodeIdsTruncated: true,
          affectsMemory: false,
        }],
      },
    }, meta, projection)).toThrow('not authorized');
  });

  test('uses persisted history semantics after Memory is no longer canonical', () => {
    const store = memoryStore();
    const projection = memoryProjection();
    const removedIds = new Set([EPISODE_NODE_ID, 'belief:1']);
    projection.nodes = projection.nodes
      .filter((entry) => !removedIds.has(entry.id))
      .map((entry) => entry.id === MEMORY_NODE_ID
        ? { ...entry, children: [], tags: [] }
        : entry);
    expect(canonicalMemoryGraph(projection).containers).toEqual([]);

    const automation = rootThread([userTurn(
      'Undo an ordinary outline change',
      undefined,
      { kind: 'feature', feature: 'automation' },
      'turn:automation-history',
      'item:automation-history',
    )]);
    const extension = new MemoryExtension(store, new TimelineMemoryStore(readOnlyTimelineHost(projection)));
    extension.bindHost(memoryThreadHost(automation));
    extension.contributeTurnAdmission(admissionContext(automation, automation.turns![0]!));

    expect(() => extension.authorizeMutation('undo', {
      historyOrigin: 'user',
      steps: 1,
      historyMutation: {
        status: 'known',
        targets: [{
          operationId: 'op:removed-memory-tag',
          affectedNodeIds: [MEMORY_NODE_ID],
          affectedNodeCount: 1,
          affectsMemory: true,
        }],
      },
    }, {
      origin: 'agent',
      causation: {
        threadId: THREAD_ID,
        turnId: 'turn:automation-history',
        itemId: 'item:automation-history',
      },
    }, projection)).toThrow('not authorized');
  });

  test('protects the day tag only when it can change canonical Memory identity', () => {
    const store = memoryStore();
    const projection = memoryProjection();
    projection.nodes.find((entry) => entry.id === WORKSPACE_ID)!.children.push('ordinary:2');
    projection.nodes.push(node('ordinary:2', WORKSPACE_ID, [], [], 'Ordinary outline node'));
    const automation = rootThread([userTurn(
      'Maintain Daily Notes',
      undefined,
      { kind: 'feature', feature: 'automation' },
      'turn:automation-day-tag',
      'item:automation-day-tag',
    )]);
    const extension = new MemoryExtension(store, new TimelineMemoryStore(readOnlyTimelineHost(projection)));
    extension.bindHost(memoryThreadHost(automation));
    extension.contributeTurnAdmission(admissionContext(automation, automation.turns![0]!));
    const meta = {
      origin: 'agent' as const,
      causation: {
        threadId: THREAD_ID,
        turnId: 'turn:automation-day-tag',
        itemId: 'item:automation-day-tag',
      },
    };

    expect(() => extension.authorizeMutation('remove_tag', {
      nodeId: 'day',
      tagId: TAG_DAY_ID,
    }, meta, projection)).toThrow('not authorized');
    expect(() => extension.authorizeMutation('apply_tag', {
      nodeId: 'ordinary:1',
      tagId: TAG_DAY_ID,
    }, meta, projection)).toThrow('not authorized');
    expect(() => extension.authorizeMutation('apply_tag', {
      nodeId: 'ordinary:2',
      tagId: TAG_DAY_ID,
    }, meta, projection)).not.toThrow();
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

  test('reads transaction membership through the overlay and restores it exactly on rollback', () => {
    const projection = memoryProjection();
    const index = new MemoryMutationIndex(projection);
    const initial = index.debugSnapshot();
    const untaggedContainer = patchProjectionNode(projection, MEMORY_NODE_ID, { tags: [] });

    expect(index.mayChangeMemory('apply_node_text_patch', { nodeId: 'belief:1' }, new Set())).toBe(true);
    index.beginTransaction();
    index.applyTransactionChanges({ changedNodes: [untaggedContainer], removedIds: [] });
    index.applyTransactionChanges({
      changedNodes: [patchProjectionNode(projection, 'day', { content: { text: '2026-08-01', spans: [] } })],
      removedIds: [],
    });
    expect(index.mayChangeMemory('apply_node_text_patch', { nodeId: 'belief:1' }, new Set())).toBe(false);
    index.rollbackTransaction();
    expect(index.debugSnapshot()).toEqual(initial);
    expect(index.mayChangeMemory('apply_node_text_patch', { nodeId: 'belief:1' }, new Set())).toBe(true);

    index.beginTransaction();
    index.applyTransactionChanges({ changedNodes: [untaggedContainer], removedIds: [] });
    index.commitTransaction();
    expect(index.mayChangeMemory('apply_node_text_patch', { nodeId: 'belief:1' }, new Set())).toBe(false);
  });

  test('degrades cyclic ancestor state without hanging canonical classification', () => {
    const projection = memoryProjection();
    const index = new MemoryMutationIndex(projection);
    const cyclicEpisode = patchProjectionNode(projection, EPISODE_NODE_ID, { parentId: 'belief:1' });

    expect(() => index.applyTransactionChanges({
      changedNodes: [cyclicEpisode],
      removedIds: [],
    })).not.toThrow();
    replaceProjectionNodes(projection, [cyclicEpisode]);

    expect(index.canonicalNodesInGraphOrder().map((entry) => entry.node.id)).toEqual([MEMORY_NODE_ID]);
    expect(index.mayChangeMemory('apply_node_text_patch', { nodeId: 'belief:1' }, new Set())).toBe(true);
  });

  test('updates by-name tag classification from every sparse delta', () => {
    const projection = memoryProjection();
    const index = new MemoryMutationIndex(projection);
    const definition = projection.nodes.find((entry) => entry.id === 'tag:d-memory')!;
    expect(index.mayChangeMemory('create_tag_and_tagged_node', { name: ' D-MEMORY ' }, new Set())).toBe(true);

    const renamed = { ...definition, content: { text: 'renamed-memory-tag', spans: [] } } as NodeProjection;
    index.applyTransactionChanges({
      changedNodes: [renamed],
      removedIds: [],
    });
    expect(index.mayChangeMemory('create_tag_and_tagged_node', { name: 'd-memory' }, new Set())).toBe(false);
    expect(index.mayChangeMemory('create_tag_and_tagged_node', { name: 'renamed-memory-tag' }, new Set())).toBe(true);

    index.applyTransactionChanges({
      changedNodes: [{ ...renamed, parentId: TRASH_ID } as NodeProjection],
      removedIds: [],
    });
    expect(index.mayChangeMemory('create_tag_and_tagged_node', { name: 'renamed-memory-tag' }, new Set())).toBe(false);
  });

  test('keeps plain typing projection-free and reconciles ancestor-derived generated edits synchronously', async () => {
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
    let projectionReads = 0;

    expect(extension.authorizeMutation('apply_node_text_patch', {
      nodeId: 'ordinary:2',
      patch: { ops: [] },
    }, {}, () => {
      projectionReads += 1;
      return projection;
    })).toBe(false);
    expect(extension.authorizeMutation('apply_node_text_patch', {
      nodeId: 'belief:1',
      patch: { ops: [] },
    }, {}, () => {
      projectionReads += 1;
      return projection;
    })).toBe(true);
    expect(projectionReads).toBe(0);

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

    const renamedBelief = patchProjectionNode(projection, 'belief:1', {
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
    const renamedBelief = patchProjectionNode(projection, 'belief:1', {
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

    const renamedAgain = patchProjectionNode(projection, 'belief:1', {
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
          replaceProjectionNodes(projection, [], ['belief:1']);
          return {
            kind: 'delta',
            revision: 1,
            todayId: projection.todayId,
            changedNodes: [],
            removedIds: ['belief:1'],
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
    extension.documentChanged();
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
    const movedEntry = canonicalMemoryGraph(movedProjection).nodes.find((entry) => entry.node.id === 'belief:1')!;
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
    const movedBelief = movedProjection.nodes.find((entry) => entry.id === 'belief:1')!;
    movedBelief.content = { text: 'System publication text', spans: [] };
    movedExtension.documentChanged('memory:stage2:test');
    expect(movedStore.generatedNodes()[0]?.userAuthoritative).toBe(false);
    movedBelief.content = { text: 'Belief', spans: [] };
    movedExtension.documentChanged();
    expect(movedStore.generatedNodes()[0]?.userAuthoritative).toBe(false);

    const secondEpisode = node('episode:2', MEMORY_NODE_ID, ['belief:1'], ['tag:d-episode'], 'Second episode');
    movedProjection.nodes.push(secondEpisode);
    const container = movedProjection.nodes.find((entry) => entry.id === MEMORY_NODE_ID)!;
    container.children = [EPISODE_NODE_ID, secondEpisode.id];
    const firstEpisode = movedProjection.nodes.find((entry) => entry.id === EPISODE_NODE_ID)!;
    firstEpisode.children = [];
    const belief = movedProjection.nodes.find((entry) => entry.id === 'belief:1')!;
    belief.parentId = secondEpisode.id;
    movedExtension.documentChanged();
    expect(movedStore.generatedNodes()[0]?.userAuthoritative).toBe(true);

    const taggedStore = memoryStore();
    const taggedProjection = memoryProjection();
    const taggedTimeline = new TimelineMemoryStore(readOnlyTimelineHost(taggedProjection));
    const taggedEntry = canonicalMemoryGraph(taggedProjection).nodes.find((entry) => entry.node.id === 'belief:1')!;
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
    taggedProjection.nodes.find((entry) => entry.id === 'belief:1')!.tags.push('tag:personal');
    taggedExtension.documentChanged();
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
          sourceNodeIds: ['belief:1'],
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
            nodeId: 'belief:1',
            action: 'update',
            text: 'Merged belief',
            sourceNodeIds: ['belief:1', questionId],
          },
          { nodeId: questionId, action: 'delete' },
        ],
      }),
    }, () => rootThread([]));

    await expect(phase.run(new AbortController().signal)).resolves.toBe('published');
    expect(timeline.graph().nodes.find((entry) => entry.node.id === 'belief:1')?.node.content.text).toBe('Merged belief');
    expect(store.lineageForNode('belief:1').map((entry) => entry.originItemId)).toEqual([ITEM_ID, secondItemId]);
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
          { nodeId: 'belief:1', action: 'delete' },
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
          { nodeId: 'belief:1', action: 'delete' },
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

  test('rejects Memory Node mutation from a Turn that was active across Reset', async () => {
    const store = memoryStore();
    const timelineState = mutableTimelineHost(memoryProjection());
    const timeline = new TimelineMemoryStore(timelineState.host);
    const activeTurn: Turn = {
      ...userTurn('Remember this after the reset'),
      status: 'inProgress',
      completedAt: null,
      durationMs: null,
    };
    const thread: Thread = {
      ...rootThread([activeTurn]),
      status: { type: 'active', activeFlags: [] },
    };
    const extension = new MemoryExtension(store, timeline);
    extension.bindHost({
      ...memoryThreadHost(thread),
      activeRootUserTurns: () => [{ threadId: thread.id, turnId: activeTurn.id }],
    });
    extension.contributeTurnAdmission(admissionContext(thread, activeTurn));

    await extension.reset();

    expect(store.isTurnExcluded(activeTurn.id)).toBe(true);
    expect(store.status().resetEpoch).toBe(1);
    expect(timelineState.projection().nodes.some((entry) => entry.id === MEMORY_NODE_ID)).toBe(false);
    expect(timelineState.projection().nodes.some((entry) => entry.id === 'stray:1')).toBe(true);
    expect(() => extension.authorizeMutation('apply_tag', {
      nodeId: 'ordinary:1',
      tagId: 'tag:d-memory',
    }, {
      origin: 'agent',
      causation: { threadId: thread.id, turnId: activeTurn.id, itemId: ITEM_ID },
    }, timelineState.projection())).toThrow('not authorized');
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
    timelineState.projection().nodes.find((entry) => entry.id === 'belief:1')!.content = {
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
    expect(timelineState.projection().nodes.find((entry) => entry.id === 'belief:1')?.content.text)
      .toBe('User authoritative edit');
    expect(store.generatedNodes().find((entry) => entry.nodeId === 'belief:1')?.userAuthoritative).toBe(true);
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
    timelineState.projection().nodes.find((entry) => entry.id === 'belief:1')!.content = {
      text: 'Concurrent edit before preparation',
      spans: [],
    };
    releaseGate();
    await gate;

    await expect(run).resolves.toBe('published');
    expect(timelineState.projection().nodes.find((entry) => entry.id === 'belief:1')?.content.text)
      .toBe('Concurrent edit before preparation');
    expect(store.generatedNodes().find((entry) => entry.nodeId === 'belief:1')?.userAuthoritative).toBe(true);
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
            { nodeId: 'belief:1', action: 'delete' },
          ],
        });
      },
    }, () => rootThread([]));
    const run = phase.run(new AbortController().signal);
    await started;
    const projection = timelineState.projection();
    projection.nodes.push(node('ordinary:late-child', 'belief:1', [], [], 'Late user note'));
    projection.nodes.find((entry) => entry.id === 'belief:1')!.children.push('ordinary:late-child');
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
    agentNickname: null,
    agentRole: null,
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
  const item: ThreadItem = {
    type: 'userMessage',
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
  affectsMemory: boolean,
): ProjectionChangedDelivery {
  return {
    event: {
      type: 'projection_changed',
      origin: 'user',
      update,
      timestamp: Date.now(),
    },
    affectsMemory,
  };
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
  index.applyTransactionChanges({ changedNodes, removedIds });
  replaceProjectionNodes(projection, changedNodes, removedIds);
}

function fullScanMemoryMutationSnapshot(projection: DocumentProjection) {
  const nodes = new Map(projection.nodes.map((entry) => [entry.id, entry]));
  const reservedTagIds = new Set(MEMORY_TAG_DEFINITIONS.map((entry) => entry.tagId));
  const reservedTagged = projection.nodes.filter((entry) => entry.tags.some((tagId) => reservedTagIds.has(tagId)));
  const protectedAncestors = new Set<string>();
  const collectAncestors = (nodeId: string) => {
    const visited = new Set<string>();
    let current = nodes.get(nodeId);
    while (current?.parentId && !visited.has(current.parentId)) {
      protectedAncestors.add(current.parentId);
      visited.add(current.parentId);
      current = nodes.get(current.parentId);
    }
  };
  for (const entry of reservedTagged) collectAncestors(entry.id);

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
    collectAncestors(container.node.id);
  }
  return {
    owned: [...owned].sort(),
    protectedAncestors: [...protectedAncestors].sort(),
    reservedTagged: reservedTagged.map((entry) => entry.id).sort(),
    canonical: graph.nodes.map((entry) => entry.node.id).sort(),
    canonicalFingerprints: graph.nodes
      .map((entry) => [entry.node.id, timelineNodeFingerprint(entry)] as const)
      .sort(([left], [right]) => left.localeCompare(right)),
  };
}

function memoryProjection(extraBeliefs = 0): DocumentProjection {
  const beliefIds = [
    'belief:1',
    ...Array.from({ length: extraBeliefs }, (_, index) => `belief:extra:${index}`),
  ];
  const nodes = [
    node(WORKSPACE_ID, undefined, [DAILY_NOTES_ID, 'ordinary:1']),
    node(DAILY_NOTES_ID, WORKSPACE_ID, ['year']),
    node('year', DAILY_NOTES_ID, ['week']),
    node('week', 'year', ['day']),
    node('day', 'week', [MEMORY_NODE_ID], [TAG_DAY_ID], '2026-07-24'),
    node(MEMORY_NODE_ID, 'day', [EPISODE_NODE_ID], ['tag:d-memory'], 'Daily memory'),
    node(EPISODE_NODE_ID, MEMORY_NODE_ID, beliefIds, ['tag:d-episode'], 'Episode'),
    node('belief:1', EPISODE_NODE_ID, [], ['tag:d-belief'], 'Belief'),
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
    transaction: async () => { throw new Error('not used'); },
    readDocumentSystemReceipt: async () => null,
    readDocumentSystemTagDefinition: async () => null,
  };
}

function mutableTimelineHost(initial: DocumentProjection) {
  let projection = initial;
  let receipt: DocumentSystemReceipt | null = null;
  const deletedNodeIds: string[] = [];
  const host: TimelineMemoryHost = {
    getProjection: () => projection,
    transaction: async (_context, operation) => operation({
      executeDocumentCommand: async (command, args) => {
        if (command === 'ensure_date_node') return { focus: { nodeId: 'day' } };
        const nodeId = String(args.nodeId ?? args.id ?? '');
        if (command === 'create_node') {
          const parentId = String(args.parentId);
          const created = node(nodeId, parentId, [], [], String(args.text ?? ''));
          projection = {
            ...projection,
            nodes: [
              ...projection.nodes.map((entry) => entry.id === parentId
                ? { ...entry, children: [...entry.children, nodeId] }
                : entry),
              created,
            ],
          };
          return { focus: { nodeId } };
        }
        if (command === 'apply_tag') {
          projection = {
            ...projection,
            nodes: projection.nodes.map((entry) => entry.id === nodeId
              ? { ...entry, tags: [...new Set([...entry.tags, String(args.tagId)])] }
              : entry),
          };
          return {};
        }
        if (command === 'apply_node_text_patch') {
          const patch = args.patch as { ops?: Array<{ type?: string; content?: { text?: string } }> };
          const text = patch.ops?.find((op) => op.type === 'replace_all')?.content?.text ?? '';
          projection = {
            ...projection,
            nodes: projection.nodes.map((entry) => entry.id === nodeId
              ? { ...entry, content: { text, spans: [] } }
              : entry),
          };
          return {};
        }
        if (command !== 'delete_node') throw new Error(`Unexpected test command: ${command}`);
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
        return {};
      },
      executeHostCommand: async (command, args) => {
        if (command === 'put_document_system_receipt') receipt = args.receipt;
      },
    }),
    readDocumentSystemReceipt: async () => receipt,
    readDocumentSystemTagDefinition: async () => null,
  };
  return { host, deletedNodeIds, projection: () => projection };
}

function memoryThreadHost(thread: Thread): MemoryThreadHost {
  return {
    persistentRootThreads: () => [thread],
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

function completeNodeRead(
  extension: MemoryExtension,
  thread: Thread,
  turn: Turn,
  nodeIds: readonly string[],
  ok = true,
): void {
  extension.onToolCompleted({
    threadId: thread.id,
    turnId: turn.id,
    itemId: `item:read:${nodeIds.join(':')}`,
    identity: { namespace: null, name: 'node_read' },
    arguments: nodeIds.length === 1 ? { node_id: nodeIds[0]! } : { node_ids: [...nodeIds] },
    result: ok
      ? { ok: true, data: { items: nodeIds.map((nodeId) => ({ nodeId })) } }
      : { ok: false, error: { code: 'node_not_found', message: 'Missing' } },
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
