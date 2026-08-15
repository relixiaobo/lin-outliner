import {
  normalizeSearchText,
  rankTextSearchLabel,
  textSearchLabelWordStarts,
} from '../../core/textSearchAnalyzer';
import type { NodeId, NodeProjection } from '../api/types';
import { SparseProjectionMap } from './sparseProjectionMap';

const POSTING_TOP_LIMIT = 48;
const POSTING_OVERLAY_LIMIT = 23;
const POSTING_BLOCK_SIZE = 128;

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
  readonly offset: number;
  readonly score: PostingScore;
  readonly text: string;
  sortRank: number;
}

interface PostingRangeIndex {
  readonly blockTree: readonly (readonly PostingScore[])[];
  readonly blockTreeLeafOffset: number;
  readonly entries: readonly PostingEntry[];
}

interface CandidateRecord {
  readonly entry: ReferenceCandidateIndexEntry;
}

interface CandidatePostingForest {
  readonly exactLabels: ReadonlyMap<string, readonly PostingScore[]>;
  readonly labels: PostingRangeIndex;
  readonly suffixes: PostingRangeIndex;
  readonly untitled: readonly PostingScore[];
  readonly words: PostingRangeIndex;
}

interface CandidatePostingEntries {
  readonly exactLabels: Map<string, PostingScore[]>;
  readonly labels: PostingEntry[];
  readonly suffixes: PostingEntry[];
  readonly untitled: PostingScore[];
  readonly words: PostingEntry[];
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

  return {
    ...params.previous,
    pending,
    records,
  };
}

export function referenceCandidateIndexNeedsCompaction(index: ReferenceCandidateIndex): boolean {
  return index.pending.size > POSTING_OVERLAY_LIMIT;
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
  const scoresForRank = (rank: number, baseScores: readonly PostingScore[]) => mergeTop([
    baseScores,
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
      forests.flatMap((forest) => [
        postingIntervalTop(
          forest.labels,
          0,
          forest.labels.entries.length,
          params.index.pending,
        ),
        scoresExcluding(forest.untitled, params.index.pending),
      ]),
    ));
    for (const score of scores) visit(score, 0);
    return selected;
  }

  const untitledRank = rankTextSearchLabel(params.untitledLabel, normalizedQuery)?.rank ?? null;
  const prefixScores = (field: 'labels' | 'suffixes' | 'words') => {
    params.stats && (params.stats.postingRangesRead += forests.length);
    return mergeTop(forests.map((forest) => postingPrefixTop(
      forest[field],
      normalizedQuery,
      params.index.pending,
    )));
  };
  const untitledScores = untitledRank === null
    ? []
    : mergeTop(forests.map((forest) => scoresExcluding(
        forest.untitled,
        params.index.pending,
      )));
  const exactScores = mergeTop(forests.map((forest) => scoresExcluding(
    forest.exactLabels.get(normalizedQuery) ?? [],
    params.index.pending,
  )));

  for (let rank = 0; rank <= 3 && selected.length < params.limit; rank += 1) {
    const scores = rank === 0
      ? exactScores
      : rank === 1
        ? prefixScores('labels')
        : rank === 2
          ? prefixScores('words')
          : prefixScores('suffixes');
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

function emptyPostingEntries(): Record<ReferenceCandidateKind, CandidatePostingEntries> {
  const create = (): CandidatePostingEntries => ({
    exactLabels: new Map(),
    labels: [],
    suffixes: [],
    untitled: [],
    words: [],
  });
  return { content: create(), file: create() };
}

function appendRecordEntries(
  entries: CandidatePostingEntries,
  record: CandidateRecord,
): void {
  const entry = record.entry;
  if (entry.untitled) {
    entries.untitled.push(entry);
    return;
  }

  entries.labels.push({ offset: 0, score: entry, sortRank: 0, text: entry.normalizedLabel });
  const exactScores = entries.exactLabels.get(entry.normalizedLabel) ?? [];
  exactScores.push(entry);
  entries.exactLabels.set(entry.normalizedLabel, exactScores);

  const wordOffsets = new Set(textSearchLabelWordStarts(entry.normalizedLabel).map((word) => word.index));
  for (let offset = 1; offset < entry.normalizedLabel.length; offset += 1) {
    const posting = { offset, score: entry, sortRank: 0, text: entry.normalizedLabel };
    if (wordOffsets.has(offset)) entries.words.push(posting);
    entries.suffixes.push(posting);
  }
}

function buildForest(entries: CandidatePostingEntries): CandidatePostingForest {
  assignPostingSortRanks(entries);
  const exactLabels = new Map<string, readonly PostingScore[]>();
  for (const [label, scores] of entries.exactLabels) {
    exactLabels.set(label, scores.sort(comparePostingScore));
  }
  return {
    exactLabels,
    labels: buildPostingRangeIndex(entries.labels),
    suffixes: buildPostingRangeIndex(entries.suffixes),
    untitled: entries.untitled.sort(comparePostingScore),
    words: buildPostingRangeIndex(entries.words),
  };
}

// Postings retain one normalized label plus offsets. A generalized suffix-array
// rank supplies lexical order without materializing every suffix string; zero is
// reserved as a between-label separator outside the charCode + 1 alphabet.
function assignPostingSortRanks(entries: CandidatePostingEntries): void {
  const labelStarts = new Map<NodeId, number>();
  const symbolCount = entries.labels.reduce((total, entry) => total + entry.text.length + 1, 0);
  const symbols = new Uint32Array(symbolCount);
  let cursor = 0;
  for (const entry of entries.labels) {
    labelStarts.set(entry.score.id, cursor);
    for (let index = 0; index < entry.text.length; index += 1) {
      symbols[cursor++] = entry.text.charCodeAt(index) + 1;
    }
    symbols[cursor++] = 0;
  }
  const ranks = buildSuffixRanks(symbols);
  for (const postingEntries of [entries.labels, entries.words, entries.suffixes]) {
    for (const entry of postingEntries) {
      const labelStart = labelStarts.get(entry.score.id);
      if (labelStart === undefined) continue;
      entry.sortRank = ranks[labelStart + entry.offset] ?? 0;
    }
  }
}

function buildSuffixRanks(symbols: Uint32Array): Uint32Array {
  const length = symbols.length;
  if (length === 0) return new Uint32Array();
  let suffixes = new Uint32Array(length);
  let scratch = new Uint32Array(length);
  for (let index = 0; index < length; index += 1) suffixes[index] = index;
  countingSortSymbols(suffixes, scratch, symbols);
  [suffixes, scratch] = [scratch, suffixes];

  let ranks = new Uint32Array(length);
  let nextRanks = new Uint32Array(length);
  let classCount = 0;
  let previousSymbol = -1;
  for (const suffix of suffixes) {
    const symbol = symbols[suffix]!;
    if (symbol !== previousSymbol) {
      previousSymbol = symbol;
      classCount += 1;
    }
    ranks[suffix] = classCount - 1;
  }

  for (let width = 1; width < length && classCount < length; width *= 2) {
    countingSortSuffixes(suffixes, scratch, ranks, width, classCount);
    countingSortSuffixes(scratch, suffixes, ranks, 0, classCount);
    let nextClass = 0;
    nextRanks[suffixes[0]!] = 0;
    for (let index = 1; index < length; index += 1) {
      const previous = suffixes[index - 1]!;
      const current = suffixes[index]!;
      const previousSecond = previous + width < length ? ranks[previous + width]! + 1 : 0;
      const currentSecond = current + width < length ? ranks[current + width]! + 1 : 0;
      if (ranks[previous] !== ranks[current] || previousSecond !== currentSecond) {
        nextClass += 1;
      }
      nextRanks[current] = nextClass;
    }
    classCount = nextClass + 1;
    [ranks, nextRanks] = [nextRanks, ranks];
  }
  return ranks;
}

function countingSortSymbols(
  input: Uint32Array,
  output: Uint32Array,
  symbols: Uint32Array,
): void {
  const counts = new Uint32Array(65_537);
  for (const suffix of input) counts[symbols[suffix]!] += 1;
  prefixCountOffsets(counts);
  for (const suffix of input) output[counts[symbols[suffix]!]++] = suffix;
}

function countingSortSuffixes(
  input: Uint32Array,
  output: Uint32Array,
  ranks: Uint32Array,
  offset: number,
  classCount: number,
): void {
  const counts = new Uint32Array(classCount + 1);
  for (const suffix of input) {
    const key = suffix + offset < ranks.length ? ranks[suffix + offset]! + 1 : 0;
    counts[key] += 1;
  }
  prefixCountOffsets(counts);
  for (const suffix of input) {
    const key = suffix + offset < ranks.length ? ranks[suffix + offset]! + 1 : 0;
    output[counts[key]++] = suffix;
  }
}

function prefixCountOffsets(counts: Uint32Array): void {
  let offset = 0;
  for (let index = 0; index < counts.length; index += 1) {
    const count = counts[index]!;
    counts[index] = offset;
    offset += count;
  }
}

// Range queries scan at most two boundary blocks and merge the precomputed top
// scores for aligned interior blocks. This keeps summaries proportional to
// label text instead of storing a top-48 array on every suffix-tree node.
function buildPostingRangeIndex(entries: PostingEntry[]): PostingRangeIndex {
  entries.sort(comparePostingEntry);
  const blockCount = Math.ceil(entries.length / POSTING_BLOCK_SIZE);
  let blockTreeLeafOffset = 1;
  while (blockTreeLeafOffset < blockCount) blockTreeLeafOffset *= 2;
  const blockTree: PostingScore[][] = Array.from(
    { length: blockTreeLeafOffset * 2 },
    () => [],
  );
  for (let block = 0; block < blockCount; block += 1) {
    const start = block * POSTING_BLOCK_SIZE;
    const end = Math.min(entries.length, start + POSTING_BLOCK_SIZE);
    blockTree[blockTreeLeafOffset + block] = topPostingScores(
      entries.slice(start, end).map((entry) => entry.score),
    );
  }
  for (let node = blockTreeLeafOffset - 1; node > 0; node -= 1) {
    blockTree[node] = mergeTop([blockTree[node * 2]!, blockTree[node * 2 + 1]!]);
  }
  return {
    blockTree,
    blockTreeLeafOffset,
    entries,
  };
}

function postingPrefixTop(
  index: PostingRangeIndex,
  prefix: string,
  excludedIds: ReadonlyMap<NodeId, unknown>,
): readonly PostingScore[] {
  const start = postingPrefixBoundary(index.entries, prefix, false);
  const end = postingPrefixBoundary(index.entries, prefix, true);
  return postingIntervalTop(index, start, end, excludedIds);
}

function postingPrefixBoundary(
  entries: readonly PostingEntry[],
  prefix: string,
  afterMatches: boolean,
): number {
  let lower = 0;
  let upper = entries.length;
  while (lower < upper) {
    const middle = lower + Math.floor((upper - lower) / 2);
    const order = comparePostingEntryToPrefix(entries[middle]!, prefix);
    if (order < 0 || (afterMatches && order === 0)) lower = middle + 1;
    else upper = middle;
  }
  return lower;
}

function postingIntervalTop(
  index: PostingRangeIndex,
  start: number,
  end: number,
  excludedIds: ReadonlyMap<NodeId, unknown>,
): readonly PostingScore[] {
  if (start >= end) return [];
  const firstFullBlock = Math.ceil(start / POSTING_BLOCK_SIZE);
  const lastFullBlock = Math.floor(end / POSTING_BLOCK_SIZE);
  if (firstFullBlock >= lastFullBlock) {
    return postingEntryRangeTop(index.entries, start, end, excludedIds);
  }

  const groups: Array<readonly PostingScore[]> = [];
  const leadingEnd = firstFullBlock * POSTING_BLOCK_SIZE;
  if (start < leadingEnd) {
    groups.push(postingEntryRangeTop(index.entries, start, leadingEnd, excludedIds));
  }
  const trailingStart = lastFullBlock * POSTING_BLOCK_SIZE;
  if (trailingStart < end) {
    groups.push(postingEntryRangeTop(index.entries, trailingStart, end, excludedIds));
  }
  for (const treeNode of postingBlockTreeNodes(index, firstFullBlock, lastFullBlock)) {
    groups.push(postingTreeNodeTop(index, treeNode, excludedIds));
  }
  return mergeTop(groups);
}

function postingBlockTreeNodes(
  index: PostingRangeIndex,
  startBlock: number,
  endBlock: number,
): number[] {
  const nodes: number[] = [];
  let left = index.blockTreeLeafOffset + startBlock;
  let right = index.blockTreeLeafOffset + endBlock;
  while (left < right) {
    if (left % 2 === 1) nodes.push(left++);
    if (right % 2 === 1) nodes.push(--right);
    left = Math.floor(left / 2);
    right = Math.floor(right / 2);
  }
  return nodes;
}

function postingTreeNodeTop(
  index: PostingRangeIndex,
  treeNode: number,
  excludedIds: ReadonlyMap<NodeId, unknown>,
): readonly PostingScore[] {
  const summary = index.blockTree[treeNode] ?? [];
  const filtered = scoresExcluding(summary, excludedIds);
  if (filtered.length >= POSTING_TOP_LIMIT || summary.length < POSTING_TOP_LIMIT) {
    return filtered;
  }
  if (treeNode >= index.blockTreeLeafOffset) {
    const block = treeNode - index.blockTreeLeafOffset;
    const start = block * POSTING_BLOCK_SIZE;
    return postingEntryRangeTop(
      index.entries,
      start,
      Math.min(index.entries.length, start + POSTING_BLOCK_SIZE),
      excludedIds,
    );
  }
  return mergeTop([
    postingTreeNodeTop(index, treeNode * 2, excludedIds),
    postingTreeNodeTop(index, treeNode * 2 + 1, excludedIds),
  ]);
}

function postingEntryRangeTop(
  entries: readonly PostingEntry[],
  start: number,
  end: number,
  excludedIds: ReadonlyMap<NodeId, unknown>,
): readonly PostingScore[] {
  const scores: PostingScore[] = [];
  for (let index = start; index < end; index += 1) {
    const score = entries[index]!.score;
    if (!excludedIds.has(score.id)) scores.push(score);
  }
  return topPostingScores(scores);
}

function scoresExcluding(
  scores: readonly PostingScore[],
  excludedIds: ReadonlyMap<NodeId, unknown>,
): PostingScore[] {
  const result: PostingScore[] = [];
  for (const score of scores) {
    if (excludedIds.has(score.id)) continue;
    result.push(score);
    if (result.length >= POSTING_TOP_LIMIT) break;
  }
  return result;
}

function topPostingScores(scores: PostingScore[]): PostingScore[] {
  scores.sort(comparePostingScore);
  const result: PostingScore[] = [];
  const seen = new Set<NodeId>();
  for (const score of scores) {
    if (seen.has(score.id)) continue;
    seen.add(score.id);
    result.push(score);
    if (result.length >= POSTING_TOP_LIMIT) break;
  }
  return result;
}

function comparePostingEntry(left: PostingEntry, right: PostingEntry): number {
  if (left.sortRank !== right.sortRank) return left.sortRank - right.sortRank;
  const idOrder = compareKey(left.score.id, right.score.id);
  return idOrder || left.offset - right.offset;
}

function comparePostingEntryToPrefix(entry: PostingEntry, prefix: string): number {
  const remaining = entry.text.length - entry.offset;
  const sharedLength = Math.min(remaining, prefix.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const left = entry.text.charCodeAt(entry.offset + index);
    const right = prefix.charCodeAt(index);
    if (left !== right) return left - right;
  }
  return remaining < prefix.length ? -1 : 0;
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
