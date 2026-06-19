import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NODE_ACCESS_HALF_LIFE_MS } from '../../src/core/nodeAccessRanking';
import { NodeAccessStore } from '../../src/main/nodeAccessStore';

let tempDir: string | null = null;

async function makeStore(flushDelayMs = 60_000): Promise<{ filePath: string; store: NodeAccessStore }> {
  tempDir = await mkdtemp(path.join(tmpdir(), 'tenon-node-access-'));
  const filePath = path.join(tempDir, 'node-access-stats.json');
  return {
    filePath,
    store: new NodeAccessStore(filePath, { flushDelayMs }),
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
});
