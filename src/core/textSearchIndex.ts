import { intersectSetList, unionSets } from './setUtils';
import {
  analyzeTextSearchField,
  analyzeTextSearchQuery,
  buildTextSearchSnippet,
  canTextSearchMatchMidWordSubstring,
  isShortLatinSingleTermTextSearchQuery,
  isTextSearchGramTerm,
  isTextSearchPrefixIndexableTerm,
  isTextSearchPrefixIndexableToken,
  textSearchTextHasCjk,
  tokenizeSearchText,
  type TextSearchQueryAnalysis,
} from './textSearchAnalyzer';

export {
  analyzeTextSearchField,
  analyzeTextSearchQuery,
  buildTextSearchSnippet,
  normalizeSearchText,
  tokenizeSearchText,
} from './textSearchAnalyzer';

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
  scoreAnalyzedRecord(id: string, analysis: TextSearchQueryAnalysis, options?: TextSearchScoreOptions): TextSearchScore | null;
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

const DEFAULT_FIELD_WEIGHTS: Record<TextSearchFieldKey, number> = {
  title: 4.2,
  body: 2.4,
  description: 1.6,
  tag: 2.6,
  fieldName: 1.0,
  fieldValue: 1.4,
};

export function createTextSearchIndex(records: Iterable<TextSearchRecord> = []): MutableTextSearchIndex {
  return new InMemoryTextSearchIndex(records);
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
    const analysis = analyzeTextSearchQuery(query);
    return this.candidateIdsForAnalysis(analysis, options);
  }

  private candidateIdsForAnalysis(analysis: TextSearchQueryAnalysis, options: TextSearchOptions = {}): Set<string> {
    if (analysis.terms.length === 0) return new Set();
    const candidateSets = analysis.terms
      .map((term) => this.matchingIdsForTerm(term))
      .filter((ids) => ids.size > 0)
      .sort((left, right) => left.size - right.size);
    if (candidateSets.length === 0) return new Set();

    const requiredCount = candidateSets.length === analysis.terms.length ? candidateSets.length : 1;
    let ids = intersectSetList(candidateSets.slice(0, requiredCount));
    if (ids.size === 0 && candidateSets.length > 1) {
      ids = unionSets(candidateSets);
    }

    const limit = options.candidateLimit;
    if (typeof limit !== 'number' || ids.size <= limit) return ids;
    return new Set([...ids].slice(0, limit));
  }

  search(query: string, options: TextSearchOptions = {}): TextSearchResult[] {
    const analysis = analyzeTextSearchQuery(query);
    const candidates = this.candidateIdsForAnalysis(analysis, options);
    const limit = normalizedResultLimit(options.limit);
    if (limit === 0) return [];
    const results: TextSearchResult[] = [];
    for (const id of candidates) {
      const record = this.records.get(id);
      const score = record ? this.scoreIndexedRecord(record, analysis, false) : null;
      if (!score) continue;
      results.push(score);
    }
    const sorted = results.sort(compareTextSearchResults);
    const limited = limit === null ? sorted : sorted.slice(0, limit);
    if (options.includeSnippets === false) return limited;
    return limited.map((result) => {
      const record = this.records.get(result.id);
      return record ? { ...result, snippet: buildTextSearchSnippet(record.fields, analysis) } : result;
    });
  }

  scoreRecord(id: string, query: string, options: TextSearchScoreOptions = {}): TextSearchScore | null {
    const analysis = analyzeTextSearchQuery(query);
    return this.scoreAnalyzedRecord(id, analysis, options);
  }

  scoreAnalyzedRecord(
    id: string,
    analysis: TextSearchQueryAnalysis,
    options: TextSearchScoreOptions = {},
  ): TextSearchScore | null {
    const record = this.records.get(id);
    if (!record) return null;
    return this.scoreIndexedRecord(record, analysis, options.includeSnippet !== false);
  }

  private scoreIndexedRecord(
    record: IndexedRecord,
    analysis: TextSearchQueryAnalysis,
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
      snippet: includeSnippet ? buildTextSearchSnippet(record.fields, analysis) : '',
    };
  }

  private matchingIdsForTerm(term: string): Set<string> {
    const exact = idsForPosting(this.postings.get(term));
    if (exact.size >= this.records.size) return exact;
    const prefix = this.prefixMatchingIds(term);
    const tokenMatches = unionSets([exact, prefix]);
    if (isTextSearchGramTerm(term) || textSearchTextHasCjk(term) || term.length < 3) return tokenMatches;
    if (tokenMatches.size >= this.records.size) return tokenMatches;
    return unionSets([tokenMatches, this.trigramMatchingIds(term)]);
  }

  private prefixMatchingIds(term: string): Set<string> {
    if (!isTextSearchPrefixIndexableTerm(term)) return new Set();
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
    const grams = tokenizeSearchText(term).filter(isTextSearchGramTerm);
    if (grams.length === 0) return new Set();
    const sets = grams
      .map((gram) => idsForPosting(this.postings.get(gram)))
      .filter((ids) => ids.size > 0)
      .sort((left, right) => left.size - right.size);
    if (sets.length !== grams.length) return new Set();
    return intersectSetList(sets);
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
        .filter(isTextSearchPrefixIndexableToken)
        .sort();
    }
    return this.sortedPrefixTerms;
  }
}

function indexRecord(record: TextSearchRecord): IndexedRecord | null {
  const fields = record.fields
    .map((field): IndexedField | null => {
      const { normalized, tokens } = analyzeTextSearchField(field.text);
      if (!normalized) return null;
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
  analysis: TextSearchQueryAnalysis,
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
  if (isTextSearchGramTerm(term)) return false;
  return record.fields.some((field) =>
    fieldHasTokenPrefix(field, term)
    || (canTextSearchMatchMidWordSubstring(term) && field.normalized.includes(term)));
}

function fieldMatchesPhrase(field: IndexedField, analysis: TextSearchQueryAnalysis): boolean {
  if (isShortLatinSingleTermTextSearchQuery(analysis)) return fieldHasTokenPrefix(field, analysis.terms[0]!);
  return field.normalized.includes(analysis.normalized);
}

function fieldHasTokenPrefix(field: IndexedField, term: string): boolean {
  return field.tokens.some((token) => !isTextSearchGramTerm(token) && token.startsWith(term));
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

function normalizedResultLimit(limit: number | undefined): number | null {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return null;
  return Math.max(0, Math.trunc(limit));
}

function compareTextSearchResults(left: TextSearchResult, right: TextSearchResult): number {
  return right.score - left.score || left.id.localeCompare(right.id);
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
