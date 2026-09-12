import { describe, expect, test } from 'bun:test';
import { DAILY_NOTES_ID, TAG_DAY_ID, TRASH_ID, WORKSPACE_ID, type DocumentProjection, type NodeProjection } from '../../src/core/types';
import { AgentToolFailure } from '../../src/main/agent/AgentToolFailure';
import {
  captureMemoryResetTarget,
  decodeMemoryResetTarget,
  memoryResetReview,
  requireMatchingMemoryResetTarget,
} from '../../src/main/agent/extensions/memory/MemoryResetTarget';

const MEMORY_ID = 'memory';
const EPOCH = 3;

describe('Memory Reset reviewed targets', () => {
  test('owns canonical containers and ordinary descendants but not referenced or stray content', () => {
    const projection = fixture();
    const target = captureMemoryResetTarget(projection, EPOCH);
    expect(target.containerIds).toEqual([MEMORY_ID]);
    expect(memoryResetReview(target)).toEqual({
      resetEpoch: EPOCH, containerCount: 1, nodeCount: 5, ordinaryNodeCount: 2,
    });
    expect(JSON.stringify(target)).not.toContain('Secret memory prose');
    expect(JSON.stringify(memoryResetReview(target))).not.toContain(MEMORY_ID);
    expect(() => requireMatchingMemoryResetTarget(projection, EPOCH, target)).not.toThrow();
  });

  test('preserves the exact target through JSON persistence and projection ordering', () => {
    const projection = fixture();
    const target = captureMemoryResetTarget(projection, EPOCH);
    projection.nodes.reverse();
    expect(decodeMemoryResetTarget(JSON.parse(JSON.stringify(target)))).toEqual(target);
    expect(captureMemoryResetTarget(JSON.parse(JSON.stringify(projection)), EPOCH)).toEqual(target);
    expect(Object.isFrozen(target)).toBe(true);
    expect(Object.isFrozen(target.containerIds)).toBe(true);
  });

  test('keeps reviewed counts and identity detached from later mutable projection edits', () => {
    const projection = fixture();
    const target = captureMemoryResetTarget(projection, EPOCH);
    const decoded = decodeMemoryResetTarget(JSON.parse(JSON.stringify(target)));
    get(projection, MEMORY_ID).children.push('new');
    projection.nodes.push(node('new', MEMORY_ID));
    expect(memoryResetReview(target).nodeCount).toBe(5);
    expect(decoded).toEqual(target);
    expect(() => requireMatchingMemoryResetTarget(projection, EPOCH, decoded)).toThrow('Memory changed');
  });

  test('uses persisted JSON semantics for optional fields during restart validation', () => {
    const projection = fixture();
    get(projection, 'note').description = undefined;
    const target = captureMemoryResetTarget(projection, EPOCH);
    const restored = JSON.parse(JSON.stringify(projection)) as DocumentProjection;
    expect(() => requireMatchingMemoryResetTarget(restored, EPOCH, target)).not.toThrow();
  });

  for (const [name, mutate] of Object.entries<(projection: DocumentProjection) => void>({
    'text edit': (projection) => { get(projection, 'note').content.text = 'Edited after review'; },
    'formatting edit': (projection) => { get(projection, 'note').content.marks.push({ start: 0, end: 4, type: 'bold' }); },
    'description edit': (projection) => { get(projection, 'note').description = 'New description'; },
    'tag edit': (projection) => { get(projection, 'note').tags.push('tag:ordinary'); },
    'reference retarget': (projection) => { Object.assign(get(projection, 'attachment'), { targetId: 'stray' }); },
    'child order': (projection) => { get(projection, MEMORY_ID).children.reverse(); },
    'new ordinary child': (projection) => {
      get(projection, 'note').children.push('new');
      projection.nodes.push(node('new', 'note'));
    },
    'removed child': (projection) => {
      get(projection, MEMORY_ID).children = ['episode'];
      projection.nodes = projection.nodes.filter((item) => item.id !== 'note' && item.id !== 'attachment');
    },
    'moved child': (projection) => {
      get(projection, MEMORY_ID).children = ['episode'];
      get(projection, 'outside').children.push('note');
      get(projection, 'note').parentId = 'outside';
    },
    'day rename': (projection) => { get(projection, 'day').content.text = '2026-09-08'; },
    'ancestor reparenting': (projection) => {
      get(projection, DAILY_NOTES_ID).children = ['week'];
      projection.nodes.push(node('week', DAILY_NOTES_ID, ['day']));
      get(projection, 'day').parentId = 'week';
    },
    'container moved to Trash': (projection) => {
      get(projection, 'day').children = [];
      get(projection, TRASH_ID).children = [MEMORY_ID];
      get(projection, MEMORY_ID).parentId = TRASH_ID;
    },
    'new canonical container': (projection) => {
      get(projection, 'day').children.push('another-memory');
      projection.nodes.push(node('another-memory', 'day', [], ['tag:mem-day']));
    },
  })) {
    test(`rejects ${name} after review without mutating the projection`, () => {
      const projection = fixture();
      const target = captureMemoryResetTarget(projection, EPOCH);
      mutate(projection);
      const before = structuredClone(projection);
      expect(() => requireMatchingMemoryResetTarget(projection, EPOCH, target)).toThrow('Memory changed');
      expect(projection).toEqual(before);
    });
  }

  test('rejects a different reset epoch, workspace, root, or tampered review count', () => {
    const projection = fixture();
    const target = captureMemoryResetTarget(projection, EPOCH);
    expect(() => requireMatchingMemoryResetTarget(projection, EPOCH + 1, target)).toThrow('Memory changed');
    expect(() => requireMatchingMemoryResetTarget({ ...projection, workspaceId: 'other' }, EPOCH, target)).toThrow('Memory changed');
    expect(() => requireMatchingMemoryResetTarget(projection, EPOCH, { ...target, rootId: 'other' })).toThrow('Memory changed');
    expect(() => requireMatchingMemoryResetTarget(projection, EPOCH, { ...target, ordinaryNodeCount: 1 })).toThrow('Memory changed');
  });

  test('does not invalidate a review for unrelated edits or new sibling notes', () => {
    const projection = fixture();
    const target = captureMemoryResetTarget(projection, EPOCH);
    get(projection, 'outside').content.text = 'Unrelated edit';
    get(projection, 'stray').content.text = 'Still not owned by Memory';
    get(projection, 'day').children.push('sibling');
    projection.nodes.push(node('sibling', 'day'));
    expect(() => requireMatchingMemoryResetTarget(projection, EPOCH, target)).not.toThrow();
  });

  test('permits an empty canonical target while preserving stray content', () => {
    const projection = fixture();
    get(projection, MEMORY_ID).tags = [];
    const target = captureMemoryResetTarget(projection, EPOCH);
    expect(target.containerIds).toEqual([]);
    expect(memoryResetReview(target)).toEqual({ resetEpoch: EPOCH, containerCount: 0, nodeCount: 0, ordinaryNodeCount: 0 });
    expect(() => requireMatchingMemoryResetTarget(projection, EPOCH, target)).not.toThrow();
  });

  for (const [name, mutate] of Object.entries<(projection: DocumentProjection) => void>({
    'missing child': (projection) => { get(projection, 'note').children.push('missing'); },
    'repeated child': (projection) => { get(projection, MEMORY_ID).children.push('note'); },
    'inconsistent parent': (projection) => { get(projection, 'note').parentId = 'outside'; },
    'unlisted descendant': (projection) => { projection.nodes.push(node('unlisted', 'note')); },
    'broken container ancestry': (projection) => { get(projection, 'day').children = []; },
    'duplicate identity': (projection) => { projection.nodes.push(structuredClone(get(projection, 'note'))); },
    'missing root': (projection) => { projection.nodes = projection.nodes.filter((item) => item.id !== WORKSPACE_ID); },
    'cycle': (projection) => { get(projection, 'note').children.push(MEMORY_ID); },
  })) {
    test(`refuses ${name} before Reset admission`, () => {
      const projection = fixture();
      mutate(projection);
      try {
        captureMemoryResetTarget(projection, EPOCH);
        throw new Error('Expected target refusal');
      } catch (error) {
        expect(error).toBeInstanceOf(AgentToolFailure);
        expect((error as AgentToolFailure).code).toBe('memory_target_unavailable');
      }
    });
  }

  test('rejects malformed, legacy, or inconsistent persisted targets without adopting the current tree', () => {
    const target = captureMemoryResetTarget(fixture(), EPOCH);
    const invalid = [null, [], {}, { containerIds: target.containerIds }, { ...target, version: 0 },
      { ...target, extra: true }, { ...target, resetEpoch: -1 }, { ...target, resetEpoch: NaN },
      { ...target, workspaceId: '' }, { ...target, fingerprint: 'not-a-hash' },
      { ...target, containerIds: [MEMORY_ID, MEMORY_ID] }, { ...target, containerIds: ['z', 'a'] },
      { ...target, nodeCount: 0 }, { ...target, ordinaryNodeCount: 5 },
      { ...target, nodeCount: Number.MAX_SAFE_INTEGER + 1 }, { ...target, containerIds: [] },
    ];
    for (const value of invalid) expect(() => decodeMemoryResetTarget(value)).toThrow('target is invalid');
  });
});

function fixture(): DocumentProjection {
  return {
    workspaceId: 'workspace', rootId: WORKSPACE_ID, libraryId: 'library', dailyNotesId: DAILY_NOTES_ID,
    schemaId: 'schema', searchesId: 'searches', recentsId: 'recents', trashId: TRASH_ID, todayId: 'day',
    nodes: [
      node(WORKSPACE_ID, undefined, [DAILY_NOTES_ID, 'outside', TRASH_ID]),
      node(DAILY_NOTES_ID, WORKSPACE_ID, ['day']),
      node('day', DAILY_NOTES_ID, [MEMORY_ID], [TAG_DAY_ID], '2026-09-07'),
      node(MEMORY_ID, 'day', ['episode', 'note'], ['tag:mem-day']),
      node('episode', MEMORY_ID, ['belief'], ['tag:mem-episode']),
      node('belief', 'episode', [], ['tag:mem-belief'], 'Secret memory prose'),
      node('note', MEMORY_ID, ['attachment']),
      { ...node('attachment', 'note'), type: 'reference', targetId: 'outside' },
      node('outside', WORKSPACE_ID, ['stray']),
      node('stray', 'outside', [], ['tag:mem-guidance']),
      node(TRASH_ID, WORKSPACE_ID),
    ],
  };
}

function node(id: string, parentId?: string, children: string[] = [], tags: string[] = [], text = id): NodeProjection {
  return {
    id, ...(parentId ? { parentId } : {}), children, tags, content: { text, marks: [], inlineRefs: [] },
    createdAt: 1, updatedAt: 1, locked: false, autoCollected: false,
  };
}
function get(projection: DocumentProjection, id: string): NodeProjection {
  return projection.nodes.find((item) => item.id === id)!;
}
