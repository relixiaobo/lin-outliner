import { intersectSets, unionSets } from './setUtils';

export type TextSearchFieldKey = 'title' | 'description' | 'tag' | 'fieldName' | 'fieldValue' | 'body';

export interface TextSearchRecord {
  id: string;
  kind: string;
  fields: TextSearchField[];
  updatedAt?: number;
}

export interface TextSearchField {
  key: TextSearchFieldKey;
  text: string;
  weight?: number;
}

export interface TextSearchOptions {
  limit?: number;
  candidateLimit?: number;
  includeSnippets?: boolean;
}

export interface TextSearchScoreOptions {
  includeSnippet?: boolean;
}

export interface TextSearchScore {
  id: string;
  score: number;
  matchedTerms: string[];
  allTermsMatched: boolean;
  phraseMatched: boolean;
  snippet: string;
}

export interface TextSearchResult extends TextSearchScore {}

export interface TextSearchIndex {
  search(query: string, options?: TextSearchOptions): TextSearchResult[];
  candidateIds(query: string, options?: TextSearchOptions): Set<string>;
  scoreRecord(id: string, query: string, options?: TextSearchScoreOptions): TextSearchScore | null;
  hasRecord(id: string): boolean;
  readonly size: number;
}

export interface MutableTextSearchIndex extends TextSearchIndex {
  upsert(record: TextSearchRecord): void;
  remove(id: string): void;
  rebuild(records: Iterable<TextSearchRecord>): void;
}

interface IndexedField {
  key: TextSearchFieldKey;
  normalized: string;
  tokens: string[];
  length: number;
  weight: number;
}

interface IndexedRecord {
  id: string;
  kind: string;
  updatedAt?: number;
  fields: IndexedField[];
  tokens: Map<string, number>;
  fieldTermFreqs: Map<TextSearchFieldKey, Map<string, number>>;
  fieldLengths: Map<TextSearchFieldKey, number>;
  fieldWeights: Map<TextSearchFieldKey, number>;
}

interface Posting {
  totalTf: number;
  fieldTf: Map<TextSearchFieldKey, number>;
}

interface QueryAnalysis {
  normalized: string;
  terms: string[];
  hasCjk: boolean;
}

const DEFAULT_FIELD_WEIGHTS: Record<TextSearchFieldKey, number> = {
  title: 4.2,
  body: 2.4,
  description: 1.6,
  tag: 2.6,
  fieldName: 1.0,
  fieldValue: 1.4,
};

const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'in',
  'is',
  'it',
  'of',
  'on',
  'or',
  'that',
  'the',
  'this',
  'to',
  'with',
]);

const CJK_RUN_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;
const CJK_CHAR_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const WORD_RE = /[\p{L}\p{N}]+(?:_[\p{L}\p{N}]+)*/gu;
const GRAM_PREFIX = '$gram:';
const MIN_PREFIX_LENGTH = 2;
const MAX_PREFIX_LENGTH = 16;

let cachedSegmenter: Intl.Segmenter | null | undefined;

export function createTextSearchIndex(records: Iterable<TextSearchRecord> = []): MutableTextSearchIndex {
  return new InMemoryTextSearchIndex(records);
}

export function normalizeSearchText(text: string): string {
  return text
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokenizeSearchText(text: string): string[] {
  const normalized = normalizeSearchText(text);
  if (!normalized) return [];
  const terms: string[] = [];
  const segmenter = wordSegmenter();
  if (segmenter) {
    for (const segment of segmenter.segment(normalized)) {
      if (!segment.isWordLike) continue;
      emitWordTerms(segment.segment, terms);
    }
  } else {
    emitWordTerms(normalized, terms);
  }
  emitCjkTerms(normalized, terms);
  emitLatinTrigrams(normalized, terms);
  return terms.filter(Boolean);
}

function wordSegmenter(): Intl.Segmenter | null {
  if (cachedSegmenter !== undefined) return cachedSegmenter;
  cachedSegmenter = typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'word' })
    : null;
  return cachedSegmenter;
}

function emitWordTerms(text: string, terms: string[]) {
  for (const match of text.matchAll(WORD_RE)) {
    const value = match[0];
    if (!value || CJK_CHAR_RE.test(value)) continue;
    terms.push(value);
  }
}

function emitCjkTerms(text: string, terms: string[]) {
  for (const match of text.matchAll(CJK_RUN_RE)) {
    const chars = [...match[0]];
    if (chars.length === 1) {
      terms.push(chars[0]!);
      continue;
    }
    for (let index = 0; index < chars.length - 1; index += 1) {
      terms.push(`${chars[index]}${chars[index + 1]}`);
    }
  }
}

function emitLatinTrigrams(text: string, terms: string[]) {
  for (const match of text.matchAll(WORD_RE)) {
    const value = match[0];
    if (value.length < 3 || CJK_CHAR_RE.test(value)) continue;
    for (let index = 0; index < value.length - 2; index += 1) {
      terms.push(`${GRAM_PREFIX}${value.slice(index, index + 3)}`);
    }
  }
}

function analyzeQuery(query: string): QueryAnalysis {
  const normalized = normalizeSearchText(query);
  if (!normalized) return { normalized: '', terms: [], hasCjk: false };
  const rawTerms = uniqueTerms(tokenizeSearchText(normalized));
  const wordTerms = rawTerms.filter((term) => !term.startsWith(GRAM_PREFIX));
  const nonStopTerms = wordTerms.filter((term) => !STOP_WORDS.has(term));
  const terms = nonStopTerms.length > 0 ? nonStopTerms : wordTerms;
  return {
    normalized,
    terms,
    hasCjk: CJK_CHAR_RE.test(normalized),
  };
}

function uniqueTerms(terms: Iterable<string>): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const term of terms) {
    if (!term || seen.has(term)) continue;
    seen.add(term);
    result.push(term);
  }
  return result;
}

class InMemoryTextSearchIndex implements MutableTextSearchIndex {
  private records = new Map<string, IndexedRecord>();
  private postings = new Map<string, Map<string, Posting>>();
  private sortedPrefixTerms: string[] | null = null;
  private docFreq = new Map<string, number>();
  private fieldTotalLengths = new Map<TextSearchFieldKey, number>();
  private fieldDocCounts = new Map<TextSearchFieldKey, number>();

  constructor(records: Iterable<TextSearchRecord>) {
    this.rebuild(records);
  }

  get size() {
    return this.records.size;
  }

  hasRecord(id: string): boolean {
    return this.records.has(id);
  }

  rebuild(records: Iterable<TextSearchRecord>) {
    this.records.clear();
    this.postings.clear();
    this.sortedPrefixTerms = null;
    this.docFreq.clear();
    this.fieldTotalLengths.clear();
    this.fieldDocCounts.clear();
    for (const record of records) this.upsert(record);
  }

  upsert(record: TextSearchRecord) {
    this.remove(record.id);
    const indexed = indexRecord(record);
    if (!indexed || indexed.tokens.size === 0) return;
    this.records.set(indexed.id, indexed);
    for (const [fieldKey, length] of indexed.fieldLengths) {
      this.fieldTotalLengths.set(fieldKey, (this.fieldTotalLengths.get(fieldKey) ?? 0) + length);
      this.fieldDocCounts.set(fieldKey, (this.fieldDocCounts.get(fieldKey) ?? 0) + 1);
    }
    for (const [term, totalTf] of indexed.tokens) {
      this.docFreq.set(term, (this.docFreq.get(term) ?? 0) + 1);
      const termPostings = mapFor(this.postings, term);
      const posting: Posting = { totalTf, fieldTf: new Map() };
      for (const [fieldKey, terms] of indexed.fieldTermFreqs) {
        const tf = terms.get(term) ?? 0;
        if (tf > 0) posting.fieldTf.set(fieldKey, tf);
      }
      termPostings.set(indexed.id, posting);
    }
    this.sortedPrefixTerms = null;
  }

  remove(id: string) {
    const indexed = this.records.get(id);
    if (!indexed) return;
    this.records.delete(id);
    for (const [fieldKey, length] of indexed.fieldLengths) {
      decrementMap(this.fieldTotalLengths, fieldKey, length);
      decrementMap(this.fieldDocCounts, fieldKey, 1);
    }
    for (const term of indexed.tokens.keys()) {
      decrementMap(this.docFreq, term, 1);
      const termPostings = this.postings.get(term);
      termPostings?.delete(id);
      if (termPostings?.size === 0) this.postings.delete(term);
    }
    this.sortedPrefixTerms = null;
  }

  candidateIds(query: string, options: TextSearchOptions = {}): Set<string> {
    const analysis = analyzeQuery(query);
    return this.candidateIdsForAnalysis(analysis, options);
  }

  private candidateIdsForAnalysis(analysis: QueryAnalysis, options: TextSearchOptions = {}): Set<string> {
    if (analysis.terms.length === 0) return new Set();
    const candidateSets = analysis.terms
      .map((term) => this.matchingIdsForTerm(term))
      .filter((ids) => ids.size > 0)
      .sort((left, right) => left.size - right.size);
    if (candidateSets.length === 0) return new Set();

    const requiredCount = candidateSets.length === analysis.terms.length ? candidateSets.length : 1;
    let ids = new Set(candidateSets[0]!);
    for (let index = 1; index < requiredCount; index += 1) {
      ids = intersectSets(ids, candidateSets[index]!);
      if (ids.size === 0) break;
    }
    if (ids.size === 0 && candidateSets.length > 1) {
      ids = unionSets(candidateSets);
    }

    const limit = options.candidateLimit;
    if (typeof limit !== 'number' || ids.size <= limit) return ids;
    return new Set([...ids].slice(0, limit));
  }

  search(query: string, options: TextSearchOptions = {}): TextSearchResult[] {
    const analysis = analyzeQuery(query);
    const candidates = this.candidateIdsForAnalysis(analysis, options);
    const limit = normalizedResultLimit(options.limit);
    if (limit === 0) return [];
    const boundedResults = limit === null ? null : new BoundedTextSearchResults(limit);
    const results: TextSearchResult[] = [];
    for (const id of candidates) {
      const record = this.records.get(id);
      const score = record ? this.scoreIndexedRecord(record, analysis, false) : null;
      if (!score) continue;
      if (boundedResults) boundedResults.add(score);
      else results.push(score);
    }
    const limited = boundedResults
      ? boundedResults.results()
      : results.sort(compareTextSearchResults);
    if (options.includeSnippets === false) return limited;
    return limited.map((result) => {
      const record = this.records.get(result.id);
      return record ? { ...result, snippet: snippetFor(record, analysis) } : result;
    });
  }

  scoreRecord(id: string, query: string, options: TextSearchScoreOptions = {}): TextSearchScore | null {
    const record = this.records.get(id);
    if (!record) return null;
    const analysis = analyzeQuery(query);
    return this.scoreIndexedRecord(record, analysis, options.includeSnippet !== false);
  }

  private scoreIndexedRecord(
    record: IndexedRecord,
    analysis: QueryAnalysis,
    includeSnippet: boolean,
  ): TextSearchScore | null {
    if (!analysis.normalized || analysis.terms.length === 0) return null;

    const phraseMatched = record.fields.some((field) => fieldMatchesPhrase(field, analysis));
    if (analysis.hasCjk && !phraseMatched) return null;

    const matchedTerms = analysis.terms.filter((term) => recordHasTerm(record, term));
    const allTermsMatched = matchedTerms.length === analysis.terms.length;
    if (!phraseMatched && !allTermsMatched) return null;

    let score = 0;
    for (const term of matchedTerms) score += this.bm25(record, term);
    score += boostScore(record, analysis, { phraseMatched, allTermsMatched, matchedTerms });
    if (!Number.isFinite(score) || score <= 0) return null;

    return {
      id: record.id,
      score,
      matchedTerms,
      allTermsMatched,
      phraseMatched,
      snippet: includeSnippet ? snippetFor(record, analysis) : '',
    };
  }

  private matchingIdsForTerm(term: string): Set<string> {
    const exact = idsForPosting(this.postings.get(term));
    if (exact.size >= this.records.size) return exact;
    const prefix = this.prefixMatchingIds(term);
    const tokenMatches = unionSets([exact, prefix]);
    if (term.startsWith(GRAM_PREFIX) || CJK_CHAR_RE.test(term) || term.length < 3) return tokenMatches;
    if (tokenMatches.size >= this.records.size) return tokenMatches;
    return unionSets([tokenMatches, this.trigramMatchingIds(term)]);
  }

  private prefixMatchingIds(term: string): Set<string> {
    if (!isPrefixIndexableTerm(term)) return new Set();
    const result = new Set<string>();
    const terms = this.prefixTerms();
    for (let index = lowerBound(terms, term); index < terms.length; index += 1) {
      const indexedTerm = terms[index]!;
      if (!indexedTerm.startsWith(term)) break;
      for (const id of this.postings.get(indexedTerm)?.keys() ?? []) result.add(id);
    }
    return result;
  }

  private trigramMatchingIds(term: string): Set<string> {
    const grams = tokenizeSearchText(term).filter((value) => value.startsWith(GRAM_PREFIX));
    if (grams.length === 0) return new Set();
    const sets = grams
      .map((gram) => idsForPosting(this.postings.get(gram)))
      .filter((ids) => ids.size > 0)
      .sort((left, right) => left.size - right.size);
    if (sets.length !== grams.length) return new Set();
    let ids = new Set(sets[0]!);
    for (let index = 1; index < sets.length; index += 1) ids = intersectSets(ids, sets[index]!);
    return ids;
  }

  private bm25(record: IndexedRecord, term: string): number {
    const posting = this.postings.get(term)?.get(record.id);
    if (!posting) return 0;
    const df = this.docFreq.get(term) ?? 0;
    const totalRecords = Math.max(this.records.size, 1);
    const idf = Math.log(1 + (totalRecords - df + 0.5) / (df + 0.5));
    const k1 = 1.2;
    const b = 0.72;
    let score = 0;
    for (const [fieldKey, tf] of posting.fieldTf) {
      const length = record.fieldLengths.get(fieldKey) ?? 1;
      const avgLength = averageFieldLength(this.fieldTotalLengths, this.fieldDocCounts, fieldKey);
      const normalizedTf = (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (length / avgLength)));
      const weight = record.fieldWeights.get(fieldKey) ?? DEFAULT_FIELD_WEIGHTS[fieldKey];
      score += idf * normalizedTf * weight;
    }
    return score;
  }

  private prefixTerms(): string[] {
    if (!this.sortedPrefixTerms) {
      this.sortedPrefixTerms = [...this.postings.keys()]
        .filter(isPrefixIndexableToken)
        .sort();
    }
    return this.sortedPrefixTerms;
  }
}

class BoundedTextSearchResults {
  private heap: TextSearchResult[] = [];

  constructor(private readonly limit: number) {}

  add(result: TextSearchResult) {
    if (this.limit <= 0) return;
    if (this.heap.length < this.limit) {
      this.heap.push(result);
      this.bubbleUp(this.heap.length - 1);
      return;
    }
    const currentWorst = this.heap[0]!;
    if (!isBetterTextSearchResult(result, currentWorst)) return;
    this.heap[0] = result;
    this.sinkDown(0);
  }

  results(): TextSearchResult[] {
    return [...this.heap].sort(compareTextSearchResults);
  }

  private bubbleUp(index: number) {
    let current = index;
    while (current > 0) {
      const parent = Math.floor((current - 1) / 2);
      if (compareWorstFirst(this.heap[current]!, this.heap[parent]!) >= 0) break;
      swap(this.heap, current, parent);
      current = parent;
    }
  }

  private sinkDown(index: number) {
    let current = index;
    while (true) {
      const left = current * 2 + 1;
      const right = left + 1;
      let next = current;
      if (left < this.heap.length && compareWorstFirst(this.heap[left]!, this.heap[next]!) < 0) next = left;
      if (right < this.heap.length && compareWorstFirst(this.heap[right]!, this.heap[next]!) < 0) next = right;
      if (next === current) return;
      swap(this.heap, current, next);
      current = next;
    }
  }
}

function indexRecord(record: TextSearchRecord): IndexedRecord | null {
  const fields = record.fields
    .map((field): IndexedField | null => {
      const normalized = normalizeSearchText(field.text);
      if (!normalized) return null;
      const tokens = tokenizeSearchText(normalized);
      if (tokens.length === 0) return null;
      return {
        key: field.key,
        normalized,
        tokens,
        length: tokens.length,
        weight: field.weight ?? DEFAULT_FIELD_WEIGHTS[field.key],
      };
    })
    .filter((field): field is IndexedField => Boolean(field));
  if (fields.length === 0) return null;

  const tokens = new Map<string, number>();
  const fieldTermFreqs = new Map<TextSearchFieldKey, Map<string, number>>();
  const fieldLengths = new Map<TextSearchFieldKey, number>();
  const fieldWeights = new Map<TextSearchFieldKey, number>();
  for (const field of fields) {
    fieldLengths.set(field.key, (fieldLengths.get(field.key) ?? 0) + field.length);
    fieldWeights.set(field.key, Math.max(fieldWeights.get(field.key) ?? 0, field.weight));
    const fieldTerms = mapFor(fieldTermFreqs, field.key);
    for (const token of field.tokens) {
      tokens.set(token, (tokens.get(token) ?? 0) + 1);
      fieldTerms.set(token, (fieldTerms.get(token) ?? 0) + 1);
    }
  }
  return {
    id: record.id,
    kind: record.kind,
    updatedAt: record.updatedAt,
    fields,
    tokens,
    fieldTermFreqs,
    fieldLengths,
    fieldWeights,
  };
}

function boostScore(
  record: IndexedRecord,
  analysis: QueryAnalysis,
  match: { phraseMatched: boolean; allTermsMatched: boolean; matchedTerms: string[] },
): number {
  const title = record.fields.find((field) => field.key === 'title')?.normalized ?? '';
  const titleExact = title === analysis.normalized;
  const titlePrefix = title.startsWith(analysis.normalized);
  let score = 0;
  if (titleExact) score += 120;
  else if (titlePrefix) score += 70;
  if (match.phraseMatched) score += 42;
  if (match.allTermsMatched) score += 26;
  if (record.fields.some((field) => field.key === 'tag' && field.normalized === analysis.normalized)) score += 18;
  if (match.matchedTerms.length > 0) score += Math.min(match.matchedTerms.length, 4) * 4;
  return score;
}

function recordHasTerm(record: IndexedRecord, term: string): boolean {
  if (record.tokens.has(term)) return true;
  if (term.startsWith(GRAM_PREFIX)) return false;
  return record.fields.some((field) =>
    fieldHasTokenPrefix(field, term)
    || (canMatchMidWordSubstring(term) && field.normalized.includes(term)));
}

function fieldMatchesPhrase(field: IndexedField, analysis: QueryAnalysis): boolean {
  if (isShortLatinSingleTermQuery(analysis)) return fieldHasTokenPrefix(field, analysis.terms[0]!);
  return field.normalized.includes(analysis.normalized);
}

function fieldHasTokenPrefix(field: IndexedField, term: string): boolean {
  return field.tokens.some((token) => !token.startsWith(GRAM_PREFIX) && token.startsWith(term));
}

function canMatchMidWordSubstring(term: string): boolean {
  return term.length >= 3 || CJK_CHAR_RE.test(term);
}

function isShortLatinSingleTermQuery(analysis: QueryAnalysis): boolean {
  const term = analysis.terms[0];
  return analysis.terms.length === 1
    && term === analysis.normalized
    && term.length < 3
    && !CJK_CHAR_RE.test(term);
}

function snippetFor(record: IndexedRecord, analysis: QueryAnalysis): string {
  const field = bestSnippetField(record, analysis);
  if (!field) return '';
  const exactIndex = field.normalized.indexOf(analysis.normalized);
  const term = analysis.terms.find((value) => field.normalized.includes(value));
  const index = exactIndex >= 0 ? exactIndex : term ? field.normalized.indexOf(term) : 0;
  const start = Math.max(0, index - 60);
  const end = Math.min(field.normalized.length, index + Math.max(analysis.normalized.length, term?.length ?? 0) + 80);
  return `${start > 0 ? '...' : ''}${field.normalized.slice(start, end)}${end < field.normalized.length ? '...' : ''}`;
}

function bestSnippetField(record: IndexedRecord, analysis: QueryAnalysis): IndexedField | undefined {
  const phrase = record.fields.find((field) => field.normalized.includes(analysis.normalized));
  if (phrase) return phrase;
  return record.fields.find((field) => analysis.terms.some((term) => field.normalized.includes(term)))
    ?? record.fields[0];
}

function averageFieldLength(
  totals: Map<TextSearchFieldKey, number>,
  counts: Map<TextSearchFieldKey, number>,
  fieldKey: TextSearchFieldKey,
): number {
  return Math.max(1, (totals.get(fieldKey) ?? 0) / Math.max(counts.get(fieldKey) ?? 0, 1));
}

function mapFor<K, V>(map: Map<K, Map<string, V>>, key: K): Map<string, V> {
  let nested = map.get(key);
  if (!nested) {
    nested = new Map();
    map.set(key, nested);
  }
  return nested;
}

function decrementMap<K>(map: Map<K, number>, key: K, value: number) {
  const next = (map.get(key) ?? 0) - value;
  if (next > 0) map.set(key, next);
  else map.delete(key);
}

function idsForPosting(posting: Map<string, Posting> | undefined): Set<string> {
  return new Set(posting?.keys() ?? []);
}

function isPrefixIndexableToken(token: string): boolean {
  return token.length > MIN_PREFIX_LENGTH
    && !token.startsWith(GRAM_PREFIX)
    && !CJK_CHAR_RE.test(token);
}

function isPrefixIndexableTerm(term: string): boolean {
  return term.length >= MIN_PREFIX_LENGTH
    && term.length <= MAX_PREFIX_LENGTH
    && !term.startsWith(GRAM_PREFIX)
    && !CJK_CHAR_RE.test(term);
}

function normalizedResultLimit(limit: number | undefined): number | null {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return null;
  return Math.max(0, Math.trunc(limit));
}

function compareTextSearchResults(left: TextSearchResult, right: TextSearchResult): number {
  return right.score - left.score || left.id.localeCompare(right.id);
}

function isBetterTextSearchResult(left: TextSearchResult, right: TextSearchResult): boolean {
  return compareTextSearchResults(left, right) < 0;
}

function compareWorstFirst(left: TextSearchResult, right: TextSearchResult): number {
  return -compareTextSearchResults(left, right);
}

function swap<T>(values: T[], left: number, right: number) {
  const value = values[left]!;
  values[left] = values[right]!;
  values[right] = value;
}

function lowerBound(values: readonly string[], target: string): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (values[mid]! < target) low = mid + 1;
    else high = mid;
  }
  return low;
}
