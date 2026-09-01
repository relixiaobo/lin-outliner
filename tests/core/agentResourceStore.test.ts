import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AgentResourceStore } from '../../src/main/agent/persistence/AgentResourceStore';
import type { ThreadResourceReference, Turn } from '../../src/core/agent/protocol';
import type { ThreadCore } from '../../src/main/agent/thread/ThreadCore';
import { ThreadResourceOps } from '../../src/main/agent/thread/ThreadResourceOps';
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

  test('preserves existing links and bytes until startup has a complete reference snapshot', async () => {
    const fixture = await createFixture();
    const written = await fixture.store.writeBytes(
      'thread-a',
      Buffer.from('survives incomplete startup'),
      'text/plain',
      'survivor.txt',
    );
    await fixture.store.close();

    const reopened = openStore(fixture.root);
    await reopened.initialize(new Map(), { complete: false });
    expect(await reopened.readExact(written.ref)).toEqual(Buffer.from('survives incomplete startup'));

    await reopened.initialize(new Map());
    expect(await reopened.readExact(written.ref)).toBeNull();
    expect(await blobFiles(fixture.root)).toHaveLength(0);
    await reopened.close();
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

  test('copies cross-managed-root edits while preserving admitted external sources', async () => {
    const fixture = await createFixture();
    const oldWorkspace = path.join(fixture.root, 'old-workspace');
    const currentWorkspace = path.join(fixture.root, 'current-workspace');
    const externalRoot = path.join(fixture.root, 'external');
    await Promise.all([mkdir(oldWorkspace), mkdir(currentWorkspace), mkdir(externalRoot)]);
    const oldPath = path.join(oldWorkspace, 'report.txt');
    const externalPath = path.join(externalRoot, 'shared.txt');
    await writeFile(oldPath, 'historical exact bytes');
    await writeFile(externalPath, 'external bytes');
    fixture.store.registerScope({ scopeId: 'managed:old', kind: 'managedWorkspace', rootPath: oldWorkspace });
    fixture.store.registerScope({ scopeId: 'external:user', kind: 'external', rootPath: externalRoot });
    const oldRef = (await fixture.store.capturePath({
      threadId: '01951d6e-7c25-7c31-8d62-313038616240',
      sourcePath: oldPath,
      mimeType: 'text/plain',
      fileName: 'report.txt',
      source: await fixture.store.sourceLocator('managed:old', oldPath, 'file'),
    })).ref;
    const externalRef = (await fixture.store.capturePath({
      threadId: '01951d6e-7c25-7c31-8d62-313038616240',
      sourcePath: externalPath,
      mimeType: 'text/plain',
      fileName: 'shared.txt',
      source: await fixture.store.sourceLocator('external:user', externalPath, 'file'),
    })).ref;
    await writeFile(oldPath, 'newer old-workspace bytes');

    const historicalRefs: ThreadResourceReference[] = [oldRef, externalRef];
    const core = historicalResourceCore(currentWorkspace, historicalRefs);
    const ops = new ThreadResourceOps(
      core,
      fixture.store,
      path.join(fixture.root, 'observations'),
      (content) => content,
    );
    const copied = await ops.selectHistoricalResource(
      '01951d6e-7c25-7c31-8d62-313038616239',
      '01951d6e-7c25-7c31-8d62-313038616240',
      oldRef,
      'edit',
    );
    expect(copied?.ref.id).not.toBe(oldRef.id);
    expect(copied?.path?.startsWith(`${currentWorkspace}${path.sep}`)).toBe(true);
    expect(await readFile(copied!.path!, 'utf8')).toBe('historical exact bytes');
    expect(await readFile(oldPath, 'utf8')).toBe('newer old-workspace bytes');

    const external = await ops.selectHistoricalResource(
      '01951d6e-7c25-7c31-8d62-313038616239',
      '01951d6e-7c25-7c31-8d62-313038616240',
      externalRef,
      'edit',
    );
    expect(external).toMatchObject({ ref: externalRef, path: await realpath(externalPath) });
    await fixture.store.close();
  });
});

function historicalResourceCore(
  currentWorkspace: string,
  refs: readonly ThreadResourceReference[],
): ThreadCore {
  const currentId = '01951d6e-7c25-7c31-8d62-313038616239';
  const historicalId = '01951d6e-7c25-7c31-8d62-313038616240';
  const threads = new Map([
    [currentId, { id: currentId, cwd: currentWorkspace, parentThreadId: null }],
    [historicalId, { id: historicalId, cwd: '/old', parentThreadId: null }],
  ]);
  const turns = [{
    id: 'turn-history',
    items: [{
      type: 'userMessage',
      content: refs.map((ref, index) => ({
        type: 'attachment',
        id: `attachment-${index}`,
        name: ref.fileName,
        mimeType: ref.mimeType,
        sizeBytes: ref.byteLength,
        source: { kind: 'resource', ref },
      })),
    }],
    execution: { diagnosticsRef: null },
  }] as unknown as Turn[];
  return {
    requireThread: (threadId: string) => ({ thread: threads.get(threadId)! }),
    allTurns: (threadId: string) => threadId === historicalId ? turns : [],
  } as unknown as ThreadCore;
}

async function createFixture(): Promise<{ root: string; store: AgentResourceStore }> {
  const root = await mkdtemp(path.join(tmpdir(), 'tenon-agent-resource-store-'));
  roots.push(root);
  const agentRoot = path.join(root, 'agent');
  await mkdir(agentRoot);
  const store = openStore(root);
  await store.initialize(new Map());
  return { root, store };
}

function openStore(root: string): AgentResourceStore {
  const databasePath = path.join(root, 'agent', 'resource_references.sqlite');
  return new AgentResourceStore(
    databasePath,
    path.join(root, 'content'),
    path.join(root, 'agent', 'scratch'),
    Date.now,
    new Database(databasePath, { create: true }) as unknown as SqliteDatabase,
  );
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
