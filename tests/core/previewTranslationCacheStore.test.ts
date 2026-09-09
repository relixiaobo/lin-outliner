import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import * as filesystem from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  PreviewTranslationCacheStore as CacheStore,
  type PreviewTranslationCacheBlock,
  type PreviewTranslationCacheScope,
  type PreviewTranslationCacheOperation,
} from '../../src/main/previewTranslationCacheStore';

let tempDir: string | null = null;

class PreviewTranslationCacheStore extends CacheStore {
  override async lookup(...args: Parameters<CacheStore['lookup']>) {
    const ticket = this.beginWrite(args[0].sourceId);
    return { ...await super.lookup(...args), ticket };
  }
}

const block = (overrides: Partial<PreviewTranslationCacheBlock> = {}): PreviewTranslationCacheBlock => ({
  cacheKey: 'page:block:1',
  id: 'b1',
  text: 'Private source phrase.',
  ...overrides,
});

const scope = (overrides: Partial<PreviewTranslationCacheScope> = {}): PreviewTranslationCacheScope => ({
  contentKind: 'page',
  modelIdentity: 'provider:openai:model:gpt-4.1-mini',
  promptRevision: 1,
  sourceId: 'https://private.example.test/article?account=secret',
  targetLanguage: 'zh-Hans',
  ...overrides,
});

async function makeRoot(): Promise<string> {
  tempDir = await mkdtemp(path.join(tmpdir(), 'tenon-preview-translation-cache-'));
  return path.join(tempDir, 'preview-translation-cache');
}

afterEach(async () => {
  if (!tempDir) return;
  await rm(tempDir, { force: true, recursive: true });
  tempDir = null;
});

describe('PreviewTranslationCacheStore', () => {
  for (const boundary of ['index', 'shard', 'directory'] as const) {
    test(`preserves saved bytes and pending writes after ${boundary} I/O failure`, async () => {
      const root = await makeRoot();
      const original = new CacheStore(root, { flushDelayMs: 60_000 });
      const ticket = original.beginWrite(scope().sourceId);
      await original.record(scope(), [block()], [{ id: 'b1', translation: 'Saved' }], ticket);
      original.releaseWrite(ticket);
      await original.flushNow();
      const names = (await readdir(root)).sort();
      const before = await Promise.all(names.map((name) => readFile(path.join(root, name), 'utf8')));
      const target = boundary === 'index' ? 'index.json' : names.find((name) => name !== 'index.json')!;
      const read = filesystem.readFile;
      const enumerate = filesystem.readdir;
      const fault = Object.assign(new Error('Injected I/O failure'), { code: 'EACCES' });
      const spy = boundary === 'directory'
        ? spyOn(filesystem, 'readdir').mockImplementation((...args: any[]) => {
          if (String(args[0]) === root) return Promise.reject(fault) as any;
          return (enumerate as any)(...args);
        })
        : spyOn(filesystem, 'readFile').mockImplementation((...args: any[]) => {
          if (String(args[0]) === path.join(root, target)) return Promise.reject(fault) as any;
          return (read as any)(...args);
        });
      const reopened = new CacheStore(root, { flushDelayMs: 60_000 });
      try {
        await expect(reopened.lookup(scope(), [block()])).rejects.toBe(fault);
        await reopened.flushNow().catch(() => undefined);
        expect((await enumerate(root)).sort()).toEqual(names);
        expect(await Promise.all(names.map((name) => read(path.join(root, name), 'utf8')))).toEqual(before);
      } finally {
        spy.mockRestore();
      }
      expect((await reopened.lookup(scope(), [block()])).hits).toEqual([{ id: 'b1', translation: 'Saved' }]);
      await reopened.flushNow();
    });
  }

  test('rejects mismatched persisted source metadata instead of returning its translations', async () => {
    const root = await makeRoot();
    const store = new CacheStore(root, { flushDelayMs: 60_000 });
    const ticket = store.beginWrite(scope().sourceId);
    await store.record(scope(), [block()], [{ id: 'b1', translation: 'Saved' }], ticket);
    store.releaseWrite(ticket);
    await store.flushNow();
    const shardName = (await readdir(root)).find((name) => name.endsWith('.json') && name !== 'index.json')!;
    const shardPath = path.join(root, shardName);
    const shard = JSON.parse(await readFile(shardPath, 'utf8'));
    shard.sourceDigest = '0'.repeat(64);
    await writeFile(shardPath, JSON.stringify(shard));
    const reopened = new CacheStore(root, { flushDelayMs: 60_000 });
    expect((await reopened.lookup(scope(), [block()])).hits).toEqual([]);
    await reopened.flushNow();
    expect((await reopened.inspect()).entries.page).toBe(0);
  });

  test('content deletion failure is reported and still fences old writes', async () => {
    const root = await makeRoot();
    const store = new CacheStore(root, { flushDelayMs: 60_000 });
    const ticket = store.beginWrite(scope().sourceId);
    await store.record(scope(), [block()], [{ id: 'b1', translation: 'Saved' }], ticket);
    await store.flushNow();
    const shardName = (await readdir(root)).find((name) => name.endsWith('.json') && name !== 'index.json')!;
    const shardPath = path.join(root, shardName);
    await rm(shardPath);
    await mkdir(shardPath);
    await expect(store.clearSource(scope().sourceId)).rejects.toThrow('clear failed');
    expect(await store.record(scope(), [block()], [{ id: 'b1', translation: 'Late' }], ticket)).toBe(false);
    store.releaseWrite(ticket);
    await store.clear();
    expect((await store.inspect()).entries.page).toBe(0);
  });

  test('clears every cold variant of one content source without evicting another source', async () => {
    const root = await makeRoot();
    const first = new CacheStore(root, { flushDelayMs: 60_000 });
    for (const contentKind of ['page', 'caption', 'document'] as const) {
      for (const sourceId of ['selected', 'other']) {
        const selected = scope({ contentKind, sourceId });
        const ticket = first.beginWrite(sourceId);
        await first.record(selected, [block()], [{ id: 'b1', translation: 'Saved output' }], ticket);
        first.releaseWrite(ticket);
      }
    }
    await first.flushNow();
    const reloaded = new CacheStore(root, { flushDelayMs: 60_000 });
    const oldSelected = reloaded.beginWrite('selected');
    const oldOther = reloaded.beginWrite('other');
    await reloaded.clearSource('selected');
    expect((await reloaded.inspect()).entries).toEqual({ page: 1, caption: 1, document: 1 });
    expect(await reloaded.record(scope({ sourceId: 'selected' }), [block()], [{ id: 'b1', translation: 'Late' }], oldSelected)).toBe(false);
    expect(await reloaded.record(scope({ sourceId: 'other' }), [block()], [{ id: 'b1', translation: 'Still current' }], oldOther)).toBe(true);
    reloaded.releaseWrite(oldSelected);
    reloaded.releaseWrite(oldOther);
    await reloaded.flushNow();
    const restarted = new CacheStore(root, { flushDelayMs: 60_000 });
    for (const contentKind of ['page', 'caption', 'document'] as const) {
      expect((await restarted.lookup(scope({ contentKind, sourceId: 'selected' }), [block()])).hits).toEqual([]);
      expect((await restarted.lookup(scope({ contentKind, sourceId: 'other' }), [block()])).hits).toHaveLength(1);
    }
    await restarted.clear();
    expect((await restarted.inspect()).entries).toEqual({ page: 0, caption: 0, document: 0 });
  });

  test('rechecks authority in the serialized clear queue and rejects released or foreign tickets', async () => {
    const store = new CacheStore(await makeRoot(), { flushDelayMs: 60_000 });
    const ticket = store.beginWrite(scope().sourceId);
    await store.record(scope(), [block()], [{ id: 'b1', translation: 'Saved' }], ticket);
    await expect(store.clearSource(scope().sourceId, async () => { throw new Error('Revoked'); })).rejects.toThrow('Revoked');
    expect((await store.lookup(scope(), [block()])).hits).toHaveLength(1);
    store.releaseWrite(ticket);
    expect(await store.record(scope(), [block()], [{ id: 'b1', translation: 'Late' }], ticket)).toBe(false);
    expect(await store.record(scope(), [block()], [{ id: 'b1', translation: 'Forged' }], { sourceDigest: ticket.sourceDigest })).toBe(false);
  });
  test('round-trips private opaque cache shards without persisting source identity or text', async () => {
    const root = await makeRoot();
    const store = new PreviewTranslationCacheStore(root, { flushDelayMs: 60_000 });
    const first = await store.lookup(scope(), [block()]);

    expect(first.hits).toEqual([]);
    expect(await store.record(
      scope(),
      [block()],
      [{ id: 'b1', translation: '私密译文。' }],
      first.ticket,
    )).toBe(true);
    await store.flushNow();

    const names = (await readdir(root)).sort();
    expect(names).toHaveLength(2);
    expect(names).toContain('index.json');
    const shardName = names.find((name) => name !== 'index.json');
    expect(shardName).toMatch(/^[a-f0-9]{64}\.json$/u);
    const raw = await Promise.all(names.map((name) => readFile(path.join(root, name), 'utf8')));
    const persisted = raw.join('\n');
    expect(persisted).toContain('私密译文。');
    expect(persisted).not.toContain('Private source phrase');
    expect(persisted).not.toContain('private.example.test');
    expect(persisted).not.toContain('gpt-4.1-mini');
    if (process.platform !== 'win32') {
      expect((await stat(root)).mode & 0o777).toBe(0o700);
      for (const name of names) expect((await stat(path.join(root, name))).mode & 0o777).toBe(0o600);
    }

    const reloaded = new PreviewTranslationCacheStore(root, { flushDelayMs: 60_000 });
    expect((await reloaded.lookup(scope(), [block()])).hits).toEqual([
      { id: 'b1', translation: '私密译文。' },
    ]);
  });

  test('isolates entries by source, target, resolved model, content kind, prompt revision, key, and text', async () => {
    const root = await makeRoot();
    const store = new PreviewTranslationCacheStore(root, { flushDelayMs: 60_000 });
    const initial = await store.lookup(scope(), [block()]);
    await store.record(scope(), [block()], [{ id: 'b1', translation: '命中' }], initial.ticket);

    expect((await store.lookup(scope(), [block()])).hits).toHaveLength(1);
    for (const [changedScope, changedBlock] of [
      [scope({ sourceId: 'https://private.example.test/other' }), block()],
      [scope({ targetLanguage: 'ja' }), block()],
      [scope({ modelIdentity: 'provider:openai:model:gpt-5-mini' }), block()],
      [scope({ contentKind: 'caption' }), block()],
      [scope({ promptRevision: 2 }), block()],
      [scope(), block({ cacheKey: 'page:block:2' })],
      [scope(), block({ text: 'Changed source phrase.' })],
    ] as const) {
      expect((await store.lookup(changedScope, [changedBlock])).hits).toEqual([]);
    }
  });

  test('persists validated unchanged output as a cacheable no-op', async () => {
    const root = await makeRoot();
    const store = new PreviewTranslationCacheStore(root, { flushDelayMs: 60_000 });
    const lookup = await store.lookup(scope(), [block()]);
    await store.record(
      scope(),
      [block()],
      [{ id: 'b1', translation: 'Private source phrase.' }],
      lookup.ticket,
    );
    await store.flushNow();

    const persisted = (await Promise.all(
      (await readdir(root)).map((name) => readFile(path.join(root, name), 'utf8')),
    )).join('\n');
    expect(persisted).toContain('"kind":"unchanged"');
    expect(persisted).not.toContain('Private source phrase.');

    const reloaded = new PreviewTranslationCacheStore(root, { flushDelayMs: 60_000 });
    expect((await reloaded.lookup(scope(), [block()])).hits).toEqual([
      { id: 'b1', translation: 'Private source phrase.' },
    ]);
  });

  test('treats corrupt index and shard data as misses with content-free error operations', async () => {
    const root = await makeRoot();
    const store = new PreviewTranslationCacheStore(root, { flushDelayMs: 60_000 });
    const initial = await store.lookup(scope(), [block()]);
    await store.record(scope(), [block()], [{ id: 'b1', translation: '缓存译文' }], initial.ticket);
    await store.flushNow();

    const shardName = (await readdir(root)).find((name) => name !== 'index.json');
    if (!shardName) throw new Error('Missing cache shard');
    await writeFile(path.join(root, shardName), '{broken shard', 'utf8');
    const shardErrors: PreviewTranslationCacheOperation[] = [];
    const corruptShard = new PreviewTranslationCacheStore(root, {
      flushDelayMs: 60_000,
      onError: (operation) => shardErrors.push(operation),
    });
    expect((await corruptShard.lookup(scope(), [block()])).hits).toEqual([]);
    expect(shardErrors).toEqual(['load']);

    await writeFile(path.join(root, 'index.json'), '{broken index', 'utf8');
    const indexErrors: PreviewTranslationCacheOperation[] = [];
    const corruptIndex = new PreviewTranslationCacheStore(root, {
      flushDelayMs: 60_000,
      onError: (operation) => indexErrors.push(operation),
    });
    expect((await corruptIndex.lookup(scope(), [block()])).hits).toEqual([]);
    expect(indexErrors).toEqual(['load']);
  });

  test('evicts least-recently-used entries across source shards at the global entry bound', async () => {
    const root = await makeRoot();
    let now = 1;
    const store = new PreviewTranslationCacheStore(root, {
      flushDelayMs: 60_000,
      maxEntries: 2,
      now: () => now,
    });
    for (const name of ['a', 'b'] as const) {
      const selectedScope = scope({ sourceId: `https://example.test/${name}` });
      const lookup = await store.lookup(selectedScope, [block()]);
      await store.record(selectedScope, [block()], [{ id: 'b1', translation: `Translation ${name}` }], lookup.ticket);
      now += 1;
    }
    await store.flushNow();

    now += 1;
    expect((await store.lookup(scope({ sourceId: 'https://example.test/a' }), [block()])).hits).toHaveLength(1);
    now += 1;
    const scopeC = scope({ sourceId: 'https://example.test/c' });
    const lookupC = await store.lookup(scopeC, [block()]);
    await store.record(scopeC, [block()], [{ id: 'b1', translation: 'Translation c' }], lookupC.ticket);
    await store.flushNow();

    const reloaded = new PreviewTranslationCacheStore(root, { flushDelayMs: 60_000, maxEntries: 2 });
    expect((await reloaded.lookup(scope({ sourceId: 'https://example.test/a' }), [block()])).hits).toHaveLength(1);
    expect((await reloaded.lookup(scope({ sourceId: 'https://example.test/b' }), [block()])).hits).toEqual([]);
    expect((await reloaded.lookup(scopeC, [block()])).hits).toHaveLength(1);
  });

  test('preserves newer entries inside the shard that owns the globally oldest entry', async () => {
    const root = await makeRoot();
    let now = 1;
    const options = { flushDelayMs: 60_000, maxEntries: 3, now: () => now };
    const store = new PreviewTranslationCacheStore(root, options);
    const scopeA = scope({ sourceId: 'scope:a' });
    const scopeB = scope({ sourceId: 'scope:b' });
    const aOld = block({ cacheKey: 'a-old', id: 'a-old', text: 'A old' });
    const aNew = block({ cacheKey: 'a-new', id: 'a-new', text: 'A new' });
    const bFirst = block({ cacheKey: 'b-first', id: 'b-first', text: 'B first' });
    const bSecond = block({ cacheKey: 'b-second', id: 'b-second', text: 'B second' });
    const initialA = await store.lookup(scopeA, [aOld, aNew]);
    const initialB = await store.lookup(scopeB, [bFirst, bSecond]);

    await store.record(scopeA, [aOld], [{ id: aOld.id, translation: 'A old translation' }], initialA.ticket);
    now = 2;
    await store.record(scopeB, [bFirst], [{ id: bFirst.id, translation: 'B first translation' }], initialB.ticket);
    now = 3;
    await store.record(scopeB, [bSecond], [{ id: bSecond.id, translation: 'B second translation' }], initialB.ticket);
    now = 4;
    await store.record(scopeA, [aNew], [{ id: aNew.id, translation: 'A new translation' }], initialA.ticket);
    await store.flushNow();

    const reloaded = new PreviewTranslationCacheStore(root, options);
    expect((await reloaded.lookup(scopeA, [aOld, aNew])).hits).toEqual([
      { id: aNew.id, translation: 'A new translation' },
    ]);
    expect((await reloaded.lookup(scopeB, [bFirst, bSecond])).hits).toEqual([
      { id: bFirst.id, translation: 'B first translation' },
      { id: bSecond.id, translation: 'B second translation' },
    ]);
  });

  test('bounds a single source shard by logical bytes', async () => {
    const root = await makeRoot();
    let now = 1;
    const store = new PreviewTranslationCacheStore(root, {
      flushDelayMs: 60_000,
      maxBytes: 260,
      now: () => now,
    });
    const blocks = [
      block({ cacheKey: 'first', id: 'b1', text: 'First source' }),
      block({ cacheKey: 'second', id: 'b2', text: 'Second source' }),
    ];
    const lookup = await store.lookup(scope(), blocks);
    await store.record(scope(), [blocks[0]!], [{ id: 'b1', translation: 'A'.repeat(100) }], lookup.ticket);
    now += 1;
    await store.record(scope(), [blocks[1]!], [{ id: 'b2', translation: 'B'.repeat(100) }], lookup.ticket);
    await store.flushNow();

    const reloaded = new PreviewTranslationCacheStore(root, { flushDelayMs: 60_000, maxBytes: 260 });
    expect((await reloaded.lookup(scope(), blocks)).hits).toEqual([
      { id: 'b2', translation: 'B'.repeat(100) },
    ]);
  });

  test('bounds a single source shard by entry count', async () => {
    const root = await makeRoot();
    let now = 1;
    const options = {
      flushDelayMs: 60_000,
      maxEntries: 10,
      maxShardEntries: 2,
      now: () => now,
    };
    const store = new PreviewTranslationCacheStore(root, options);
    const blocks = ['first', 'second', 'third'].map((key, index) => block({
      cacheKey: key,
      id: `b${index + 1}`,
      text: `${key} source`,
    }));
    const lookup = await store.lookup(scope(), blocks);
    for (const [index, selectedBlock] of blocks.entries()) {
      now += 1;
      await store.record(
        scope(),
        [selectedBlock!],
        [{ id: selectedBlock!.id, translation: `Translation ${index + 1}` }],
        lookup.ticket,
      );
    }
    await store.flushNow();

    const reloaded = new PreviewTranslationCacheStore(root, options);
    expect((await reloaded.lookup(scope(), blocks)).hits).toEqual([
      { id: 'b2', translation: 'Translation 2' },
      { id: 'b3', translation: 'Translation 3' },
    ]);
  });

  test('drops missing manifest shards before global LRU eviction', async () => {
    const root = await makeRoot();
    let now = 1;
    const options = { flushDelayMs: 60_000, maxEntries: 2, now: () => now };
    const store = new PreviewTranslationCacheStore(root, options);
    const scopeB = scope({ sourceId: 'scope:b' });
    const lookupB = await store.lookup(scopeB, [block()]);
    await store.record(scopeB, [block()], [{ id: 'b1', translation: 'Translation b' }], lookupB.ticket);
    await store.flushNow();
    const firstShard = (await readdir(root)).find((name) => name !== 'index.json');
    if (!firstShard) throw new Error('Missing first cache shard');

    now += 1;
    const scopeA = scope({ sourceId: 'scope:a-missing' });
    const lookupA = await store.lookup(scopeA, [block()]);
    await store.record(scopeA, [block()], [{ id: 'b1', translation: 'Translation a' }], lookupA.ticket);
    await store.flushNow();
    const secondShard = (await readdir(root)).find((name) => name !== 'index.json' && name !== firstShard);
    if (!secondShard) throw new Error('Missing second cache shard');
    await rm(path.join(root, secondShard));

    now += 1;
    const reloaded = new PreviewTranslationCacheStore(root, options);
    expect((await reloaded.lookup(scopeA, [block()])).hits).toEqual([]);
    const scopeC = scope({ sourceId: 'scope:c' });
    const lookupC = await reloaded.lookup(scopeC, [block()]);
    await reloaded.record(scopeC, [block()], [{ id: 'b1', translation: 'Translation c' }], lookupC.ticket);
    await reloaded.flushNow();

    const finalStore = new PreviewTranslationCacheStore(root, options);
    expect((await finalStore.lookup(scopeB, [block()])).hits).toHaveLength(1);
    expect((await finalStore.lookup(scopeC, [block()])).hits).toHaveLength(1);
  });

  test('removes unindexed shards and interrupted temp files during initialization', async () => {
    const root = await makeRoot();
    const store = new PreviewTranslationCacheStore(root, { flushDelayMs: 60_000 });
    const initial = await store.lookup(scope(), [block()]);
    await store.record(scope(), [block()], [{ id: 'b1', translation: 'Translation' }], initial.ticket);
    await store.flushNow();

    const shardName = (await readdir(root)).find((name) => name !== 'index.json');
    if (!shardName) throw new Error('Missing cache shard');
    const shard = await readFile(path.join(root, shardName), 'utf8');
    const orphanName = `${'f'.repeat(64)}.json`;
    await writeFile(path.join(root, orphanName), shard, 'utf8');
    await writeFile(path.join(root, `${shardName}.123.interrupted.tmp`), 'partial', 'utf8');

    const reloaded = new PreviewTranslationCacheStore(root, { flushDelayMs: 60_000 });
    expect((await reloaded.lookup(scope(), [block()])).hits).toHaveLength(1);
    expect((await readdir(root)).sort()).toEqual(['index.json', shardName].sort());
  });

  test('keeps the previously committed cache intact when an overflowing flush fails', async () => {
    const root = await makeRoot();
    let now = 1;
    const options = { flushDelayMs: 60_000, maxEntries: 2, now: () => now };
    const store = new PreviewTranslationCacheStore(root, options);
    for (const name of ['a', 'b'] as const) {
      const selectedScope = scope({ sourceId: `scope:${name}` });
      const lookup = await store.lookup(selectedScope, [block()]);
      await store.record(selectedScope, [block()], [{ id: 'b1', translation: `Translation ${name}` }], lookup.ticket);
      now += 1;
    }
    await store.flushNow();

    const scopeC = scope({ sourceId: 'scope:c' });
    const lookupC = await store.lookup(scopeC, [block()]);
    await store.record(scopeC, [block()], [{ id: 'b1', translation: 'Translation c' }], lookupC.ticket);
    const blockedShardPath = path.join(root, `${scopeDigest(scopeC)}.json`);
    await mkdir(blockedShardPath);
    try {
      await expect(store.flushNow()).rejects.toThrow();
    } finally {
      await rm(blockedShardPath, { force: true, recursive: true });
    }

    const committed = new PreviewTranslationCacheStore(root, options);
    expect((await committed.lookup(scope({ sourceId: 'scope:a' }), [block()])).hits).toHaveLength(1);
    expect((await committed.lookup(scope({ sourceId: 'scope:b' }), [block()])).hits).toHaveLength(1);
    expect((await committed.lookup(scopeC, [block()])).hits).toEqual([]);
    await store.flushNow();

    expect((await readdir(root)).filter((name) => name !== 'index.json')).toHaveLength(2);
  });

  test('uses write tickets so pre-clear provider results cannot repopulate the cache', async () => {
    const root = await makeRoot();
    const store = new PreviewTranslationCacheStore(root, { flushDelayMs: 60_000 });
    const beforeClear = await store.lookup(scope(), [block()]);
    await store.clear();

    expect(await store.record(
      scope(),
      [block()],
      [{ id: 'b1', translation: 'Late result' }],
      beforeClear.ticket,
    )).toBe(false);
    expect((await store.lookup(scope(), [block()])).hits).toEqual([]);

    const afterClear = await store.lookup(scope(), [block()]);
    expect(await store.record(
      scope(),
      [block()],
      [{ id: 'b1', translation: 'Fresh result' }],
      afterClear.ticket,
    )).toBe(true);
    expect((await store.lookup(scope(), [block()])).hits).toEqual([
      { id: 'b1', translation: 'Fresh result' },
    ]);
  });

  test('removes a stale clear tombstone before reporting success', async () => {
    const root = await makeRoot();
    const tombstone = path.join(path.dirname(root), `.${path.basename(root)}.clearing-interrupted`);
    await mkdir(tombstone);
    await writeFile(path.join(tombstone, 'private-cache.json'), 'stale translation', 'utf8');

    const store = new PreviewTranslationCacheStore(root, { flushDelayMs: 60_000 });
    await store.clear();

    expect((await readdir(path.dirname(root))).filter((name) => name.includes('.clearing-'))).toEqual([]);
  });

  test('keeps in-memory hits usable when a durable flush fails', async () => {
    const parentFile = await makeRoot();
    const errors: PreviewTranslationCacheOperation[] = [];
    const store = new PreviewTranslationCacheStore(path.join(parentFile, 'cache'), {
      flushDelayMs: 60_000,
      onError: (operation) => errors.push(operation),
    });
    const lookup = await store.lookup(scope(), [block()]);
    await store.record(scope(), [block()], [{ id: 'b1', translation: 'Memory result' }], lookup.ticket);

    await mkdir(path.dirname(parentFile), { recursive: true });
    await writeFile(parentFile, 'not a directory', 'utf8');
    await expect(store.flushNow()).rejects.toThrow();
    expect((await store.lookup(scope(), [block()])).hits).toEqual([
      { id: 'b1', translation: 'Memory result' },
    ]);
    expect(errors).toContain('write');
  });
});

function scopeDigest(value: PreviewTranslationCacheScope): string {
  return createHash('sha256').update(JSON.stringify([
    3,
    value.promptRevision,
    value.sourceId,
    value.targetLanguage,
    value.contentKind,
    value.modelIdentity,
  ])).digest('hex');
}
