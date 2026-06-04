import { performance } from 'node:perf_hooks';
import {
  createTextSearchIndex,
  type TextSearchIndex,
  type TextSearchRecord,
  type TextSearchResult,
} from '../src/core/textSearchIndex';
import { analyzeTextSearchQuery } from '../src/core/textSearchAnalyzer';

const size = Number(process.argv[2] ?? 10000);
const tagFanout = Math.max(1, Math.floor(size / 50));

const records = Array.from({ length: size }, (_, index) => syntheticRecord(index));

const rebuild = time(() => createTextSearchIndex(records));
const index = rebuild.value;
const queries = [
  'Launch plan',
  'project design',
  'la',
  '成都天气',
  'common',
];

const queryTimings = queries.map((query) => {
  const measured = time(() => runTextSearchHotPath(index, query, 20));
  return {
    query,
    durationMs: measured.durationMs,
    hits: measured.value.length,
  };
});

const edited = syntheticRecord(Math.floor(size / 2), 'Edited launch design notes 成都天气');
const editTiming = time(() => index.upsert(edited));
const editSearchTiming = time(() => runTextSearchHotPath(index, 'edited launch design', 20));

const fanoutRecords = Array.from({ length: tagFanout }, (_, offset) =>
  syntheticRecord(offset, undefined, `renamed-tag-${offset % 5}`));
const fanoutTiming = time(() => {
  for (const record of fanoutRecords) index.upsert(record);
});

const memory = process.memoryUsage();
console.log(JSON.stringify({
  corpus: size,
  coldRebuildMs: rebuild.durationMs,
  queryTimings,
  singleNodeUpsertMs: editTiming.durationMs,
  editThenSearchMs: editTiming.durationMs + editSearchTiming.durationMs,
  tagFanout,
  tagFanoutMs: fanoutTiming.durationMs,
  memoryMB: {
    rss: bytesToMb(memory.rss),
    heapUsed: bytesToMb(memory.heapUsed),
  },
}, null, 2));

function syntheticRecord(index: number, title?: string, tagName = `tag-${index % 100}`): TextSearchRecord {
  const city = index % 17 === 0 ? '成都天气' : index % 19 === 0 ? '東京天気' : 'common';
  const topic = index % 7 === 0 ? 'Launch plan' : index % 11 === 0 ? 'project design' : 'daily note';
  return {
    id: `node-${index}`,
    kind: 'node',
    updatedAt: 1_700_000_000_000 + index,
    fields: [
      { key: 'title', text: title ?? `${topic} ${index}` },
      { key: 'description', text: `Synthetic description ${city} ${index % 31}` },
      { key: 'tag', text: tagName },
      { key: 'fieldName', text: 'Status' },
      { key: 'fieldValue', text: index % 3 === 0 ? 'Open' : 'Waiting' },
      { key: 'body', text: `Body text common token ${index % 250} ${topic}` },
    ],
  };
}

function runTextSearchHotPath(index: TextSearchIndex, query: string, limit: number): TextSearchResult[] {
  const analysis = analyzeTextSearchQuery(query);
  const results: TextSearchResult[] = [];
  for (const id of index.candidateIds(query)) {
    const score = index.scoreAnalyzedRecord(id, analysis, { includeSnippet: false });
    if (score) results.push(score);
  }
  return results
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    .slice(0, limit);
}

function time<T>(fn: () => T): { value: T; durationMs: number } {
  const started = performance.now();
  const value = fn();
  return { value, durationMs: roundMs(performance.now() - started) };
}

function roundMs(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function bytesToMb(value: number): number {
  return Math.round((value / 1024 / 1024) * 10) / 10;
}
