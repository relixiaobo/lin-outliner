import { describe, expect, test } from 'bun:test';
import {
  TEXT_SEARCH_GRAM_PREFIX,
  analyzeTextSearchField,
  analyzeTextSearchQuery,
  buildTextSearchSnippet,
  canTextSearchMatchMidWordSubstring,
  isShortLatinSingleTermTextSearchQuery,
  isTextSearchGramTerm,
  isTextSearchPrefixIndexableTerm,
  normalizeSearchText,
  rankTextSearchLabel,
  textSearchTextHasCjk,
  textSearchTextMatchesQuery,
  tokenizeSearchText,
} from '../../src/core/textSearchAnalyzer';

describe('text search analyzer', () => {
  test('normalizes text and analyzes field tokens consistently', () => {
    expect(normalizeSearchText('  Ｆｏｏ\n\tBAR  ')).toBe('foo bar');

    const field = analyzeTextSearchField('foo_bar-baz.qux 成都天气');
    expect(field.normalized).toBe('foo_bar-baz.qux 成都天气');
    expect(field.tokens).toEqual(expect.arrayContaining([
      'foo_bar',
      'baz',
      'qux',
      '成都',
      '都天',
      '天气',
      `${TEXT_SEARCH_GRAM_PREFIX}foo`,
    ]));
  });

  test('filters stop words only when meaningful terms remain', () => {
    expect(analyzeTextSearchQuery('the launch and plan').terms).toEqual(['launch', 'plan']);
    expect(analyzeTextSearchQuery('the and').terms).toEqual(['the', 'and']);
  });

  test('keeps CJK phrase analysis explicit for verification', () => {
    const analysis = analyzeTextSearchQuery('成都天气');
    expect(analysis).toEqual({
      normalized: '成都天气',
      terms: ['成都', '都天', '天气'],
      hasCjk: true,
    });
    expect(textSearchTextHasCjk('launch')).toBe(false);
    expect(textSearchTextHasCjk('天气')).toBe(true);
    expect(textSearchTextMatchesQuery(normalizeSearchText('成都天气预报'), analysis)).toBe(true);
    expect(textSearchTextMatchesQuery(normalizeSearchText('成都项目 天气归档'), analysis)).toBe(false);
  });

  test('matches Latin text by full phrase or verified all-term fallback', () => {
    const analysis = analyzeTextSearchQuery('sqlite checkpoint');
    expect(textSearchTextMatchesQuery(normalizeSearchText('sqlite checkpoint strategy'), analysis)).toBe(true);
    expect(textSearchTextMatchesQuery(normalizeSearchText('checkpoint strategy for sqlite'), analysis)).toBe(true);
    expect(textSearchTextMatchesQuery(normalizeSearchText('sqlite strategy'), analysis)).toBe(false);
  });

  test('exposes prefix and substring guards used by retrieval indexes', () => {
    expect(isTextSearchPrefixIndexableTerm('la')).toBe(true);
    expect(isTextSearchPrefixIndexableTerm('l')).toBe(false);
    expect(isTextSearchPrefixIndexableTerm('averyverylongqueryterm')).toBe(false);
    expect(isTextSearchPrefixIndexableTerm('天气')).toBe(false);
    expect(isTextSearchGramTerm(`${TEXT_SEARCH_GRAM_PREFIX}foo`)).toBe(true);

    expect(canTextSearchMatchMidWordSubstring('au')).toBe(false);
    expect(canTextSearchMatchMidWordSubstring('cat')).toBe(true);
    expect(canTextSearchMatchMidWordSubstring('天气')).toBe(true);
    expect(isShortLatinSingleTermTextSearchQuery(analyzeTextSearchQuery('la'))).toBe(true);
    expect(isShortLatinSingleTermTextSearchQuery(analyzeTextSearchQuery('天气'))).toBe(false);
  });

  test('builds snippets from the best matching normalized field', () => {
    const analysis = analyzeTextSearchQuery('launch plan');
    const snippet = buildTextSearchSnippet([
      { normalized: normalizeSearchText('unrelated introduction') },
      { normalized: normalizeSearchText('alpha beta launch plan in body with extra context') },
    ], analysis, { beforeChars: 5, afterChars: 5 });

    expect(snippet).toContain('launch plan');
    expect(snippet.startsWith('...')).toBe(true);
    expect(snippet.endsWith('...')).toBe(true);
  });

  test('ranks labels by exact prefix word-prefix then contains', () => {
    expect(rankTextSearchLabel('Launch', 'launch')?.kind).toBe('exact');
    expect(rankTextSearchLabel('Launch Plan', 'launch')?.kind).toBe('prefix');
    expect(rankTextSearchLabel('Project Launch Plan', 'launch')?.kind).toBe('word-prefix');
    expect(rankTextSearchLabel('Project / Launch Plan', 'launch')?.index).toBe(10);
    expect(rankTextSearchLabel('Prelaunch Notes', 'launch')?.kind).toBe('contains');
    expect(rankTextSearchLabel('Archive', 'launch')).toBeNull();
    expect(rankTextSearchLabel('Archive', '')?.kind).toBe('empty');
  });

  test('keeps tokenizer output independent of runtime punctuation quirks', () => {
    const tokens = tokenizeSearchText('foo_bar-baz.qux 成都天气');
    expect(tokens).toContain('foo_bar');
    expect(tokens).toContain('baz');
    expect(tokens).toContain('qux');
    expect(tokens).not.toContain('baz.qux');
    expect(tokens).toEqual(expect.arrayContaining(['成都', '都天', '天气']));
  });
});
