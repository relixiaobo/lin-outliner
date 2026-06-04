import { describe, expect, test } from 'bun:test';
import {
  createTextSearchIndex,
  tokenizeSearchText,
  type TextSearchRecord,
} from '../../src/core/textSearchIndex';

function record(id: string, fields: TextSearchRecord['fields']): TextSearchRecord {
  return { id, kind: 'node', fields };
}

describe('text search index', () => {
  test('ranks exact title above prefix phrase and field-only matches', () => {
    const index = createTextSearchIndex([
      record('exact', [{ key: 'title', text: 'Launch Plan' }]),
      record('prefix', [{ key: 'title', text: 'Launch Plan Review' }]),
      record('description', [{ key: 'description', text: 'Launch plan details' }]),
      record('field', [{ key: 'fieldValue', text: 'Launch plan' }]),
    ]);

    expect(index.search('launch plan').map((result) => result.id)).toEqual([
      'exact',
      'prefix',
      'description',
      'field',
    ]);
  });

  test('matches CJK substrings without accepting split n-gram false positives', () => {
    const index = createTextSearchIndex([
      record('phrase', [{ key: 'title', text: '成都天气预报' }]),
      record('split', [
        { key: 'title', text: '成都项目' },
        { key: 'description', text: '天气归档' },
      ]),
    ]);

    expect(index.search('成都天气').map((result) => result.id)).toEqual(['phrase']);
  });

  test('requires all query terms unless the full phrase matches', () => {
    const index = createTextSearchIndex([
      record('alpha', [{ key: 'title', text: 'Alpha project' }]),
      record('beta', [{ key: 'title', text: 'Beta launch' }]),
      record('both', [{ key: 'title', text: 'Alpha beta' }]),
    ]);

    expect(index.search('alpha beta').map((result) => result.id)).toEqual(['both']);
    expect(index.search('alpha gamma').map((result) => result.id)).toEqual([]);
    expect(index.scoreRecord('alpha', 'alpha gamma')).toBeNull();
  });

  test('uses indexed prefix lookup for short Latin prefixes', () => {
    const index = createTextSearchIndex([
      record('launch', [{ key: 'title', text: 'Launch plan' }]),
      record('archive', [{ key: 'title', text: 'Archive plan' }]),
    ]);

    expect(index.candidateIds('la')).toContain('launch');
    expect(index.search('la').map((result) => result.id)).toEqual(['launch']);
    expect(index.search('ar').map((result) => result.id)).toEqual(['archive']);
  });

  test('keeps prefix lookup fresh across incremental updates', () => {
    const index = createTextSearchIndex([
      record('node', [{ key: 'title', text: 'Launch plan' }]),
    ]);

    expect(index.search('la').map((result) => result.id)).toEqual(['node']);
    index.upsert(record('node', [{ key: 'title', text: 'Archive plan' }]));
    expect(index.search('la').map((result) => result.id)).toEqual([]);
    expect(index.search('ar').map((result) => result.id)).toEqual(['node']);
    index.remove('node');
    expect(index.search('ar').map((result) => result.id)).toEqual([]);
  });

  test('keeps mid-word substring recall when another record has a prefix match', () => {
    const index = createTextSearchIndex([
      record('category', [{ key: 'title', text: 'Category list' }]),
      record('scatter', [{ key: 'title', text: 'Scatter plan' }]),
    ]);

    expect(index.candidateIds('cat')).toEqual(new Set(['category', 'scatter']));
    expect(index.scoreRecord('scatter', 'cat')?.score).toBeGreaterThan(0);
    expect(index.search('cat').map((result) => result.id)).toEqual(['category', 'scatter']);
  });

  test('keeps short Latin search prefix-oriented', () => {
    const index = createTextSearchIndex([
      record('launch', [{ key: 'title', text: 'Launch plan' }]),
    ]);

    expect(index.scoreRecord('launch', 'la')?.score).toBeGreaterThan(0);
    expect(index.scoreRecord('launch', 'au')).toBeNull();
    expect(index.search('au')).toEqual([]);
  });

  test('returns deterministic top-k results without changing ranking order', () => {
    const index = createTextSearchIndex([
      record('exact', [{ key: 'title', text: 'Launch' }]),
      record('prefix', [{ key: 'title', text: 'Launch review' }]),
      record('body', [{ key: 'body', text: 'Launch notes' }]),
      record('field', [{ key: 'fieldValue', text: 'Launch' }]),
    ]);

    const full = index.search('launch').map((result) => result.id);
    expect(index.search('launch', { limit: 2 }).map((result) => result.id)).toEqual(full.slice(0, 2));
    expect(index.search('launch', { limit: 0 })).toEqual([]);
  });

  test('updates postings and corpus stats incrementally', () => {
    const index = createTextSearchIndex([
      record('one', [{ key: 'title', text: 'Alpha project' }]),
      record('two', [{ key: 'title', text: 'Beta project' }]),
    ]);

    expect(index.search('Gamma').map((result) => result.id)).toEqual([]);
    index.upsert(record('two', [{ key: 'title', text: 'Gamma project' }]));
    expect(index.search('Gamma').map((result) => result.id)).toEqual(['two']);
    expect(index.search('Beta').map((result) => result.id)).toEqual([]);
    index.remove('two');
    expect(index.search('Gamma').map((result) => result.id)).toEqual([]);
    expect(index.search('Alpha').map((result) => result.id)).toEqual(['one']);
  });

  test('normalizes tokenizer output independent of runtime punctuation quirks', () => {
    const tokens = tokenizeSearchText('foo_bar-baz.qux 成都天气');
    expect(tokens).toContain('foo_bar');
    expect(tokens).toContain('baz');
    expect(tokens).toContain('qux');
    expect(tokens).not.toContain('baz.qux');
    expect(tokens).toEqual(expect.arrayContaining(['成都', '都天', '天气']));
  });
});
