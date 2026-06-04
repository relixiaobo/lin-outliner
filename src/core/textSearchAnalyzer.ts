export interface TextSearchQueryAnalysis {
  normalized: string;
  terms: string[];
  hasCjk: boolean;
}

export interface TextSearchFieldAnalysis {
  normalized: string;
  tokens: string[];
}

export interface TextSearchSnippetField {
  normalized: string;
}

export interface TextSearchSnippetOptions {
  beforeChars?: number;
  afterChars?: number;
}

export type TextSearchLabelMatchKind = 'empty' | 'exact' | 'prefix' | 'word-prefix' | 'contains';

export interface TextSearchLabelRank {
  rank: number;
  kind: TextSearchLabelMatchKind;
  index: number;
  normalizedLabel: string;
  normalizedQuery: string;
}

export const TEXT_SEARCH_GRAM_PREFIX = '$gram:';

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
const LABEL_WORD_RE = /(?:^|[\s._/-]+)([^\s._/-]+)/g;
const MIN_PREFIX_LENGTH = 2;
const MAX_PREFIX_LENGTH = 16;

let cachedSegmenter: Intl.Segmenter | null | undefined;

export function normalizeSearchText(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function analyzeTextSearchField(text: string): TextSearchFieldAnalysis {
  const normalized = normalizeSearchText(text);
  return {
    normalized,
    tokens: normalized ? tokenizeSearchText(normalized) : [],
  };
}

export function analyzeTextSearchQuery(query: string): TextSearchQueryAnalysis {
  const normalized = normalizeSearchText(query);
  if (!normalized) return { normalized: '', terms: [], hasCjk: false };
  const rawTerms = uniqueTextSearchTerms(tokenizeSearchText(normalized));
  const wordTerms = rawTerms.filter((term) => !isTextSearchGramTerm(term));
  const nonStopTerms = wordTerms.filter((term) => !STOP_WORDS.has(term));
  const terms = nonStopTerms.length > 0 ? nonStopTerms : wordTerms;
  return {
    normalized,
    terms,
    hasCjk: textSearchTextHasCjk(normalized),
  };
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

export function uniqueTextSearchTerms(terms: Iterable<string>): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const term of terms) {
    if (!term || seen.has(term)) continue;
    seen.add(term);
    result.push(term);
  }
  return result;
}

export function textSearchTextHasCjk(text: string): boolean {
  return CJK_CHAR_RE.test(text);
}

export function isTextSearchGramTerm(term: string): boolean {
  return term.startsWith(TEXT_SEARCH_GRAM_PREFIX);
}

export function isTextSearchPrefixIndexableToken(token: string): boolean {
  return token.length > MIN_PREFIX_LENGTH
    && !isTextSearchGramTerm(token)
    && !textSearchTextHasCjk(token);
}

export function isTextSearchPrefixIndexableTerm(term: string): boolean {
  return term.length >= MIN_PREFIX_LENGTH
    && term.length <= MAX_PREFIX_LENGTH
    && !isTextSearchGramTerm(term)
    && !textSearchTextHasCjk(term);
}

export function canTextSearchMatchMidWordSubstring(term: string): boolean {
  return term.length >= 3 || textSearchTextHasCjk(term);
}

export function isShortLatinSingleTermTextSearchQuery(analysis: TextSearchQueryAnalysis): boolean {
  const term = analysis.terms[0];
  return analysis.terms.length === 1
    && term === analysis.normalized
    && term.length < 3
    && !textSearchTextHasCjk(term);
}

export function buildTextSearchSnippet(
  fields: readonly TextSearchSnippetField[],
  analysis: TextSearchQueryAnalysis,
  options: TextSearchSnippetOptions = {},
): string {
  const field = bestSnippetField(fields, analysis);
  if (!field) return '';
  const beforeChars = options.beforeChars ?? 60;
  const afterChars = options.afterChars ?? 80;
  const exactIndex = field.normalized.indexOf(analysis.normalized);
  const term = analysis.terms.find((value) => field.normalized.includes(value));
  const index = exactIndex >= 0 ? exactIndex : term ? field.normalized.indexOf(term) : 0;
  const matchedLength = Math.max(analysis.normalized.length, term?.length ?? 0);
  const start = Math.max(0, index - beforeChars);
  const end = Math.min(field.normalized.length, index + matchedLength + afterChars);
  return `${start > 0 ? '...' : ''}${field.normalized.slice(start, end)}${end < field.normalized.length ? '...' : ''}`;
}

export function textSearchTextMatchesQuery(normalizedText: string, analysis: TextSearchQueryAnalysis): boolean {
  if (!normalizedText || !analysis.normalized || analysis.terms.length === 0) return false;
  if (normalizedText.includes(analysis.normalized)) return true;
  if (analysis.hasCjk) return false;
  return analysis.terms.every((term) => normalizedText.includes(term));
}

export function rankTextSearchLabel(label: string, query: string): TextSearchLabelRank | null {
  const normalizedLabel = normalizeSearchText(label);
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) {
    return { rank: 0, kind: 'empty', index: 0, normalizedLabel, normalizedQuery };
  }
  if (!normalizedLabel) return null;
  if (normalizedLabel === normalizedQuery) {
    return { rank: 0, kind: 'exact', index: 0, normalizedLabel, normalizedQuery };
  }
  if (normalizedLabel.startsWith(normalizedQuery)) {
    return { rank: 1, kind: 'prefix', index: 0, normalizedLabel, normalizedQuery };
  }
  const wordPrefixIndex = labelWordPrefixIndex(normalizedLabel, normalizedQuery);
  if (wordPrefixIndex >= 0) {
    return { rank: 2, kind: 'word-prefix', index: wordPrefixIndex, normalizedLabel, normalizedQuery };
  }
  const containsIndex = normalizedLabel.indexOf(normalizedQuery);
  if (containsIndex >= 0) {
    return { rank: 3, kind: 'contains', index: containsIndex, normalizedLabel, normalizedQuery };
  }
  return null;
}

function bestSnippetField(
  fields: readonly TextSearchSnippetField[],
  analysis: TextSearchQueryAnalysis,
): TextSearchSnippetField | undefined {
  const phrase = fields.find((field) => field.normalized.includes(analysis.normalized));
  if (phrase) return phrase;
  return fields.find((field) => analysis.terms.some((term) => field.normalized.includes(term)))
    ?? fields[0];
}

function labelWordPrefixIndex(label: string, query: string): number {
  for (const match of label.matchAll(LABEL_WORD_RE)) {
    const word = match[1] ?? '';
    if (!word.startsWith(query)) continue;
    return match.index + match[0].length - word.length;
  }
  return -1;
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
    if (!value || textSearchTextHasCjk(value)) continue;
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
    if (value.length < 3 || textSearchTextHasCjk(value)) continue;
    for (let index = 0; index < value.length - 2; index += 1) {
      terms.push(`${TEXT_SEARCH_GRAM_PREFIX}${value.slice(index, index + 3)}`);
    }
  }
}
