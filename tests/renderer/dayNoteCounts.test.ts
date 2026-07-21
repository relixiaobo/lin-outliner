import { describe, expect, test } from 'bun:test';
import { TAG_DAY_ID, type NodeId, type NodeProjection } from '../../src/core/types';
import {
  buildDayNoteCountIndex,
  dayNoteIsoDateForNode,
  patchDayNoteCountIndex,
  readDateNoteCountWindow,
  type DayNoteCountIndex,
} from '../../src/renderer/state/dayNoteCounts';

function node(id: NodeId, text: string, patch: Partial<NodeProjection> = {}): NodeProjection {
  return {
    id,
    children: [],
    content: { text, marks: [], inlineRefs: [] },
    tags: [],
    createdAt: 1,
    updatedAt: 1,
    locked: false,
    autoCollected: false,
    ...patch,
  } as NodeProjection;
}

function tag(id: NodeId, text: string): NodeProjection {
  return node(id, text, { type: 'tagDef' });
}

function byId(nodes: readonly NodeProjection[]): Map<NodeId, NodeProjection> {
  return new Map(nodes.map((entry) => [entry.id, entry]));
}

function patchIndex(
  previousNodes: readonly NodeProjection[],
  nextNodes: readonly NodeProjection[],
  changedNodes: readonly NodeProjection[],
  removedIds: readonly NodeId[] = [],
) {
  const previousById = byId(previousNodes);
  const previous = buildDayNoteCountIndex(previousById);
  return patchDayNoteCountIndex({
    previous,
    previousById,
    nextById: byId(nextNodes),
    changedNodes,
    removedIds,
  });
}

describe('day note count index', () => {
  test('full build indexes canonical and fallback day tags while ignoring invalid dates', () => {
    const index = buildDayNoteCountIndex(byId([
      tag(TAG_DAY_ID, 'day'),
      tag('tag:custom-day', ' Day '),
      node('canonical', '2026-05-20', { tags: [TAG_DAY_ID], children: ['a', 'b'] }),
      node('fallback', '2026-05-21', { tags: ['tag:custom-day'], children: ['a'] }),
      node('invalid', '2026-02-31', { tags: [TAG_DAY_ID], children: ['a', 'b', 'c'] }),
      node('plain', '2026-05-22', { children: ['a'] }),
    ]));

    expect(index.countsByDate.get('2026-05-20')).toBe(2);
    expect(index.countsByDate.get('2026-05-21')).toBe(1);
    expect(index.countsByDate.has('2026-02-31')).toBe(false);
    expect(index.countsByDate.has('2026-05-22')).toBe(false);
  });

  test('patches title validity, day tags, and direct child counts', () => {
    const day = node('day', '2026-05-20', { tags: [TAG_DAY_ID], children: ['a'] });
    const invalid = node('invalid', 'not a date', { tags: [TAG_DAY_ID] });
    const plain = node('plain', '2026-05-22', { children: ['x', 'y'] });
    const previousNodes = [tag(TAG_DAY_ID, 'day'), day, invalid, plain];

    const renamedInvalid = node('day', 'not a date', { tags: [TAG_DAY_ID], children: ['a'] });
    let next = patchIndex(previousNodes, [tag(TAG_DAY_ID, 'day'), renamedInvalid, invalid, plain], [renamedInvalid]);
    expect(next.countsByDate.has('2026-05-20')).toBe(false);

    const renamedValid = node('invalid', '2026-05-21', { tags: [TAG_DAY_ID], children: ['a', 'b', 'c'] });
    next = patchDayNoteCountIndex({
      previous: next,
      previousById: byId([tag(TAG_DAY_ID, 'day'), renamedInvalid, invalid, plain]),
      nextById: byId([tag(TAG_DAY_ID, 'day'), renamedInvalid, renamedValid, plain]),
      changedNodes: [renamedValid],
      removedIds: [],
    });
    expect(next.countsByDate.get('2026-05-21')).toBe(3);

    const taggedPlain = node('plain', '2026-05-22', { tags: [TAG_DAY_ID], children: ['x', 'y'] });
    next = patchDayNoteCountIndex({
      previous: next,
      previousById: byId([tag(TAG_DAY_ID, 'day'), renamedInvalid, renamedValid, plain]),
      nextById: byId([tag(TAG_DAY_ID, 'day'), renamedInvalid, renamedValid, taggedPlain]),
      changedNodes: [taggedPlain],
      removedIds: [],
    });
    expect(next.countsByDate.get('2026-05-22')).toBe(2);

    const expandedPlain = node('plain', '2026-05-22', { tags: [TAG_DAY_ID], children: ['x', 'y', 'z'] });
    next = patchDayNoteCountIndex({
      previous: next,
      previousById: byId([tag(TAG_DAY_ID, 'day'), renamedInvalid, renamedValid, taggedPlain]),
      nextById: byId([tag(TAG_DAY_ID, 'day'), renamedInvalid, renamedValid, expandedPlain]),
      changedNodes: [expandedPlain],
      removedIds: [],
    });
    expect(next.countsByDate.get('2026-05-22')).toBe(3);
  });

  test('renaming a fallback day tag updates existing members without iterating the document map', () => {
    const topic = tag('tag:topic', 'topic');
    const member = node('member', '2026-06-01', { tags: ['tag:topic'], children: ['a', 'b'] });
    const previousNodes = [topic, member, node('ordinary', 'Ordinary')];
    const previousById = byId(previousNodes);
    const previous = buildDayNoteCountIndex(previousById);
    expect(previous.countsByDate.has('2026-06-01')).toBe(false);

    const dayTag = tag('tag:topic', 'day');
    const nextById = byId([dayTag, member, node('ordinary', 'Ordinary')]);
    const fail = () => {
      throw new Error('delta patch must not scan the whole document map');
    };
    Object.defineProperties(nextById, {
      [Symbol.iterator]: { value: fail },
      entries: { value: fail },
      keys: { value: fail },
      values: { value: fail },
      forEach: { value: fail },
    });

    const next = patchDayNoteCountIndex({
      previous,
      previousById,
      nextById,
      changedNodes: [dayTag],
      removedIds: [],
    });
    expect(next.countsByDate.get('2026-06-01')).toBe(2);

    const notDayTag = tag('tag:topic', 'topic');
    const removed = patchDayNoteCountIndex({
      previous: next,
      previousById: byId([dayTag, member, node('ordinary', 'Ordinary')]),
      nextById: byId([notDayTag, member, node('ordinary', 'Ordinary')]),
      changedNodes: [notDayTag],
      removedIds: [],
    });
    expect(removed.countsByDate.has('2026-06-01')).toBe(false);
  });

  test('preserves duplicate-date last-wins order through removals and additions', () => {
    const first = node('first', '2026-07-01', { tags: [TAG_DAY_ID], children: ['a'] });
    const second = node('second', '2026-07-01', { tags: [TAG_DAY_ID], children: ['a', 'b'] });
    const previousNodes = [tag(TAG_DAY_ID, 'day'), first, second];
    const previous = buildDayNoteCountIndex(byId(previousNodes));
    expect(previous.countsByDate.get('2026-07-01')).toBe(2);
    expect(previous.winningNodeIdByDate.get('2026-07-01')).toBe('second');

    const afterRemoval = patchDayNoteCountIndex({
      previous,
      previousById: byId(previousNodes),
      nextById: byId([tag(TAG_DAY_ID, 'day'), first]),
      changedNodes: [],
      removedIds: ['second'],
    });
    expect(afterRemoval.countsByDate.get('2026-07-01')).toBe(1);
    expect(afterRemoval.winningNodeIdByDate.get('2026-07-01')).toBe('first');

    const third = node('third', '2026-07-01', { tags: [TAG_DAY_ID], children: ['a', 'b', 'c'] });
    const afterAddition = patchDayNoteCountIndex({
      previous: afterRemoval,
      previousById: byId([tag(TAG_DAY_ID, 'day'), first]),
      nextById: byId([tag(TAG_DAY_ID, 'day'), first, third]),
      changedNodes: [third],
      removedIds: [],
    });
    expect(afterAddition.countsByDate.get('2026-07-01')).toBe(3);
    expect(afterAddition.winningNodeIdByDate.get('2026-07-01')).toBe('third');
  });

  test('unrelated edits preserve index identity and visible windows stay stable across off-window changes', () => {
    const january = node('jan', '2026-01-10', { tags: [TAG_DAY_ID], children: ['a'] });
    const february = node('feb', '2026-02-10', { tags: [TAG_DAY_ID], children: ['a'] });
    const ordinary = node('ordinary', 'Ordinary');
    const previousNodes = [tag(TAG_DAY_ID, 'day'), january, february, ordinary];
    const previous = buildDayNoteCountIndex(byId(previousNodes));

    const editedOrdinary = node('ordinary', 'Ordinary edited');
    const noOp = patchDayNoteCountIndex({
      previous,
      previousById: byId(previousNodes),
      nextById: byId([tag(TAG_DAY_ID, 'day'), january, february, editedOrdinary]),
      changedNodes: [editedOrdinary],
      removedIds: [],
    });
    expect(noOp).toBe(previous);

    const januaryWindow = readDateNoteCountWindow(previous, ['2026-01-10', '2026-01-11']);
    const expandedFebruary = node('feb', '2026-02-10', { tags: [TAG_DAY_ID], children: ['a', 'b'] });
    const next = patchDayNoteCountIndex({
      previous,
      previousById: byId(previousNodes),
      nextById: byId([tag(TAG_DAY_ID, 'day'), january, expandedFebruary, ordinary]),
      changedNodes: [expandedFebruary],
      removedIds: [],
    });
    expect(next).not.toBe(previous);
    expect(readDateNoteCountWindow(next, ['2026-01-10', '2026-01-11'])).toBe(januaryWindow);
    expect(readDateNoteCountWindow(next, ['2026-02-10']).counts.get('2026-02-10')).toBe(2);
  });

  test('visible-window reads do not iterate the full date-count map', () => {
    const reads: string[] = [];
    class CountingMap extends Map<string, number> {
      override get(key: string): number | undefined {
        reads.push(key);
        return super.get(key);
      }

      override entries(): MapIterator<[string, number]> {
        throw new Error('window reads must not iterate all date counts');
      }

      override values(): MapIterator<number> {
        throw new Error('window reads must not iterate all date counts');
      }

      override [Symbol.iterator](): MapIterator<[string, number]> {
        throw new Error('window reads must not iterate all date counts');
      }
    }
    const index = {
      countsByDate: new CountingMap([
        ['2026-01-10', 4],
        ['2026-12-31', 9],
      ]),
      dateNodeIdsByDate: new Map(),
      dateRevisionByDate: new Map(),
      dayTagIds: new Set([TAG_DAY_ID]),
      nextOrder: 0,
      nodeDateById: new Map(),
      nodeOrderById: new Map(),
      revision: 1,
      tagMembersByTagId: new Map(),
      winningNodeIdByDate: new Map(),
    };

    const window = readDateNoteCountWindow(index, ['2026-01-10', '2026-01-11']);

    expect(window.counts.get('2026-01-10')).toBe(4);
    expect(reads).toEqual(['2026-01-10', '2026-01-11', '2026-01-10', '2026-01-11']);
  });

  test('day node predicates use the maintained day-tag identity', () => {
    const customDayTag = tag('tag:custom', 'day');
    const day = node('day', '2026-08-01', { tags: ['tag:custom'] });
    const index = buildDayNoteCountIndex(byId([customDayTag, day]));
    expect(dayNoteIsoDateForNode(day, index)).toBe('2026-08-01');
    expect(dayNoteIsoDateForNode(node('plain', '2026-08-01'), index)).toBeNull();
  });

  test('delta patching does not iterate previous index maps on common write paths', () => {
    const noiseTag = tag('tag:noise', 'noise');
    const hotTagMembers = Array.from({ length: 512 }, (_, index) =>
      node(`tagged:${index}`, `Tagged ${index}`, { tags: ['tag:noise'] }));
    const day = node('day', '2026-09-01', { tags: [TAG_DAY_ID], children: ['a'] });
    const ordinary = node('ordinary', 'Ordinary');
    const previousNodes = [tag(TAG_DAY_ID, 'day'), noiseTag, day, ordinary, ...hotTagMembers];
    const previousById = byId(previousNodes);
    const previous = buildDayNoteCountIndex(previousById);

    forbidIndexIteration(previous, ['tag:noise']);

    const added = node('added', 'Added');
    expect(() => patchDayNoteCountIndex({
      previous,
      previousById,
      nextById: byId([...previousNodes, added]),
      changedNodes: [added],
      removedIds: [],
    })).not.toThrow();

    expect(() => patchDayNoteCountIndex({
      previous,
      previousById,
      nextById: byId(previousNodes.filter((entry) => entry.id !== 'ordinary')),
      changedNodes: [],
      removedIds: ['ordinary'],
    })).not.toThrow();

    const expandedDay = node('day', '2026-09-01', { tags: [TAG_DAY_ID], children: ['a', 'b'] });
    const datePatch = patchDayNoteCountIndex({
      previous,
      previousById,
      nextById: byId([tag(TAG_DAY_ID, 'day'), noiseTag, expandedDay, ordinary, ...hotTagMembers]),
      changedNodes: [expandedDay],
      removedIds: [],
    });
    expect(datePatch.countsByDate.get('2026-09-01')).toBe(2);

    const newlyTagged = node('ordinary', 'Ordinary', { tags: ['tag:noise'] });
    const tagPatch = patchDayNoteCountIndex({
      previous,
      previousById,
      nextById: byId([tag(TAG_DAY_ID, 'day'), noiseTag, day, newlyTagged, ...hotTagMembers]),
      changedNodes: [newlyTagged],
      removedIds: [],
    });
    expect(tagPatch.tagMembersByTagId.get('tag:noise')?.has('ordinary')).toBe(true);
  });
});

function forbidIndexIteration(index: DayNoteCountIndex, tagMemberIds: readonly NodeId[] = []) {
  forbidMapIteration(index.countsByDate, 'countsByDate');
  forbidMapIteration(index.dateNodeIdsByDate, 'dateNodeIdsByDate');
  forbidMapIteration(index.dateRevisionByDate, 'dateRevisionByDate');
  forbidSetIteration(index.dayTagIds, 'dayTagIds');
  forbidMapIteration(index.nodeDateById, 'nodeDateById');
  forbidMapIteration(index.nodeOrderById, 'nodeOrderById');
  for (const tagId of tagMemberIds) {
    const members = index.tagMembersByTagId.get(tagId);
    if (members) forbidSetIteration(members, `tagMembers:${tagId}`);
  }
  forbidMapIteration(index.tagMembersByTagId, 'tagMembersByTagId');
  forbidMapIteration(index.winningNodeIdByDate, 'winningNodeIdByDate');
}

function forbidMapIteration<TKey, TValue>(map: ReadonlyMap<TKey, TValue>, label: string) {
  const fail = () => {
    throw new Error(`${label} must not be iterated during delta patching`);
  };
  Object.defineProperties(map, {
    [Symbol.iterator]: { value: fail },
    entries: { value: fail },
    forEach: { value: fail },
    keys: { value: fail },
    values: { value: fail },
  });
}

function forbidSetIteration<TValue>(set: ReadonlySet<TValue>, label: string) {
  const fail = () => {
    throw new Error(`${label} must not be iterated during delta patching`);
  };
  Object.defineProperties(set, {
    [Symbol.iterator]: { value: fail },
    entries: { value: fail },
    forEach: { value: fail },
    keys: { value: fail },
    values: { value: fail },
  });
}
