import {
  normalizeSearchText,
  rankTextSearchLabel,
  textSearchLabelWordStarts,
} from '../../core/textSearchAnalyzer';
import type { NodeId, NodeProjection } from '../api/types';
import { SparseProjectionMap } from './sparseProjectionMap';

const POSTING_TOP_LIMIT = 48;
const POSTING_OVERLAY_LIMIT = 23;

export type ReferenceCandidateKind = 'content' | 'file';

export interface ReferenceCandidateIndexEntry {
  readonly id: NodeId;
  readonly kind: ReferenceCandidateKind;
  readonly label: string;
  readonly normalizedLabel: string;
  readonly updatedAt: number;
  readonly untitled: boolean;
}

interface PostingScore extends ReferenceCandidateIndexEntry {}

interface PostingEntry {
  readonly key: string;
  readonly score: PostingScore;
}

interface PostingNode {
  readonly entry: PostingEntry;
  readonly height: number;
  readonly left: PostingNode | null;
  readonly maxKey: string;
  readonly minKey: string;
  readonly right: PostingNode | null;
  readonly top: readonly PostingScore[];
}

interface CandidatePostingKeys {
  readonly labels: readonly string[];
  readonly suffixes: readonly string[];
  readonly untitled: readonly string[];
  readonly words: readonly string[];
}

interface CandidateRecord {
  readonly entry: ReferenceCandidateIndexEntry;
}

interface CandidatePostingForest {
  readonly labels: PostingNode | null;
  readonly suffixes: PostingNode | null;
  readonly untitled: PostingNode | null;
  readonly words: PostingNode | null;
}

export interface ReferenceCandidateIndex {
  readonly baseRecords: ReadonlyMap<NodeId, CandidateRecord>;
  readonly content: CandidatePostingForest;
  readonly files: CandidatePostingForest;
  readonly pending: ReadonlyMap<NodeId, CandidateRecord | null>;
  readonly records: ReadonlyMap<NodeId, CandidateRecord>;
}

export interface ReferenceCandidateQueryStats {
  candidateEntriesVisited: number;
  postingRangesRead: number;
}

export function buildReferenceCandidateIndex(
  byId: ReadonlyMap<NodeId, NodeProjection>,
  trashNodeIds: ReadonlySet<NodeId>,
): ReferenceCandidateIndex {
  const records: Array<readonly [NodeId, CandidateRecord]> = [];
  const entries = emptyPostingEntries();
  for (const node of byId.values()) {
    if (trashNodeIds.has(node.id)) continue;
    const record = candidateRecord(node);
    if (!record) continue;
    records.push([node.id, record]);
    appendRecordEntries(entries[record.entry.kind], record);
  }
  const recordsById = SparseProjectionMap.fromEntries(records);
  return {
    baseRecords: recordsById,
    content: buildForest(entries.content),
    files: buildForest(entries.file),
    pending: SparseProjectionMap.fromEntries<CandidateRecord | null>([]),
    records: recordsById,
  };
}

export function patchReferenceCandidateIndex(params: {
  readonly previous: ReferenceCandidateIndex;
  readonly nextById: ReadonlyMap<NodeId, NodeProjection>;
  readonly changedIds: ReadonlySet<NodeId>;
  readonly trashMembershipChangedIds: ReadonlySet<NodeId>;
  readonly trashNodeIds: ReadonlySet<NodeId>;
}): ReferenceCandidateIndex {
  const patchIds = new Set([...params.changedIds, ...params.trashMembershipChangedIds]);
  if (patchIds.size === 0) return params.previous;

  const recordUpserts: Array<readonly [NodeId, CandidateRecord]> = [];
  const recordRemovals: NodeId[] = [];
  const pendingUpserts: Array<readonly [NodeId, CandidateRecord | null]> = [];
  const pendingRemovals: NodeId[] = [];
  for (const nodeId of patchIds) {
    const previousRecord = params.previous.records.get(nodeId);
    const node = params.nextById.get(nodeId);
    const nextRecord = !node || params.trashNodeIds.has(nodeId) ? null : candidateRecord(node);
    if (sameCandidateRecord(previousRecord, nextRecord)) continue;

    if (nextRecord) recordUpserts.push([nodeId, nextRecord]);
    else if (previousRecord) recordRemovals.push(nodeId);

    const baseRecord = params.previous.baseRecords.get(nodeId);
    if (sameCandidateRecord(baseRecord, nextRecord)) pendingRemovals.push(nodeId);
    else pendingUpserts.push([nodeId, nextRecord]);
  }

  if (
    recordUpserts.length === 0
    && recordRemovals.length === 0
    && pendingUpserts.length === 0
    && pendingRemovals.length === 0
  ) return params.previous;

  const records = SparseProjectionMap.fromReadonlyMap(params.previous.records)
    .patch(recordUpserts, recordRemovals);
  const pending = SparseProjectionMap.fromReadonlyMap(params.previous.pending)
    .patch(pendingUpserts, pendingRemovals);
  if (pending.size > POSTING_OVERLAY_LIMIT) {
    return buildReferenceCandidateIndex(params.nextById, params.trashNodeIds);
  }

  return {
    ...params.previous,
    pending,
    records,
  };
}

export function queryReferenceCandidateIndex(params: {
  readonly index: ReferenceCandidateIndex;
  readonly query: string;
  readonly untitledLabel: string;
  readonly includeFileNodes: boolean;
  readonly limit: number;
  readonly stats?: ReferenceCandidateQueryStats;
}): readonly ReferenceCandidateIndexEntry[] {
  const normalizedQuery = normalizeSearchText(params.query);
  const forests = params.includeFileNodes
    ? [params.index.content, params.index.files]
    : [params.index.content];
  const overlayScores = [...params.index.pending.values()]
    .flatMap((record) => {
      if (!record || (!params.includeFileNodes && record.entry.kind === 'file')) return [];
      const label = record.entry.untitled ? params.untitledLabel : record.entry.label;
      const match = rankTextSearchLabel(label, normalizedQuery);
      return match ? [{ rank: match.rank, score: record.entry }] : [];
    });
  const currentBaseScores = (scores: readonly PostingScore[]) => (
    scores.filter((score) => !params.index.pending.has(score.id))
  );
  const scoresForRank = (rank: number, baseScores: readonly PostingScore[]) => mergeTop([
    currentBaseScores(baseScores),
    overlayScores
      .filter((candidate) => candidate.rank === rank)
      .map((candidate) => candidate.score)
      .sort(comparePostingScore),
  ]);
  const selected: ReferenceCandidateIndexEntry[] = [];
  const selectedIds = new Set<NodeId>();
  const visit = (score: PostingScore, expectedRank: number) => {
    if (selectedIds.has(score.id) || selected.length >= params.limit) return;
    params.stats && (params.stats.candidateEntriesVisited += 1);
    const label = score.untitled ? params.untitledLabel : score.label;
    const match = rankTextSearchLabel(label, normalizedQuery);
    if (!match || match.rank !== expectedRank) return;
    selectedIds.add(score.id);
    selected.push(score.untitled ? { ...score, label, normalizedLabel: normalizeSearchText(label) } : score);
  };

  if (!normalizedQuery) {
    const scores = scoresForRank(0, mergeTop(
      forests.flatMap((forest) => [forest.labels?.top ?? [], forest.untitled?.top ?? []]),
    ));
    for (const score of scores) visit(score, 0);
    return selected;
  }

  const untitledRank = rankTextSearchLabel(params.untitledLabel, normalizedQuery)?.rank ?? null;
  const rangeScores = (field: keyof CandidatePostingForest, lower: string, upper: string) => {
    params.stats && (params.stats.postingRangesRead += forests.length);
    return mergeTop(forests.map((forest) => rangeTop(forest[field], lower, upper)));
  };
  const untitledScores = untitledRank === null
    ? []
    : mergeTop(forests.map((forest) => forest.untitled?.top ?? []));

  for (let rank = 0; rank <= 3 && selected.length < params.limit; rank += 1) {
    const scores = rank === 0
      ? rangeScores('labels', `${normalizedQuery}\u0000`, `${normalizedQuery}\u0000\uffff`)
      : rank === 1
        ? rangeScores('labels', `${normalizedQuery}\u0001`, `${normalizedQuery}\uffff`)
        : rank === 2
          ? rangeScores('words', normalizedQuery, `${normalizedQuery}\uffff`)
          : rangeScores('suffixes', normalizedQuery, `${normalizedQuery}\uffff`);
    const withUntitled = untitledRank === rank ? mergeTop([scores, untitledScores]) : scores;
    for (const score of scoresForRank(rank, withUntitled)) visit(score, rank);
  }
  return selected;
}

function candidateRecord(node: NodeProjection): CandidateRecord | null {
  const kind = candidateKind(node);
  if (!kind) return null;
  const label = candidateLabel(node, kind);
  const normalizedLabel = normalizeSearchText(label);
  const entry: ReferenceCandidateIndexEntry = {
    id: node.id,
    kind,
    label,
    normalizedLabel,
    updatedAt: node.updatedAt,
    untitled: !label,
  };
  return { entry };
}

function sameCandidateRecord(
  left: CandidateRecord | null | undefined,
  right: CandidateRecord | null | undefined,
): boolean {
  if (!left || !right) return left === right || (!left && !right);
  return left.entry.id === right.entry.id
    && left.entry.kind === right.entry.kind
    && left.entry.label === right.entry.label
    && left.entry.normalizedLabel === right.entry.normalizedLabel
    && left.entry.updatedAt === right.entry.updatedAt
    && left.entry.untitled === right.entry.untitled;
}

function candidateKind(node: NodeProjection): ReferenceCandidateKind | null {
  if (!node.type || node.type === 'codeBlock') return 'content';
  if (node.type === 'attachment' && node.assetId) return 'file';
  if (node.type === 'image' && (node.assetId || node.mediaUrl)) return 'file';
  return null;
}

function candidateLabel(node: NodeProjection, kind: ReferenceCandidateKind): string {
  if (kind === 'content') return node.content.text;
  const displayName = node.content.text.trim();
  if (displayName) return displayName;
  if (node.type === 'attachment') return node.originalFilename?.trim() ?? '';
  if (node.type === 'image') return node.mediaUrl?.trim() || node.mediaAlt?.trim() || '';
  return '';
}

function postingKeys(entry: ReferenceCandidateIndexEntry): CandidatePostingKeys {
  if (entry.untitled) {
    return { labels: [], suffixes: [], untitled: [entry.id], words: [] };
  }
  const labels = [`${entry.normalizedLabel}\u0000${entry.id}`];
  const wordOffsets = new Set(textSearchLabelWordStarts(entry.normalizedLabel).map((word) => word.index));
  const words = [...wordOffsets]
    .filter((offset) => offset > 0)
    .map((offset) => `${entry.normalizedLabel.slice(offset)}\u0000${entry.id}\u0000${offset}`);
  const suffixes: string[] = [];
  for (let offset = 1; offset < entry.normalizedLabel.length; offset += 1) {
    if (wordOffsets.has(offset)) continue;
    suffixes.push(`${entry.normalizedLabel.slice(offset)}\u0000${entry.id}\u0000${offset}`);
  }
  return { labels, suffixes, untitled: [], words };
}

function emptyPostingEntries(): Record<ReferenceCandidateKind, Record<keyof CandidatePostingForest, PostingEntry[]>> {
  const create = () => ({ labels: [], suffixes: [], untitled: [], words: [] });
  return { content: create(), file: create() };
}

function appendRecordEntries(
  entries: Record<keyof CandidatePostingForest, PostingEntry[]>,
  record: CandidateRecord,
): void {
  const keys = postingKeys(record.entry);
  for (const field of ['labels', 'suffixes', 'untitled', 'words'] as const) {
    for (const key of keys[field]) entries[field].push({ key, score: record.entry });
  }
}

function buildForest(entries: Record<keyof CandidatePostingForest, PostingEntry[]>): CandidatePostingForest {
  return {
    labels: buildPostingTree(entries.labels),
    suffixes: buildPostingTree(entries.suffixes),
    untitled: buildPostingTree(entries.untitled),
    words: buildPostingTree(entries.words),
  };
}

function buildPostingTree(entries: PostingEntry[]): PostingNode | null {
  entries.sort((left, right) => compareKey(left.key, right.key));
  return buildSortedPostingTree(entries, 0, entries.length);
}

function buildSortedPostingTree(
  entries: readonly PostingEntry[],
  start: number,
  end: number,
): PostingNode | null {
  if (start >= end) return null;
  const middle = start + Math.floor((end - start) / 2);
  return makePostingNode(
    entries[middle]!,
    buildSortedPostingTree(entries, start, middle),
    buildSortedPostingTree(entries, middle + 1, end),
  );
}

function rangeTop(root: PostingNode | null, lower: string, upper: string): readonly PostingScore[] {
  if (!root || compareKey(root.maxKey, lower) < 0 || compareKey(root.minKey, upper) > 0) return [];
  if (compareKey(root.minKey, lower) >= 0 && compareKey(root.maxKey, upper) <= 0) return root.top;
  const own = compareKey(root.entry.key, lower) >= 0 && compareKey(root.entry.key, upper) <= 0
    ? [root.entry.score]
    : [];
  return mergeTop([rangeTop(root.left, lower, upper), own, rangeTop(root.right, lower, upper)]);
}

function makePostingNode(
  entry: PostingEntry,
  left: PostingNode | null,
  right: PostingNode | null,
): PostingNode {
  return {
    entry,
    height: Math.max(height(left), height(right)) + 1,
    left,
    maxKey: right?.maxKey ?? entry.key,
    minKey: left?.minKey ?? entry.key,
    right,
    top: mergeTop([left?.top ?? [], [entry.score], right?.top ?? []]),
  };
}

function height(node: PostingNode | null): number {
  return node?.height ?? 0;
}

function mergeTop(groups: readonly (readonly PostingScore[])[]): PostingScore[] {
  const offsets = groups.map(() => 0);
  const result: PostingScore[] = [];
  const seen = new Set<NodeId>();
  while (result.length < POSTING_TOP_LIMIT) {
    let nextGroup = -1;
    let nextCandidate: PostingScore | undefined;
    for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
      const candidate = groups[groupIndex]![offsets[groupIndex]!];
      if (!candidate) continue;
      if (!nextCandidate || comparePostingScore(candidate, nextCandidate) < 0) {
        nextCandidate = candidate;
        nextGroup = groupIndex;
      }
    }
    if (!nextCandidate || nextGroup < 0) break;
    offsets[nextGroup] += 1;
    if (seen.has(nextCandidate.id)) continue;
    seen.add(nextCandidate.id);
    result.push(nextCandidate);
  }
  return result;
}

function comparePostingScore(left: PostingScore, right: PostingScore): number {
  if (left.updatedAt !== right.updatedAt) return right.updatedAt - left.updatedAt;
  if (left.normalizedLabel.length !== right.normalizedLabel.length) {
    return left.normalizedLabel.length - right.normalizedLabel.length;
  }
  const labelOrder = compareKey(left.normalizedLabel, right.normalizedLabel);
  return labelOrder || compareKey(left.id, right.id);
}

function compareKey(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
