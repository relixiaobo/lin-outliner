import { describe, expect, test } from 'bun:test';
import { startupIssue } from '../../src/main/startupIssue';
import { describeOutlineStartupFailure, readOutlineStartupFailure } from '../../src/outline/contract/startupFailure';

describe('startup issue evidence', () => {
  test('classifies observed codes without interpreting error prose', () => {
    for (const [code, category] of [
      ['EACCES', 'permission'], ['ENOSPC', 'storage-full'], ['SQLITE_BUSY', 'locked'],
      ['SQLITE_NOTADB', 'invalid-data'], ['STARTUP_INVALID_DATA', 'invalid-data'],
    ]) {
      expect(startupIssue('agent', Object.assign(new Error('Fixture'), { code })).category).toBe(category);
    }
    expect(startupIssue('agent', Object.assign(new Error('SQLite fixture'), { code: 'ERR_SQLITE_ERROR', errcode: 26 })).category).toBe('invalid-data');
    expect(startupIssue('agent', new Error('Unsupported version; delete the database')).category).toBe('unknown');
    const failure = Object.assign(new Error('Known mismatch'), { code: 'STARTUP_VERSION_MISMATCH', found: 1, expected: 3 });
    expect(startupIssue('outline-documents', readOutlineStartupFailure(describeOutlineStartupFailure(failure))))
      .toMatchObject({ category: 'version-mismatch', format: { found: 1, expected: 3 }, actions: ['copy-details'] });
  });

  test('keeps original cause, scrubs details, and names only an owner-selected source', () => {
    const failure = Object.assign(new Error('Denied\n-----BEGIN PRIVATE KEY-----\nprivate material\n'), { code: 'EACCES' });
    const issue = startupIssue('agent', new AggregateError([failure, new Error('Cleanup failed')], 'Owner failed', { cause: failure }));
    expect(issue.category).toBe('permission');
    expect(issue.details).not.toContain('private material');
    expect(issue.message).not.toContain('private material');
    expect(issue.actions).toEqual(['copy-details']);
    expect(issue.source).toBeUndefined();
    expect(startupIssue('provider-configuration', new Error('Invalid source'), 'preferences'))
      .toMatchObject({ source: 'preferences', actions: ['copy-details', 'open-source'] });
    expect(startupIssue('agent', new Error('x'.repeat(40_000))).details.length).toBeLessThan(8_001);
  });
});
