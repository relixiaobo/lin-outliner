import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NODE_ACCESS_HALF_LIFE_MS } from '../../src/core/nodeAccessRanking';
import { NodeAccessStore } from '../../src/main/nodeAccessStore';

let tempDir: string | null = null;

interface StoreTestOptions {
  flushDelayMs?: number;
  maxEntries?: number;
}

async function makeStore(options: StoreTestOptions = {}): Promise<{ filePath: string; store: NodeAccessStore }> {
  tempDir = await mkdtemp(path.join(tmpdir(), 'tenon-node-access-'));
  const filePath = path.join(tempDir, 'node-access-stats.json');
  return {
    filePath,
    store: new NodeAccessStore(filePath, {
      flushDelayMs: options.flushDelayMs ?? 60_000,
      maxEntries: options.maxEntries,
    }),
  };
}

afterEach(async () => {
  if (!tempDir) return;
  await rm(tempDir, { recursive: true, force: true });
  tempDir = null;
});

describe('NodeAccessStore', () => {
  test('records unique nodes and round-trips persisted stats', async () => {
    const { filePath, store } = await makeStore();
    await store.recordMany(['node:a', 'node:a', 'node:b'], 'human', 1_000);
    await store.recordMany(['node:a'], 'agentRecall', 1_000 + NODE_ACCESS_HALF_LIFE_MS);

    expect(store.snapshot().get('node:a')?.s).toBeCloseTo(0.65);
    expect(store.snapshot().get('node:b')).toEqual({ s: 1, tUpdate: 1_000 });

    await store.flushNow();
    const raw = JSON.parse(await readFile(filePath, 'utf8'));
    expect(raw).toMatchObject({ version: 1 });
    expect(raw.nodes['node:a'].s).toBeCloseTo(0.65);
    if (process.platform !== 'win32') {
      expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    }

    const reloaded = new NodeAccessStore(filePath);
    await reloaded.load();
    expect(reloaded.snapshot().get('node:a')?.s).toBeCloseTo(0.65);
    expect(reloaded.snapshot().get('node:b')).toEqual({ s: 1, tUpdate: 1_000 });
  });

  test('treats corrupt files as empty and overwrites them on the next flush', async () => {
    const { filePath, store } = await makeStore();
    await writeFile(filePath, '{not json', 'utf8');

    await store.load();
    expect(store.snapshot().size).toBe(0);

    await store.recordMany(['node:c'], 'human', 3_000);
    await store.flushNow();

    const raw = JSON.parse(await readFile(filePath, 'utf8'));
    expect(raw.nodes['node:c']).toEqual({ s: 1, tUpdate: 3_000 });
  });

  test('surfaces filesystem load failures instead of replacing stats with an empty map', async () => {
    const { filePath } = await makeStore();
    await mkdir(filePath);
    const errors: Array<{ operation: string; error: unknown }> = [];
    const store = new NodeAccessStore(filePath, {
      onError: (error, operation) => errors.push({ error, operation }),
    });

    await expect(store.load()).rejects.toThrow();
    expect(errors.map((entry) => entry.operation)).toEqual(['load']);
  });

  test('can prune stale node ids', async () => {
    const { store } = await makeStore();
    await store.recordMany(['node:keep', 'node:delete', 'node:gone'], 'human', 1_000);

    await store.deleteMany(['node:delete']);
    expect(store.snapshot().has('node:delete')).toBe(false);

    await store.retainOnly(['node:keep']);
    expect([...store.snapshot().keys()]).toEqual(['node:keep']);
  });

  test('bounds in-memory stats to strongest entries', async () => {
    const { store } = await makeStore({ maxEntries: 2 });

    await store.recordMany(['node:old'], 'human', 1_000);
    await store.recordMany(['node:weak'], 'agentRecall', 2_000);
    await store.recordMany(['node:new'], 'human', 3_000);

    expect([...store.snapshot().keys()].sort()).toEqual(['node:new', 'node:old']);
  });
});
