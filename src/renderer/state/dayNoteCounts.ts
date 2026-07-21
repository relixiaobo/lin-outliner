import { normalizedIsoLocalDate } from '../../core/localDate';
import { TAG_DAY_ID } from '../../core/types';
import type { NodeId, NodeProjection } from '../api/types';

const DAY_NOTE_COUNT_WINDOW_CACHE_LIMIT = 128;
const DAY_NOTE_INDEX_BUCKET_COUNT = 1024;
const DAY_NOTE_INDEX_BUCKET_MASK = DAY_NOTE_INDEX_BUCKET_COUNT - 1;
const BUCKETED_STRING_SET_MIN_SIZE = 64;

const EMPTY_NODE_ID_SET = new Set<NodeId>();

export interface DayNoteCountIndex {
  countsByDate: ReadonlyMap<string, number>;
  dateNodeIdsByDate: ReadonlyMap<string, readonly NodeId[]>;
  dateRevisionByDate: ReadonlyMap<string, number>;
  dayTagIds: ReadonlySet<NodeId>;
  nodeDateById: ReadonlyMap<NodeId, string>;
  nodeOrderById: ReadonlyMap<NodeId, number>;
  nextOrder: number;
  revision: number;
  tagMembersByTagId: ReadonlyMap<NodeId, ReadonlySet<NodeId>>;
  winningNodeIdByDate: ReadonlyMap<string, NodeId>;
}

export interface DateNoteCountWindow {
  counts: ReadonlyMap<string, number>;
  key: string;
  revisionSignature: string;
}

const dateWindowCache = new Map<string, DateNoteCountWindow>();

class BucketedStringMap<TKey extends string, TValue> implements ReadonlyMap<TKey, TValue> {
  private constructor(
    private readonly buckets: ReadonlyMap<number, ReadonlyMap<TKey, TValue>>,
    private readonly entryCount: number,
  ) {}

  static fromEntries<TKey extends string, TValue>(
    entries: Iterable<readonly [TKey, TValue]>,
  ): BucketedStringMap<TKey, TValue> {
    const buckets = new Map<number, Map<TKey, TValue>>();
    let entryCount = 0;
    for (const [key, value] of entries) {
      const index = bucketIndex(key);
      let bucket = buckets.get(index);
      if (!bucket) {
        bucket = new Map<TKey, TValue>();
        buckets.set(index, bucket);
      }
      if (!bucket.has(key)) entryCount += 1;
      bucket.set(key, value);
    }
    return new BucketedStringMap(buckets, entryCount);
  }

  static fromReadonlyMap<TKey extends string, TValue>(
    map: ReadonlyMap<TKey, TValue>,
  ): BucketedStringMap<TKey, TValue> {
    return map instanceof BucketedStringMap ? map : BucketedStringMap.fromEntries(map.entries());
  }

  get [Symbol.toStringTag](): string {
    return 'Map';
  }

  get size(): number {
    return this.entryCount;
  }

  get(key: TKey): TValue | undefined {
    return this.buckets.get(bucketIndex(key))?.get(key);
  }

  has(key: TKey): boolean {
    return this.buckets.get(bucketIndex(key))?.has(key) ?? false;
  }

  patch(
    upserts: readonly (readonly [TKey, TValue])[],
    removedKeys: readonly TKey[],
  ): BucketedStringMap<TKey, TValue> {
    if (upserts.length === 0 && removedKeys.length === 0) return this;

    const copiedBuckets = new Map<number, Map<TKey, TValue>>();
    const mutableBucket = (key: TKey): Map<TKey, TValue> => {
      const index = bucketIndex(key);
      const existing = copiedBuckets.get(index);
      if (existing) return existing;
      const copy = new Map(this.buckets.get(index));
      copiedBuckets.set(index, copy);
      return copy;
    };

    let entryCount = this.entryCount;
    const removedExisting = new Set<TKey>();
    for (const key of removedKeys) {
      if (!this.has(key)) continue;
      const bucket = mutableBucket(key);
      if (!bucket.delete(key)) continue;
      entryCount -= 1;
      removedExisting.add(key);
    }

    for (const [key, value] of upserts) {
      if (!removedExisting.has(key) && this.has(key) && Object.is(this.get(key), value)) continue;
      const bucket = mutableBucket(key);
      if (!bucket.has(key)) entryCount += 1;
      bucket.set(key, value);
    }

    if (copiedBuckets.size === 0) return this;

    const buckets = new Map(this.buckets);
    for (const [index, bucket] of copiedBuckets) {
      if (bucket.size === 0) buckets.delete(index);
      else buckets.set(index, bucket);
    }
    return new BucketedStringMap(buckets, entryCount);
  }

  entries(): MapIterator<[TKey, TValue]> {
    return mapIterator((function* entries(self: BucketedStringMap<TKey, TValue>) {
      for (const bucket of self.buckets.values()) {
        yield* bucket.entries();
      }
    }(this)));
  }

  keys(): MapIterator<TKey> {
    return mapIterator((function* keys(self: BucketedStringMap<TKey, TValue>) {
      for (const bucket of self.buckets.values()) {
        yield* bucket.keys();
      }
    }(this)));
  }

  values(): MapIterator<TValue> {
    return mapIterator((function* values(self: BucketedStringMap<TKey, TValue>) {
      for (const bucket of self.buckets.values()) {
        yield* bucket.values();
      }
    }(this)));
  }

  forEach(
    callbackfn: (value: TValue, key: TKey, map: ReadonlyMap<TKey, TValue>) => void,
    thisArg?: unknown,
  ): void {
    for (const [key, value] of this) callbackfn.call(thisArg, value, key, this);
  }

  [Symbol.iterator](): MapIterator<[TKey, TValue]> {
    return this.entries();
  }
}

class BucketedStringSet<TKey extends string> implements ReadonlySet<TKey> {
  private constructor(private readonly members: BucketedStringMap<TKey, true>) {}

  static fromEntries<TKey extends string>(values: Iterable<TKey>): BucketedStringSet<TKey> {
    return new BucketedStringSet(
      BucketedStringMap.fromEntries((function* entries() {
        for (const value of values) yield [value, true] as const;
      }())),
    );
  }

  static fromReadonlySet<TKey extends string>(set: ReadonlySet<TKey>): BucketedStringSet<TKey> {
    return set instanceof BucketedStringSet ? set : BucketedStringSet.fromEntries(set.values());
  }

  get [Symbol.toStringTag](): string {
    return 'Set';
  }

  get size(): number {
    return this.members.size;
  }

  has(value: TKey): boolean {
    return this.members.has(value);
  }

  patch(addedValues: readonly TKey[], removedValues: readonly TKey[]): BucketedStringSet<TKey> {
    const members = this.members.patch(
      addedValues.map((value) => [value, true] as const),
      removedValues,
    );
    return members === this.members ? this : new BucketedStringSet(members);
  }

  entries(): SetIterator<[TKey, TKey]> {
    return setIterator((function* entries(self: BucketedStringSet<TKey>) {
      for (const value of self.values()) yield [value, value] as [TKey, TKey];
    }(this)));
  }

  keys(): SetIterator<TKey> {
    return this.values();
  }

  values(): SetIterator<TKey> {
    return setIterator(this.members.keys());
  }

  forEach(
    callbackfn: (value: TKey, value2: TKey, set: ReadonlySet<TKey>) => void,
    thisArg?: unknown,
  ): void {
    for (const value of this) callbackfn.call(thisArg, value, value, this);
  }

  [Symbol.iterator](): SetIterator<TKey> {
    return this.values();
  }
}

interface MapPatchDraft<TKey extends string, TValue> {
  base: ReadonlyMap<TKey, TValue>;
  removals: Set<TKey>;
  upserts: Map<TKey, TValue>;
}

interface SetPatchDraft<TKey extends string> {
  additions: Set<TKey>;
  base: ReadonlySet<TKey>;
  removals: Set<TKey>;
}

export function parseDayNodeIsoDate(label: string): string | null {
  return normalizedIsoLocalDate(label);
}

export function buildDayNoteCountIndex(byId: ReadonlyMap<NodeId, NodeProjection>): DayNoteCountIndex {
  const dayTagIds = new Set<NodeId>([TAG_DAY_ID]);
  const tagMembersByTagId = new Map<NodeId, Set<NodeId>>();
  const nodeOrderById = new Map<NodeId, number>();

  let order = 0;
  for (const node of byId.values()) {
    nodeOrderById.set(node.id, order);
    order += 1;
    if (isFallbackDayTagNode(node)) dayTagIds.add(node.id);
    for (const tagId of node.tags) {
      let members = tagMembersByTagId.get(tagId);
      if (!members) {
        members = new Set<NodeId>();
        tagMembersByTagId.set(tagId, members);
      }
      members.add(node.id);
    }
  }

  const nodeDateById = new Map<NodeId, string>();
  const dateNodeIdsByDate = new Map<string, NodeId[]>();
  for (const node of byId.values()) {
    const isoDate = dayNoteIsoDateForTags(node, dayTagIds);
    if (!isoDate) continue;
    nodeDateById.set(node.id, isoDate);
    const dateNodeIds = dateNodeIdsByDate.get(isoDate) ?? [];
    dateNodeIds.push(node.id);
    dateNodeIdsByDate.set(isoDate, dateNodeIds);
  }

  const countsByDate = new Map<string, number>();
  const dateRevisionByDate = new Map<string, number>();
  const winningNodeIdByDate = new Map<string, NodeId>();
  for (const [isoDate, nodeIds] of dateNodeIdsByDate) {
    const winnerId = nodeIds.at(-1);
    const winner = winnerId ? byId.get(winnerId) : undefined;
    if (!winnerId || !winner) continue;
    countsByDate.set(isoDate, winner.children.length);
    dateRevisionByDate.set(isoDate, 1);
    winningNodeIdByDate.set(isoDate, winnerId);
  }

  return {
    countsByDate: BucketedStringMap.fromEntries(countsByDate.entries()),
    dateNodeIdsByDate: BucketedStringMap.fromEntries(dateNodeIdsByDate.entries()),
    dateRevisionByDate: BucketedStringMap.fromEntries(dateRevisionByDate.entries()),
    dayTagIds: persistentStringSetFromEntries(dayTagIds),
    nodeDateById: BucketedStringMap.fromEntries(nodeDateById.entries()),
    nodeOrderById: BucketedStringMap.fromEntries(nodeOrderById.entries()),
    nextOrder: order,
    revision: 1,
    tagMembersByTagId: BucketedStringMap.fromEntries((function* tagMembers() {
      for (const [tagId, members] of tagMembersByTagId) {
        yield [tagId, persistentStringSetFromEntries(members)] as const;
      }
    }())),
    winningNodeIdByDate: BucketedStringMap.fromEntries(winningNodeIdByDate.entries()),
  };
}

export function patchDayNoteCountIndex({
  changedNodes,
  nextById,
  previous,
  previousById,
  removedIds,
}: {
  changedNodes: readonly NodeProjection[];
  nextById: ReadonlyMap<NodeId, NodeProjection>;
  previous: DayNoteCountIndex;
  previousById: ReadonlyMap<NodeId, NodeProjection>;
  removedIds: readonly NodeId[];
}): DayNoteCountIndex {
  if (changedNodes.length === 0 && removedIds.length === 0) return previous;

  const changedNodeIds = new Set<NodeId>(changedNodes.map((node) => node.id));
  const removedNodeIds = new Set<NodeId>(removedIds);
  const draft = createPatchDraft(previous);
  const affectedNodeIds = new Set<NodeId>([...changedNodeIds, ...removedNodeIds]);
  const affectedDates = new Set<string>();
  let visibleChanged = false;

  for (const id of removedIds) {
    deleteNodeOrder(draft, id);
  }
  for (const node of changedNodes) {
    if (!previous.nodeOrderById.has(node.id) || removedNodeIds.has(node.id)) {
      setNodeOrder(draft, node.id, draft.nextOrder);
      draft.nextOrder += 1;
    }
  }

  for (const id of new Set<NodeId>([...changedNodeIds, ...removedNodeIds])) {
    const previousNode = previousById.get(id);
    const nextNode = nextById.get(id);
    const previousIsDayTag = previous.dayTagIds.has(id);
    const nextIsDayTag = isDayTagIdFromNode(id, nextNode);

    if (previousIsDayTag !== nextIsDayTag) {
      if (nextIsDayTag) addDayTagId(draft, id);
      else deleteDayTagId(draft, id);
      visibleChanged = true;

      for (const memberId of previous.tagMembersByTagId.get(id) ?? []) affectedNodeIds.add(memberId);
    }

    patchTagMembership(draft, id, previousNode?.tags ?? [], nextNode?.tags ?? []);

    if (previousIsDayTag !== nextIsDayTag) {
      for (const memberId of getTagMembers(draft, id)) affectedNodeIds.add(memberId);
    }
  }

  for (const nodeId of affectedNodeIds) {
    const oldDate = getNodeDate(draft, nodeId);
    const nextNode = nextById.get(nodeId);
    const newDate = nextNode ? dayNoteIsoDateForDraft(nextNode, draft) : null;
    const reinserted = removedNodeIds.has(nodeId) && Boolean(nextNode);

    if (oldDate && oldDate === newDate && !reinserted) {
      affectedDates.add(oldDate);
      continue;
    }

    if (oldDate) {
      removeDateNode(draft, oldDate, nodeId);
      deleteNodeDate(draft, nodeId);
      affectedDates.add(oldDate);
    }

    if (newDate) {
      addDateNode(draft, newDate, nodeId);
      setNodeDate(draft, nodeId, newDate);
      affectedDates.add(newDate);
    }
  }

  for (const isoDate of affectedDates) {
    if (recomputeDateCount(draft, nextById, isoDate)) visibleChanged = true;
  }

  if (!draft.changed && !visibleChanged) return previous;
  return materializePatchDraft(draft, visibleChanged);
}

export function isDayNodeProjection(node: NodeProjection | undefined, index: DayNoteCountIndex): boolean {
  return Boolean(dayNoteIsoDateForNode(node, index));
}

export function dayNoteIsoDateForNode(node: NodeProjection | undefined, index: DayNoteCountIndex): string | null {
  return node ? dayNoteIsoDateForTags(node, index.dayTagIds) : null;
}

export function readDateNoteCountWindow(
  index: DayNoteCountIndex,
  isoDates: readonly string[],
): DateNoteCountWindow {
  const key = isoDates.join('|');
  const revisionSignature = isoDates.map((isoDate) => [
    isoDate,
    index.dateRevisionByDate.get(isoDate) ?? 0,
    index.countsByDate.get(isoDate) ?? 0,
  ].join(':')).join('|');
  const cacheKey = `${key}\n${revisionSignature}`;
  const cached = dateWindowCache.get(cacheKey);
  if (cached) return cached;

  const counts = new Map<string, number>();
  for (const isoDate of isoDates) {
    const count = index.countsByDate.get(isoDate) ?? 0;
    if (count > 0) counts.set(isoDate, count);
  }
  const window = { counts, key, revisionSignature };
  dateWindowCache.set(cacheKey, window);
  if (dateWindowCache.size > DAY_NOTE_COUNT_WINDOW_CACHE_LIMIT) {
    const firstKey = dateWindowCache.keys().next().value;
    if (firstKey !== undefined) dateWindowCache.delete(firstKey);
  }
  return window;
}

interface DayNoteCountPatchDraft {
  changed: boolean;
  countsByDate: MapPatchDraft<string, number>;
  dateNodeIdsByDate: MapPatchDraft<string, readonly NodeId[]>;
  dateRevisionByDate: MapPatchDraft<string, number>;
  dayTagIds: SetPatchDraft<NodeId>;
  nextOrder: number;
  nodeDateById: MapPatchDraft<NodeId, string>;
  nodeOrderById: MapPatchDraft<NodeId, number>;
  previous: DayNoteCountIndex;
  tagMembersByTagId: MapPatchDraft<NodeId, ReadonlySet<NodeId>>;
  winningNodeIdByDate: MapPatchDraft<string, NodeId>;
}

function createPatchDraft(previous: DayNoteCountIndex): DayNoteCountPatchDraft {
  return {
    changed: false,
    countsByDate: createMapPatchDraft(previous.countsByDate),
    dateNodeIdsByDate: createMapPatchDraft(previous.dateNodeIdsByDate),
    dateRevisionByDate: createMapPatchDraft(previous.dateRevisionByDate),
    dayTagIds: createSetPatchDraft(previous.dayTagIds),
    nextOrder: previous.nextOrder,
    nodeDateById: createMapPatchDraft(previous.nodeDateById),
    nodeOrderById: createMapPatchDraft(previous.nodeOrderById),
    previous,
    tagMembersByTagId: createMapPatchDraft(previous.tagMembersByTagId),
    winningNodeIdByDate: createMapPatchDraft(previous.winningNodeIdByDate),
  };
}

function materializePatchDraft(draft: DayNoteCountPatchDraft, visibleChanged: boolean): DayNoteCountIndex {
  return {
    countsByDate: materializeMapPatchDraft(draft.countsByDate),
    dateNodeIdsByDate: materializeMapPatchDraft(draft.dateNodeIdsByDate),
    dateRevisionByDate: materializeMapPatchDraft(draft.dateRevisionByDate),
    dayTagIds: materializeSetPatchDraft(draft.dayTagIds),
    nodeDateById: materializeMapPatchDraft(draft.nodeDateById),
    nodeOrderById: materializeMapPatchDraft(draft.nodeOrderById),
    nextOrder: draft.nextOrder,
    revision: visibleChanged ? draft.previous.revision + 1 : draft.previous.revision,
    tagMembersByTagId: materializeMapPatchDraft(draft.tagMembersByTagId),
    winningNodeIdByDate: materializeMapPatchDraft(draft.winningNodeIdByDate),
  };
}

function dayNoteIsoDateForTags(node: NodeProjection, dayTagIds: ReadonlySet<NodeId>): string | null {
  if (!node.tags.some((tagId) => dayTagIds.has(tagId))) return null;
  return parseDayNodeIsoDate(node.content.text);
}

function isDayTagIdFromNode(id: NodeId, node: NodeProjection | undefined): boolean {
  return id === TAG_DAY_ID || isFallbackDayTagNode(node);
}

function isFallbackDayTagNode(node: NodeProjection | undefined): boolean {
  return node?.type === 'tagDef' && node.content.text.trim().toLowerCase() === 'day';
}

function dayNoteIsoDateForDraft(node: NodeProjection, draft: DayNoteCountPatchDraft): string | null {
  if (!node.tags.some((tagId) => hasSetPatchValue(draft.dayTagIds, tagId))) return null;
  return parseDayNodeIsoDate(node.content.text);
}

function addDayTagId(draft: DayNoteCountPatchDraft, tagId: NodeId): void {
  if (!addSetPatchValue(draft.dayTagIds, tagId)) return;
  draft.changed = true;
}

function deleteDayTagId(draft: DayNoteCountPatchDraft, tagId: NodeId): void {
  if (!deleteSetPatchValue(draft.dayTagIds, tagId)) return;
  draft.changed = true;
}

function getNodeOrder(draft: DayNoteCountPatchDraft, nodeId: NodeId): number | undefined {
  return getMapPatchValue(draft.nodeOrderById, nodeId);
}

function setNodeOrder(draft: DayNoteCountPatchDraft, nodeId: NodeId, order: number): void {
  if (!setMapPatchValue(draft.nodeOrderById, nodeId, order)) return;
  draft.changed = true;
}

function deleteNodeOrder(draft: DayNoteCountPatchDraft, nodeId: NodeId): void {
  if (!deleteMapPatchValue(draft.nodeOrderById, nodeId)) return;
  draft.changed = true;
}

function getTagMembers(draft: DayNoteCountPatchDraft, tagId: NodeId): ReadonlySet<NodeId> {
  return getMapPatchValue(draft.tagMembersByTagId, tagId) ?? EMPTY_NODE_ID_SET;
}

function setTagMembers(draft: DayNoteCountPatchDraft, tagId: NodeId, members: ReadonlySet<NodeId>): void {
  const changed = members.size === 0
    ? deleteMapPatchValue(draft.tagMembersByTagId, tagId)
    : setMapPatchValue(draft.tagMembersByTagId, tagId, members);
  if (changed) draft.changed = true;
}

function patchMemberSet(
  members: ReadonlySet<NodeId>,
  additions: readonly NodeId[],
  removals: readonly NodeId[],
): ReadonlySet<NodeId> {
  return patchPersistentStringSet(members, additions, removals);
}

function patchTagMembership(
  draft: DayNoteCountPatchDraft,
  nodeId: NodeId,
  previousTags: readonly NodeId[],
  nextTags: readonly NodeId[],
): void {
  if (sameStringSet(previousTags, nextTags)) return;
  const nextTagSet = new Set(nextTags);
  const previousTagSet = new Set(previousTags);
  for (const tagId of previousTags) {
    if (nextTagSet.has(tagId)) continue;
    const members = getTagMembers(draft, tagId);
    if (!members.has(nodeId)) continue;
    setTagMembers(draft, tagId, patchMemberSet(members, [], [nodeId]));
  }
  for (const tagId of nextTags) {
    if (previousTagSet.has(tagId)) continue;
    const members = getTagMembers(draft, tagId);
    if (members.has(nodeId)) continue;
    setTagMembers(draft, tagId, patchMemberSet(members, [nodeId], []));
  }
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((value) => rightSet.has(value));
}

function getNodeDate(draft: DayNoteCountPatchDraft, nodeId: NodeId): string | null {
  return getMapPatchValue(draft.nodeDateById, nodeId) ?? null;
}

function setNodeDate(draft: DayNoteCountPatchDraft, nodeId: NodeId, isoDate: string): void {
  if (!setMapPatchValue(draft.nodeDateById, nodeId, isoDate)) return;
  draft.changed = true;
}

function deleteNodeDate(draft: DayNoteCountPatchDraft, nodeId: NodeId): void {
  if (!deleteMapPatchValue(draft.nodeDateById, nodeId)) return;
  draft.changed = true;
}

function getDateNodeIds(draft: DayNoteCountPatchDraft, isoDate: string): readonly NodeId[] {
  return getMapPatchValue(draft.dateNodeIdsByDate, isoDate) ?? [];
}

function setDateNodeIds(draft: DayNoteCountPatchDraft, isoDate: string, nodeIds: readonly NodeId[]): void {
  const changed = nodeIds.length === 0
    ? deleteMapPatchValue(draft.dateNodeIdsByDate, isoDate)
    : setMapPatchValue(draft.dateNodeIdsByDate, isoDate, [...nodeIds]);
  if (changed) draft.changed = true;
}

function removeDateNode(draft: DayNoteCountPatchDraft, isoDate: string, nodeId: NodeId): void {
  const nodeIds = getDateNodeIds(draft, isoDate);
  if (!nodeIds.includes(nodeId)) return;
  setDateNodeIds(draft, isoDate, nodeIds.filter((id) => id !== nodeId));
}

function addDateNode(draft: DayNoteCountPatchDraft, isoDate: string, nodeId: NodeId): void {
  const nodeIds = getDateNodeIds(draft, isoDate);
  if (nodeIds.includes(nodeId)) return;
  const nextNodeIds = [...nodeIds, nodeId].sort((left, right) =>
    (getNodeOrder(draft, left) ?? Number.MAX_SAFE_INTEGER)
    - (getNodeOrder(draft, right) ?? Number.MAX_SAFE_INTEGER));
  setDateNodeIds(draft, isoDate, nextNodeIds);
}

function recomputeDateCount(
  draft: DayNoteCountPatchDraft,
  nextById: ReadonlyMap<NodeId, NodeProjection>,
  isoDate: string,
): boolean {
  const nodeIds = getDateNodeIds(draft, isoDate);
  const liveNodeIds = nodeIds.filter((nodeId) =>
    nextById.has(nodeId) && getNodeDate(draft, nodeId) === isoDate);
  if (liveNodeIds.length !== nodeIds.length) {
    setDateNodeIds(draft, isoDate, liveNodeIds);
  }

  const countsByDate = draft.countsByDate;
  const winningNodeIdByDate = draft.winningNodeIdByDate;
  const previousCount = draft.previous.countsByDate.get(isoDate);
  const previousWinner = draft.previous.winningNodeIdByDate.get(isoDate);
  const winner = liveNodeIds.at(-1);
  const nextCount = winner ? nextById.get(winner)?.children.length : undefined;

  if (!winner || nextCount === undefined) {
    if (deleteMapPatchValue(countsByDate, isoDate)) draft.changed = true;
    if (deleteMapPatchValue(winningNodeIdByDate, isoDate)) draft.changed = true;
  } else {
    if (setMapPatchValue(countsByDate, isoDate, nextCount)) draft.changed = true;
    if (setMapPatchValue(winningNodeIdByDate, isoDate, winner)) draft.changed = true;
  }

  const changed = previousCount !== nextCount || previousWinner !== winner;
  if (changed) {
    if (setMapPatchValue(
      draft.dateRevisionByDate,
      isoDate,
      (draft.previous.dateRevisionByDate.get(isoDate) ?? 0) + 1,
    )) {
      draft.changed = true;
    }
  }
  return changed;
}

function createMapPatchDraft<TKey extends string, TValue>(
  base: ReadonlyMap<TKey, TValue>,
): MapPatchDraft<TKey, TValue> {
  return { base, removals: new Set<TKey>(), upserts: new Map<TKey, TValue>() };
}

function getMapPatchValue<TKey extends string, TValue>(
  draft: MapPatchDraft<TKey, TValue>,
  key: TKey,
): TValue | undefined {
  if (draft.upserts.has(key)) return draft.upserts.get(key);
  if (draft.removals.has(key)) return undefined;
  return draft.base.get(key);
}

function hasMapPatchValue<TKey extends string, TValue>(
  draft: MapPatchDraft<TKey, TValue>,
  key: TKey,
): boolean {
  return draft.upserts.has(key) || (!draft.removals.has(key) && draft.base.has(key));
}

function setMapPatchValue<TKey extends string, TValue>(
  draft: MapPatchDraft<TKey, TValue>,
  key: TKey,
  value: TValue,
): boolean {
  if (hasMapPatchValue(draft, key) && Object.is(getMapPatchValue(draft, key), value)) return false;
  draft.upserts.set(key, value);
  draft.removals.delete(key);
  return true;
}

function deleteMapPatchValue<TKey extends string, TValue>(
  draft: MapPatchDraft<TKey, TValue>,
  key: TKey,
): boolean {
  if (!hasMapPatchValue(draft, key)) return false;
  draft.upserts.delete(key);
  if (draft.base.has(key)) draft.removals.add(key);
  else draft.removals.delete(key);
  return true;
}

function materializeMapPatchDraft<TKey extends string, TValue>(
  draft: MapPatchDraft<TKey, TValue>,
): ReadonlyMap<TKey, TValue> {
  if (draft.upserts.size === 0 && draft.removals.size === 0) return draft.base;
  return BucketedStringMap.fromReadonlyMap(draft.base).patch(
    [...draft.upserts.entries()],
    [...draft.removals],
  );
}

function createSetPatchDraft<TKey extends string>(base: ReadonlySet<TKey>): SetPatchDraft<TKey> {
  return { additions: new Set<TKey>(), base, removals: new Set<TKey>() };
}

function hasSetPatchValue<TKey extends string>(draft: SetPatchDraft<TKey>, value: TKey): boolean {
  return draft.additions.has(value) || (!draft.removals.has(value) && draft.base.has(value));
}

function addSetPatchValue<TKey extends string>(draft: SetPatchDraft<TKey>, value: TKey): boolean {
  if (hasSetPatchValue(draft, value)) return false;
  draft.additions.add(value);
  draft.removals.delete(value);
  return true;
}

function deleteSetPatchValue<TKey extends string>(draft: SetPatchDraft<TKey>, value: TKey): boolean {
  if (!hasSetPatchValue(draft, value)) return false;
  draft.additions.delete(value);
  if (draft.base.has(value)) draft.removals.add(value);
  else draft.removals.delete(value);
  return true;
}

function materializeSetPatchDraft<TKey extends string>(draft: SetPatchDraft<TKey>): ReadonlySet<TKey> {
  if (draft.additions.size === 0 && draft.removals.size === 0) return draft.base;
  return patchPersistentStringSet(draft.base, [...draft.additions], [...draft.removals]);
}

function persistentStringSetFromEntries<TKey extends string>(values: Iterable<TKey>): ReadonlySet<TKey> {
  const set = new Set(values);
  return set.size >= BUCKETED_STRING_SET_MIN_SIZE ? BucketedStringSet.fromEntries(set) : set;
}

function patchPersistentStringSet<TKey extends string>(
  set: ReadonlySet<TKey>,
  additions: readonly TKey[],
  removals: readonly TKey[],
): ReadonlySet<TKey> {
  if (set instanceof BucketedStringSet || set.size + additions.length >= BUCKETED_STRING_SET_MIN_SIZE) {
    return BucketedStringSet.fromReadonlySet(set).patch(additions, removals);
  }
  const next = new Set(set);
  for (const value of removals) next.delete(value);
  for (const value of additions) next.add(value);
  return next.size >= BUCKETED_STRING_SET_MIN_SIZE ? BucketedStringSet.fromEntries(next) : next;
}

function bucketIndex(key: string): number {
  let hash = 2166136261;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash & DAY_NOTE_INDEX_BUCKET_MASK;
}

function mapIterator<TValue>(iterator: IterableIterator<TValue>): MapIterator<TValue> {
  return iterator as MapIterator<TValue>;
}

function setIterator<TValue>(iterator: IterableIterator<TValue>): SetIterator<TValue> {
  return iterator as SetIterator<TValue>;
}
