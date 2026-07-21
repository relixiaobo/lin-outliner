import { normalizedIsoLocalDate } from '../../core/localDate';
import { TAG_DAY_ID } from '../../core/types';
import type { NodeId, NodeProjection } from '../api/types';

const DAY_NOTE_COUNT_WINDOW_CACHE_LIMIT = 128;

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
    countsByDate,
    dateNodeIdsByDate,
    dateRevisionByDate,
    dayTagIds,
    nodeDateById,
    nodeOrderById,
    nextOrder: order,
    revision: 1,
    tagMembersByTagId,
    winningNodeIdByDate,
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
      if (nextIsDayTag) ensureDayTagIds(draft).add(id);
      else ensureDayTagIds(draft).delete(id);
      draft.changed = true;
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
    const newDate = nextNode ? dayNoteIsoDateForTags(nextNode, getDayTagIds(draft)) : null;
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
  countsByDate: Map<string, number> | null;
  dateNodeIdsByDate: Map<string, readonly NodeId[]> | null;
  dateRevisionByDate: Map<string, number> | null;
  dayTagIds: Set<NodeId> | null;
  nextOrder: number;
  nodeDateById: Map<NodeId, string> | null;
  nodeOrderById: Map<NodeId, number> | null;
  previous: DayNoteCountIndex;
  tagMembersByTagId: Map<NodeId, ReadonlySet<NodeId>> | null;
  winningNodeIdByDate: Map<string, NodeId> | null;
}

function createPatchDraft(previous: DayNoteCountIndex): DayNoteCountPatchDraft {
  return {
    changed: false,
    countsByDate: null,
    dateNodeIdsByDate: null,
    dateRevisionByDate: null,
    dayTagIds: null,
    nextOrder: previous.nextOrder,
    nodeDateById: null,
    nodeOrderById: null,
    previous,
    tagMembersByTagId: null,
    winningNodeIdByDate: null,
  };
}

function materializePatchDraft(draft: DayNoteCountPatchDraft, visibleChanged: boolean): DayNoteCountIndex {
  return {
    countsByDate: draft.countsByDate ?? draft.previous.countsByDate,
    dateNodeIdsByDate: draft.dateNodeIdsByDate ?? draft.previous.dateNodeIdsByDate,
    dateRevisionByDate: draft.dateRevisionByDate ?? draft.previous.dateRevisionByDate,
    dayTagIds: draft.dayTagIds ?? draft.previous.dayTagIds,
    nodeDateById: draft.nodeDateById ?? draft.previous.nodeDateById,
    nodeOrderById: draft.nodeOrderById ?? draft.previous.nodeOrderById,
    nextOrder: draft.nextOrder,
    revision: visibleChanged ? draft.previous.revision + 1 : draft.previous.revision,
    tagMembersByTagId: draft.tagMembersByTagId ?? draft.previous.tagMembersByTagId,
    winningNodeIdByDate: draft.winningNodeIdByDate ?? draft.previous.winningNodeIdByDate,
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

function getDayTagIds(draft: DayNoteCountPatchDraft): ReadonlySet<NodeId> {
  return draft.dayTagIds ?? draft.previous.dayTagIds;
}

function ensureDayTagIds(draft: DayNoteCountPatchDraft): Set<NodeId> {
  draft.dayTagIds ??= new Set(draft.previous.dayTagIds);
  return draft.dayTagIds;
}

function getNodeOrder(draft: DayNoteCountPatchDraft, nodeId: NodeId): number | undefined {
  return (draft.nodeOrderById ?? draft.previous.nodeOrderById).get(nodeId);
}

function setNodeOrder(draft: DayNoteCountPatchDraft, nodeId: NodeId, order: number): void {
  draft.nodeOrderById ??= new Map(draft.previous.nodeOrderById);
  draft.nodeOrderById.set(nodeId, order);
  draft.changed = true;
}

function deleteNodeOrder(draft: DayNoteCountPatchDraft, nodeId: NodeId): void {
  if (!draft.previous.nodeOrderById.has(nodeId)) return;
  draft.nodeOrderById ??= new Map(draft.previous.nodeOrderById);
  draft.nodeOrderById.delete(nodeId);
  draft.changed = true;
}

function getTagMembers(draft: DayNoteCountPatchDraft, tagId: NodeId): ReadonlySet<NodeId> {
  return (draft.tagMembersByTagId ?? draft.previous.tagMembersByTagId).get(tagId) ?? new Set<NodeId>();
}

function setTagMembers(draft: DayNoteCountPatchDraft, tagId: NodeId, members: ReadonlySet<NodeId>): void {
  draft.tagMembersByTagId ??= new Map(draft.previous.tagMembersByTagId);
  if (members.size === 0) draft.tagMembersByTagId.delete(tagId);
  else draft.tagMembersByTagId.set(tagId, members);
  draft.changed = true;
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
    const nextMembers = new Set(members);
    nextMembers.delete(nodeId);
    setTagMembers(draft, tagId, nextMembers);
  }
  for (const tagId of nextTags) {
    if (previousTagSet.has(tagId)) continue;
    const members = getTagMembers(draft, tagId);
    if (members.has(nodeId)) continue;
    const nextMembers = new Set(members);
    nextMembers.add(nodeId);
    setTagMembers(draft, tagId, nextMembers);
  }
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((value) => rightSet.has(value));
}

function getNodeDate(draft: DayNoteCountPatchDraft, nodeId: NodeId): string | null {
  return (draft.nodeDateById ?? draft.previous.nodeDateById).get(nodeId) ?? null;
}

function setNodeDate(draft: DayNoteCountPatchDraft, nodeId: NodeId, isoDate: string): void {
  if (getNodeDate(draft, nodeId) === isoDate) return;
  draft.nodeDateById ??= new Map(draft.previous.nodeDateById);
  draft.nodeDateById.set(nodeId, isoDate);
  draft.changed = true;
}

function deleteNodeDate(draft: DayNoteCountPatchDraft, nodeId: NodeId): void {
  if (!getNodeDate(draft, nodeId)) return;
  draft.nodeDateById ??= new Map(draft.previous.nodeDateById);
  draft.nodeDateById.delete(nodeId);
  draft.changed = true;
}

function getDateNodeIds(draft: DayNoteCountPatchDraft, isoDate: string): readonly NodeId[] {
  return (draft.dateNodeIdsByDate ?? draft.previous.dateNodeIdsByDate).get(isoDate) ?? [];
}

function setDateNodeIds(draft: DayNoteCountPatchDraft, isoDate: string, nodeIds: readonly NodeId[]): void {
  draft.dateNodeIdsByDate ??= new Map(draft.previous.dateNodeIdsByDate);
  if (nodeIds.length === 0) draft.dateNodeIdsByDate.delete(isoDate);
  else draft.dateNodeIdsByDate.set(isoDate, [...nodeIds]);
  draft.changed = true;
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

  const countsByDate = draft.countsByDate ?? draft.previous.countsByDate;
  const winningNodeIdByDate = draft.winningNodeIdByDate ?? draft.previous.winningNodeIdByDate;
  const previousCount = draft.previous.countsByDate.get(isoDate);
  const previousWinner = draft.previous.winningNodeIdByDate.get(isoDate);
  const winner = liveNodeIds.at(-1);
  const nextCount = winner ? nextById.get(winner)?.children.length : undefined;

  if (!winner || nextCount === undefined) {
    if (countsByDate.has(isoDate)) {
      draft.countsByDate ??= new Map(draft.previous.countsByDate);
      draft.countsByDate.delete(isoDate);
      draft.changed = true;
    }
    if (winningNodeIdByDate.has(isoDate)) {
      draft.winningNodeIdByDate ??= new Map(draft.previous.winningNodeIdByDate);
      draft.winningNodeIdByDate.delete(isoDate);
      draft.changed = true;
    }
  } else {
    if (countsByDate.get(isoDate) !== nextCount) {
      draft.countsByDate ??= new Map(draft.previous.countsByDate);
      draft.countsByDate.set(isoDate, nextCount);
      draft.changed = true;
    }
    if (winningNodeIdByDate.get(isoDate) !== winner) {
      draft.winningNodeIdByDate ??= new Map(draft.previous.winningNodeIdByDate);
      draft.winningNodeIdByDate.set(isoDate, winner);
      draft.changed = true;
    }
  }

  const changed = previousCount !== nextCount || previousWinner !== winner;
  if (changed) {
    draft.dateRevisionByDate ??= new Map(draft.previous.dateRevisionByDate);
    draft.dateRevisionByDate.set(isoDate, (draft.previous.dateRevisionByDate.get(isoDate) ?? 0) + 1);
    draft.changed = true;
  }
  return changed;
}
