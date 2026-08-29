import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repositoryRoot = join(import.meta.dir, '../..');

function source(path: string): string {
  return readFileSync(join(repositoryRoot, path), 'utf8');
}

describe('Agent input-history cutover guards', () => {
  test('keeps canonical input authors strict with no persisted compatibility path', () => {
    const protocol = source('src/core/agent/protocol.ts');
    const codec = source('src/core/agent/codec.ts');
    const persistence = [
      source('src/main/agent/persistence/RolloutStore.ts'),
      source('src/main/agent/persistence/ThreadHistoryProjectionStore.ts'),
    ].join('\n');
    const authorUnion = protocol.slice(
      protocol.indexOf('export type ThreadInputAuthor ='),
      protocol.indexOf('export type PrivilegedThreadInputAuthor ='),
    );
    const authorDecoder = codec.slice(
      codec.indexOf('function decodeThreadInputAuthor('),
      codec.indexOf('function decodePrivilegedThreadInputAuthor('),
    );

    expect(authorUnion).toContain("{ readonly kind: 'reader' }");
    expect(authorUnion).toContain("{ readonly kind: 'agent'; readonly threadId: ThreadId }");
    expect(authorUnion).toContain("{ readonly kind: 'host' }");
    expect(authorUnion).toContain("readonly kind: 'feature'");
    expect(authorUnion).not.toContain("kind: 'unknown'");
    expect(authorDecoder).not.toContain("'unknown'");

    for (const retiredIdentifier of [
      'ThreadItemDecodeMode',
      'decodePersistedThreadItem',
      'decodePersistedAgentCoreRecordedNotification',
      'decodeThreadItemWithMode',
    ]) {
      expect(`${codec}\n${persistence}`).not.toContain(retiredIdentifier);
    }
    expect(`${codec}\n${persistence}`).not.toMatch(/record\.author\s*===\s*undefined/u);
  });

  test('keeps the manual reset outside application startup', () => {
    const startup = [
      source('src/main/main.ts'),
      source('src/main/userDataPath.ts'),
    ].join('\n');

    expect(startup).not.toMatch(/\b(?:rm|rmdir|unlink)(?:Sync)?\s*\(/u);
    expect(startup).not.toContain('decodePersistedThreadItem');
  });

  test('keeps managed content opaque and structured inside history modules', () => {
    const resourceRegistry = source('src/renderer/agent/composerHistoryResourceRegistry.ts');
    const historyModules = [
      source('src/renderer/agent/threadComposerHistory.ts'),
      resourceRegistry,
    ].join('\n');

    expect(resourceRegistry).not.toMatch(/(?:ref|handle)\.id\b/u);
    expect(resourceRegistry).not.toContain('JSON.stringify');
    expect(historyModules).not.toMatch(/\b(?:readFile|writeFile|copyFile|mkdir|createHash)\b/u);
    expect(historyModules).not.toMatch(/(?:parseReference|referenceMarkup|kind:label\^value|file:\^)/u);
    expect(historyModules).not.toMatch(/(?:localStorage|sessionStorage|indexedDB)/u);
  });
});
