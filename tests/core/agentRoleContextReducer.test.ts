import { describe, expect, test } from 'bun:test';
import type {
  CompactionRestoredStateContextPayload,
  ContextCompactionThreadItem,
  ContextEvidenceThreadItem,
  ContextResetThreadItem,
  RoleCatalogContextPayload,
  RoleCatalogEntry,
  ThreadContextPayload,
  ThreadContextPayloadReference,
  ThreadItem,
  Turn,
} from '../../src/core/agent/protocol';
import {
  planRoleCatalogEvidence,
  reduceRoleContext,
} from '../../src/main/agent/context/RoleContextReducer';
import { uuidV7 } from '../../src/main/agent/uuid';

describe('Role context reducer', () => {
  test('emits one baseline and appends deterministic changes for an old conversation', async () => {
    const store = contextStore();
    const baseline = catalog('1', [entry('default', 'a1'), entry('worker', 'w1')]);
    const firstTurn = turn([store.evidence(baseline)]);
    expect(await planRoleCatalogEvidence({ turns: [], snapshot: baseline, readContext: store.read })).toEqual(baseline);
    expect(await planRoleCatalogEvidence({ turns: [firstTurn], snapshot: baseline, readContext: store.read })).toBeNull();

    const next = catalog('2', [entry('default', 'a2'), entry('reviewer', 'r1')]);
    const delta = await planRoleCatalogEvidence({ turns: [firstTurn], snapshot: next, readContext: store.read });
    expect(delta).toEqual({
      schemaVersion: 1,
      kind: 'roleCatalog',
      mode: 'delta',
      previousCatalogHash: baseline.catalogHash,
      catalogHash: next.catalogHash,
      entries: [
        { ...entry('default', 'a2'), change: 'changed' },
        { ...entry('reviewer', 'r1'), change: 'added' },
        { ...entry('worker', 'w1'), change: 'removed' },
      ],
    });
    const restored = await reduceRoleContext([firstTurn, turn([store.evidence(delta!)])], store.read);
    expect([...restored.catalogEntries.keys()]).toEqual(['default', 'reviewer']);
  });

  test('starts a fresh baseline after reset and validates compaction checkpoints', async () => {
    const store = contextStore();
    const baseline = catalog('1', [entry('default', 'a1')]);
    const baselineItem = store.evidence(baseline);
    const restoredState: CompactionRestoredStateContextPayload = {
      schemaVersion: 1,
      kind: 'compactionRestoredState',
      skillCatalogHash: null,
      announcedSkills: [],
      activeSkills: [],
      roleCatalogHash: baseline.catalogHash,
      announcedRoles: [{ name: 'default', identity: 'built-in:default', contentHash: 'a1' }],
      userViewBaselineRef: null,
      additionalContextBaselineRef: null,
      activeObservations: [],
      degradations: [],
    };
    const compactedTurnId = turnId();
    const compacted = [turn([
      baselineItem,
      store.compaction(restoredState, compactedTurnId, baselineItem.id),
    ], compactedTurnId)];
    expect((await reduceRoleContext(compacted, store.read)).catalogEntries.get('default'))
      .toEqual(baseline.entries[0]);

    const resetTurns = [...compacted, turn([contextReset()])];
    expect(await reduceRoleContext(resetTurns, store.read)).toMatchObject({
      catalogHash: null,
      catalogEntries: new Map(),
    });
    expect(await planRoleCatalogEvidence({ turns: resetTurns, snapshot: baseline, readContext: store.read }))
      .toEqual(baseline);

    const mismatched = { ...restoredState, roleCatalogHash: hash('9') };
    const mismatchedBaseline = store.evidence(baseline);
    const mismatchedTurnId = turnId();
    const mismatchedState = await reduceRoleContext([
      turn([
        mismatchedBaseline,
        store.compaction(mismatched, mismatchedTurnId, mismatchedBaseline.id),
      ], mismatchedTurnId),
    ], store.read);
    expect(mismatchedState.catalogHash).toBeNull();
    expect(mismatchedState.catalogEntries.size).toBe(0);
    expect(mismatchedState.degradations).toContainEqual(expect.objectContaining({
      code: 'checkpointMismatch',
      source: 'roleCatalog',
    }));
  });

  test('reduces an inherited Role catalog without repeating an unchanged registry', async () => {
    const store = contextStore();
    const snapshot = catalog('1', [entry('default', 'a1'), entry('worker', 'w1')]);
    const inherited = store.inherit([turn([store.evidence(snapshot)])]);
    const turns = [turn([inherited])];

    const restored = await reduceRoleContext(turns, store.read);
    expect(restored.catalogHash).toBe(snapshot.catalogHash);
    expect([...restored.catalogEntries.keys()]).toEqual(['default', 'worker']);
    expect(await planRoleCatalogEvidence({ turns, snapshot, readContext: store.read })).toBeNull();
  });

  test('degrades and requests a fresh baseline when a delta skips the previous catalog hash', async () => {
    const store = contextStore();
    const baseline = catalog('1', [entry('default', 'a1')]);
    const broken: RoleCatalogContextPayload = {
      ...catalog('2', [entry('worker', 'w1')]),
      mode: 'delta',
      previousCatalogHash: hash('9'),
    };
    const state = await reduceRoleContext([
      turn([store.evidence(baseline), store.evidence(broken)]),
    ], store.read);
    expect(state.catalogHash).toBeNull();
    expect(state.catalogEntries.size).toBe(0);
    expect(state.degradations).toContainEqual(expect.objectContaining({
      code: 'journalDiscontinuity',
      source: 'roleCatalog',
    }));
  });
});

function contextStore() {
  const payloads = new Map<string, ThreadContextPayload>();
  let index = 0;
  const put = (payload: ThreadContextPayload): ThreadContextPayloadReference => {
    const ref: ThreadContextPayloadReference = {
      id: hash(String(++index)),
      mimeType: 'application/vnd.tenon.agent-context+json',
      byteLength: JSON.stringify(payload).length,
      schemaVersion: 1,
      kind: payload.kind,
    };
    payloads.set(ref.id, payload);
    return ref;
  };
  return {
    read: async (ref: ThreadContextPayloadReference) => payloads.get(ref.id) ?? null,
    evidence(payload: RoleCatalogContextPayload): ContextEvidenceThreadItem {
      const payloadRef = put(payload);
      return {
        ...itemBase(`role-${++index}`),
        type: 'contextEvidence',
        kind: 'roleCatalog',
        payloadRef,
        summary: 'Available Roles',
        contextRefs: [],
        resourceRefs: [],
        outputRefs: [],
      };
    },
    inherit(turns: readonly Turn[]): ContextEvidenceThreadItem {
      const lastTurn = turns.at(-1)!;
      const payloadRef = put({
        schemaVersion: 1,
        kind: 'inheritedContext',
        sourceThreadId: threadId(),
        coveredThrough: { turnId: lastTurn.id, itemId: lastTurn.items.at(-1)!.id },
        requestedTurns: 'all',
        turns,
      });
      return {
        ...itemBase(`inherited-${++index}`),
        type: 'contextEvidence',
        kind: 'inheritedContext',
        payloadRef,
        summary: 'Inherited context',
        contextRefs: turns.flatMap((turn) => turn.items.flatMap((item) => (
          item.type === 'contextEvidence' ? [item.payloadRef, ...item.contextRefs] : []
        ))),
        resourceRefs: [],
        outputRefs: [],
      };
    },
    compaction(
      payload: CompactionRestoredStateContextPayload,
      coveredTurnId: ReturnType<typeof turnId>,
      coveredFromItemId: string,
      coveredThroughItemId = coveredFromItemId,
    ): ContextCompactionThreadItem {
      const restoredStateRef = put(payload);
      const summaryRef = put({ schemaVersion: 1, kind: 'compactionSummary', source: 'deterministic', text: 'Summary' });
      return {
        ...itemBase(`compaction-${++index}`),
        type: 'contextCompaction',
        trigger: 'automaticPreflight',
        coveredFrom: { turnId: coveredTurnId, itemId: coveredFromItemId },
        coveredThrough: { turnId: coveredTurnId, itemId: coveredThroughItemId },
        preservedFrom: null,
        summaryRef,
        restoredStateRef,
        instructionsRef: null,
        contextRefs: [summaryRef, restoredStateRef],
        resourceRefs: [],
        outputRefs: [],
      };
    },
  };
}

function catalog(seed: string, entries: readonly RoleCatalogEntry[]): RoleCatalogContextPayload {
  return {
    schemaVersion: 1,
    kind: 'roleCatalog',
    mode: 'baseline',
    previousCatalogHash: null,
    catalogHash: hash(seed),
    entries,
  };
}

function entry(name: string, contentHash: string): RoleCatalogEntry {
  const source = name === 'reviewer' ? 'project' as const : 'built-in' as const;
  return {
    change: 'available',
    name,
    displayName: name,
    source,
    identity: `${source}:${name}`,
    contentHash,
    description: `${name} description`,
  };
}

function contextReset(): ContextResetThreadItem {
  return {
    ...itemBase('context-reset'),
    type: 'contextReset',
    clearedThrough: { turnId: turnId(), itemId: 'cleared' },
  };
}

function turn(items: readonly ThreadItem[], id = turnId()): Turn {
  return {
    id,
    items,
    itemsView: 'full',
    provenance: { originThreadId: threadId(), originTurnId: turnId(), trigger: { kind: 'user' } },
    status: 'completed',
    error: null,
    execution: {
      modelProvider: 'openai',
      model: 'test-model',
      reasoningEffort: 'medium',
      diagnosticsRef: null,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: null },
    },
    startedAt: 1,
    completedAt: 2,
    durationMs: 1,
  };
}

function itemBase(id: string) {
  return { id, provenance: { originThreadId: threadId(), originTurnId: turnId(), originItemId: id } };
}

function threadId() {
  return uuidV7(1_720_000_000_000);
}

function turnId() {
  return uuidV7(1_720_000_100_000);
}

function hash(seed: string): string {
  return seed.repeat(64).slice(0, 64);
}
