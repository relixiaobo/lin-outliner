import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AgentResourceStore } from '../../src/main/agent/persistence/AgentResourceStore';
import type { SqliteDatabase } from '../../src/main/agent/persistence/sqlite';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('AgentResourceStore', () => {
  test('keeps digests private while ContentStore deduplicates exact revisions', async () => {
    const fixture = await createFixture();
    const bytes = Buffer.from('same exact bytes');
    const first = await fixture.store.writeBytes('thread-a', bytes, 'text/plain', 'first.txt');
    const second = await fixture.store.writeBytes('thread-b', bytes, 'text/plain', 'second.txt');

    expect(first.ref.id).toMatch(/^resource:/);
    expect(first.ref.id).not.toContain(createSha256(bytes));
    expect(second.ref.id).not.toBe(first.ref.id);
    expect(await fixture.store.readExact(first.ref)).toEqual(bytes);
    expect(await fixture.store.readExact(second.ref)).toEqual(bytes);
    expect(await blobFiles(fixture.root)).toHaveLength(1);

    await fixture.store.close();
  });

  test('retains shared revisions until the final canonical link is removed', async () => {
    const fixture = await createFixture();
    const written = await fixture.store.writeBytes(
      'thread-a',
      Buffer.from('shared'),
      'text/plain',
      'shared.txt',
    );
    expect(fixture.store.linkReference('thread-b', written.ref)).toBe(true);

    await fixture.store.setThreadReferences('thread-a', []);
    expect(await fixture.store.readExact(written.ref)).toEqual(Buffer.from('shared'));

    await fixture.store.setThreadReferences('thread-b', []);
    expect(await fixture.store.readExact(written.ref)).toBeNull();
    expect(await blobFiles(fixture.root)).toHaveLength(0);

    await fixture.store.close();
  });

  test('resolves exact and current-source intents independently', async () => {
    const fixture = await createFixture();
    const workspace = path.join(fixture.root, 'workspace');
    await mkdir(workspace);
    const sourcePath = path.join(workspace, 'report.txt');
    await writeFile(sourcePath, 'version one');
    fixture.store.registerScope({
      scopeId: 'workspace:thread-a',
      kind: 'managedWorkspace',
      rootPath: workspace,
    });
    const source = await fixture.store.sourceLocator('workspace:thread-a', sourcePath, 'file');
    const written = await fixture.store.capturePath({
      threadId: 'thread-a',
      sourcePath,
      mimeType: 'text/plain',
      fileName: 'report.txt',
      source,
    });
    await writeFile(sourcePath, 'version two');

    const delivered = await fixture.store.resolve(written.ref, 'openDelivered');
    const current = await fixture.store.resolve(written.ref, 'readCurrentSource');
    expect(delivered.status).toBe('resolvedExactRevision');
    expect(current).toMatchObject({
      status: 'resolvedSource',
      path: await realpath(sourcePath),
      entryKind: 'file',
    });
    expect(await fixture.store.readExact(written.ref)).toEqual(Buffer.from('version one'));

    await fixture.store.close();
  });
});

async function createFixture(): Promise<{ root: string; store: AgentResourceStore }> {
  const root = await mkdtemp(path.join(tmpdir(), 'tenon-agent-resource-store-'));
  roots.push(root);
  const agentRoot = path.join(root, 'agent');
  await mkdir(agentRoot);
  const databasePath = path.join(agentRoot, 'resource_references.sqlite');
  const store = new AgentResourceStore(
    databasePath,
    path.join(root, 'content'),
    path.join(agentRoot, 'scratch'),
    Date.now,
    new Database(databasePath, { create: true }) as unknown as SqliteDatabase,
  );
  await store.initialize(new Map());
  return { root, store };
}

function createSha256(bytes: Uint8Array): string {
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(bytes);
  return hasher.digest('hex');
}

async function blobFiles(root: string): Promise<string[]> {
  const blobsRoot = path.join(root, 'content', 'blobs');
  const entries = await readdir(blobsRoot, { recursive: true, withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
}
