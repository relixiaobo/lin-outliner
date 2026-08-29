import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  ContentIntegrityError,
  ContentStateError,
  ContentStore,
} from '../../src/content';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('ContentStore', () => {
  test('coordinates concurrent process admission, anchors, cloning, release, and central GC', async () => {
    const root = await makeRoot();
    const [first, second] = await Promise.all([
      runWorker('retain', root, 'shared bytes', 'outline', 'anchor:first'),
      runWorker('retain', root, 'shared bytes', 'outline', 'anchor:second'),
    ]);
    expect(first.lease).not.toHaveProperty('reference');
    expect(second.lease).not.toHaveProperty('reference');

    const store = await ContentStore.open(root);
    const retained = await store.anchors('outline');
    expect(retained.map((entry) => entry.anchorId)).toEqual(['anchor:first', 'anchor:second']);
    expect(await store.byteLengthOfDistinctRevisions(retained.map((anchor) => ({
      namespace: anchor.namespace,
      recordKey: anchor.recordKey,
      reference: { anchorId: anchor.anchorId, byteLength: anchor.byteLength },
    })))).toBe(Buffer.byteLength('shared bytes'));
    expect(await store.collectGarbage()).toEqual({ revisionCount: 0, byteLength: 0 });
    store.close();

    const [firstClone, secondClone] = await Promise.all([
      runWorker('clone', root, 'anchor:first', 'agent', 'anchor:clone-a'),
      runWorker('clone', root, 'anchor:first', 'outline', 'anchor:clone-b'),
    ]);
    expect(firstClone.byteLength).toBe(first.lease.byteLength);
    expect(secondClone.byteLength).toBe(first.lease.byteLength);

    const raced = await Promise.all([
      runWorker('release', root, 'anchor:first'),
      runWorker('release', root, 'anchor:second'),
      runWorker('release', root, 'anchor:clone-a'),
      runWorker('release', root, 'anchor:clone-b'),
      runWorker('gc', root),
    ]);
    const finalCollection = await runWorker('gc', root);
    expect(raced[4].revisionCount + finalCollection.revisionCount).toBe(1);
    expect(raced[4].byteLength + finalCollection.byteLength).toBe(Buffer.byteLength('shared bytes'));
    expect(await revisionFiles(root)).toEqual([]);
    const layout = await readdir(root);
    expect(layout).toEqual(expect.arrayContaining(['blobs', 'quarantine', 'staging', 'state.sqlite']));
    expect(layout).not.toContain('content.sqlite');
    expect(layout).not.toContain('revisions');
  });

  test('retains live pre-claim staging and durably reclaims it after the writer is killed', async () => {
    const root = await makeRoot();
    const byteLength = 1024 * 1024;
    const worker = spawn(process.execPath, [
      path.join(import.meta.dir, '..', 'fixtures', 'contentStoreWorker.ts'),
      'hold-before-claim',
      root,
      String(byteLength),
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let concurrent: ContentStore | undefined;
    worker.stderr.setEncoding('utf8');
    worker.stderr.on('data', (chunk: string) => { stderr += chunk; });

    try {
      expect(await waitForWorkerReady(worker, () => stderr)).toEqual({ ready: true, byteLength });
      const stagingRoot = path.join(root, 'staging');
      const [staged] = await readdir(stagingRoot);
      expect(staged).toMatch(/^admit-[0-9a-f-]+\.tmp$/u);
      expect((await stat(path.join(stagingRoot, staged!))).size).toBe(byteLength);

      concurrent = await ContentStore.open(root, {
        hooks: { afterStagingUnlink: () => { throw new Error('interrupt staging durability'); } },
      });
      expect(await readdir(stagingRoot)).toEqual([staged!]);

      const exited = once(worker, 'exit');
      worker.kill('SIGKILL');
      await exited;

      await expect(concurrent.collectGarbage()).rejects.toThrow('interrupt staging durability');
      expect(await readdir(stagingRoot)).toEqual([]);
      concurrent.close();

      const interruptedDatabase = new Database(path.join(root, 'state.sqlite'));
      expect(interruptedDatabase.query('SELECT COUNT(*) AS count FROM admission_staging').get())
        .toEqual({ count: 1 });
      interruptedDatabase.close();

      const recovered = await ContentStore.open(root);
      expect(await readdir(stagingRoot)).toEqual([]);
      expect(await recovered.collectGarbage()).toEqual({ revisionCount: 0, byteLength: 0 });
      const database = new Database(recovered.databasePath);
      expect(database.query('SELECT COUNT(*) AS count FROM admission_staging').get()).toEqual({ count: 0 });
      database.close();
      recovered.close();
    } finally {
      if (worker.exitCode === null && worker.signalCode === null) {
        const exited = once(worker, 'exit');
        worker.kill('SIGKILL');
        await exited;
      }
      concurrent?.close();
    }
  });

  test('retains live cleanup ownership until the staging unlink is durable', async () => {
    const root = await makeRoot();
    const store = await ContentStore.open(root, {
      hooks: { afterStagingUnlink: () => { throw new Error('interrupt live cleanup durability'); } },
    });
    await expect(store.admit((async function* () {
      yield Buffer.from('partial bytes');
      throw new Error('source failed');
    })())).rejects.toThrow('source failed');
    expect(await readdir(path.join(root, 'staging'))).toEqual([]);
    store.close();

    const interruptedDatabase = new Database(path.join(root, 'state.sqlite'));
    expect(interruptedDatabase.query('SELECT COUNT(*) AS count FROM admission_staging').get())
      .toEqual({ count: 1 });
    interruptedDatabase.query('UPDATE admission_staging SET owner_pid = ?').run(2_147_483_647);
    interruptedDatabase.close();

    const recovered = await ContentStore.open(root);
    const recoveredDatabase = new Database(recovered.databasePath);
    expect(recoveredDatabase.query('SELECT COUNT(*) AS count FROM admission_staging').get())
      .toEqual({ count: 0 });
    recoveredDatabase.close();
    recovered.close();
  });

  test('repairs publication interrupted after rename without fabricating an admission lease', async () => {
    const root = await makeRoot();
    const firstNow = new Date('2026-08-27T00:00:00.000Z');
    const interrupted = await ContentStore.open(root, {
      now: () => firstNow,
      publicationStaleMs: 1,
      hooks: { afterPublicationRename: () => { throw new Error('crash after rename'); } },
    });
    await expect(interrupted.admitBytes(Buffer.from('recover publication'))).rejects.toThrow('crash after rename');
    interrupted.close();

    const repaired = await ContentStore.open(root, {
      now: () => new Date(firstNow.getTime() + 10),
      publicationStaleMs: 1,
    });
    const lease = await repaired.admitBytes(Buffer.from('recover publication'));
    expect(await readFile(await repaired.verifiedAdmissionPath(lease.leaseId), 'utf8')).toBe('recover publication');
    repaired.close();
  });

  test('repairs publication interrupted before rename without retaining an incomplete revision', async () => {
    const root = await makeRoot();
    const firstNow = new Date('2026-08-27T00:00:00.000Z');
    const interrupted = await ContentStore.open(root, {
      now: () => firstNow,
      publicationStaleMs: 1,
      hooks: { afterPublicationClaim: () => { throw new Error('crash before rename'); } },
    });
    await expect(interrupted.admitBytes(Buffer.from('retry cleanly'))).rejects.toThrow('crash before rename');
    interrupted.close();

    const repaired = await ContentStore.open(root, {
      now: () => new Date(firstNow.getTime() + 10),
      publicationStaleMs: 1,
    });
    expect(await revisionFiles(root)).toEqual([]);
    const admitted = await repaired.admitBytes(Buffer.from('retry cleanly'));
    expect(await readFile(await repaired.verifiedAdmissionPath(admitted.leaseId), 'utf8')).toBe('retry cleanly');
    repaired.close();
  });

  test('rejects an untrusted publication path and derives deletion paths internally', async () => {
    const root = await makeRoot();
    const outsidePath = path.join(await makeRoot(), 'outside.txt');
    await writeFile(outsidePath, 'must remain untouched');
    const interrupted = await ContentStore.open(root, {
      hooks: { afterPublicationClaim: () => { throw new Error('stop after claim'); } },
    });
    await expect(interrupted.admitBytes(Buffer.from('journal path'))).rejects.toThrow('stop after claim');
    interrupted.close();

    const database = new Database(path.join(root, 'state.sqlite'));
    database.query('UPDATE publication_journal SET temp_path = ?').run(outsidePath);
    const deletionColumns = database.query('PRAGMA table_info(deletion_journal)')
      .all() as Array<{ name: string }>;
    database.close();

    expect(deletionColumns.map((column) => column.name)).not.toContain('final_path');
    await expect(ContentStore.open(root)).rejects.toThrow('invalid staging path');
    expect(await Bun.file(outsidePath).text()).toBe('must remain untouched');
  });

  test('retains admission before anchor creation and collects it only after lease expiry', async () => {
    const root = await makeRoot();
    let nowMs = Date.parse('2026-08-27T00:00:00.000Z');
    const store = await ContentStore.open(root, { now: () => new Date(nowMs) });
    const lease = await store.admitBytes(Buffer.from('not yet anchored'), { leaseMs: 1_000 });
    expect(await store.anchors('outline')).toEqual([]);
    expect(await store.collectGarbage()).toEqual({ revisionCount: 0, byteLength: 0 });

    nowMs += 1_001;
    expect(await store.collectGarbage()).toEqual({
      revisionCount: 1,
      byteLength: lease.byteLength,
    });
    store.close();
  });

  test('repairs an interrupted deletion journal and rejects attachment while deleting', async () => {
    const root = await makeRoot();
    let store!: ContentStore;
    let admissionLeaseId = '';
    store = await ContentStore.open(root, {
      admissionLeaseMs: 1,
      now: () => new Date('2026-08-27T00:00:00.000Z'),
      hooks: {
        afterDeletionMarked: async () => {
          await expect(store.createAnchor(admissionLeaseId, 'outline', 'record:late', 'anchor:late'))
            .rejects.toBeInstanceOf(ContentStateError);
          await expect(store.admitBytes(Buffer.from('delete me')))
            .rejects.toBeInstanceOf(ContentStateError);
          throw new Error('crash after deletion mark');
        },
      },
    });
    const lease = await store.admitBytes(Buffer.from('delete me'), { leaseMs: 1 });
    admissionLeaseId = lease.leaseId;
    await store.releaseAdmissionLease(lease.leaseId);
    await expect(store.collectGarbage()).rejects.toThrow('crash after deletion mark');
    store.close();

    const repaired = await ContentStore.open(root);
    expect(await revisionFiles(root)).toEqual([]);
    const readmitted = await repaired.admitBytes(Buffer.from('delete me'));
    expect(readmitted.byteLength).toBe(lease.byteLength);
    repaired.close();
  });

  test('retains the deletion journal until the revision unlink is durable', async () => {
    const root = await makeRoot();
    const store = await ContentStore.open(root, {
      hooks: { afterDeletionUnlink: () => { throw new Error('interrupt deletion durability'); } },
    });
    const lease = await store.admitBytes(Buffer.from('durable deletion'));
    expect(await store.releaseAdmissionLease(lease.leaseId)).toBe(true);
    await expect(store.collectGarbage()).rejects.toThrow('interrupt deletion durability');
    expect(await revisionFiles(root)).toEqual([]);
    store.close();

    const interruptedDatabase = new Database(path.join(root, 'state.sqlite'));
    expect(interruptedDatabase.query('SELECT state FROM exact_revisions').get())
      .toEqual({ state: 'deleting' });
    expect(interruptedDatabase.query('SELECT COUNT(*) AS count FROM deletion_journal').get())
      .toEqual({ count: 1 });
    interruptedDatabase.close();

    const recovered = await ContentStore.open(root);
    const recoveredDatabase = new Database(recovered.databasePath);
    expect(recoveredDatabase.query('SELECT COUNT(*) AS count FROM exact_revisions').get())
      .toEqual({ count: 0 });
    expect(recoveredDatabase.query('SELECT COUNT(*) AS count FROM deletion_journal').get())
      .toEqual({ count: 0 });
    recoveredDatabase.close();
    recovered.close();
  });

  test('quarantines physical corruption for every reference without changing anchor identity', async () => {
    const root = await makeRoot();
    const store = await ContentStore.open(root);
    const lease = await store.admitBytes(Buffer.from('trusted bytes'));
    const first = await store.createAnchor(lease.leaseId, 'outline', 'record:a', 'anchor:record-a');
    const second = await store.cloneAnchor(first.anchorId, 'outline', 'record:b', 'anchor:record-b');
    const firstReference = { anchorId: first.anchorId, byteLength: first.byteLength };
    const secondReference = { anchorId: second.anchorId, byteLength: second.byteLength };
    const contentPath = await store.verifiedPath(firstReference, 'outline', 'record:a');
    await writeFile(contentPath, 'corrupt bytes');

    await expect(store.readVerified(firstReference, 'outline', 'record:a')).rejects.toBeInstanceOf(ContentIntegrityError);
    await expect(store.readVerified(secondReference, 'outline', 'record:b')).rejects.toMatchObject({ code: 'quarantined' });
    expect((await store.anchors('outline')).map((entry) => entry.anchorId))
      .toEqual(['anchor:record-a', 'anchor:record-b']);
    expect((await readdir(path.join(root, 'quarantine'))).length).toBe(1);
    store.close();
  });

  test('rejects a revision symlink without reading outside the ContentStore', async () => {
    const root = await makeRoot();
    const outsidePath = path.join(await makeRoot(), 'outside.txt');
    await writeFile(outsidePath, 'outside bytes');
    const store = await ContentStore.open(root);
    const lease = await store.admitBytes(Buffer.from('trusted bytes'));
    const anchor = await store.createAnchor(lease.leaseId, 'outline', 'record:symlink', 'anchor:symlink');
    const reference = { anchorId: anchor.anchorId, byteLength: anchor.byteLength };
    const revisionPath = await store.verifiedPath(reference, 'outline', 'record:symlink');
    await rm(revisionPath);
    await symlink(outsidePath, revisionPath);

    await expect(store.readVerified(reference, 'outline', 'record:symlink'))
      .rejects.toBeInstanceOf(ContentIntegrityError);
    expect(await readFile(outsidePath, 'utf8')).toBe('outside bytes');
    store.close();
  });

  test('never rebinds a released anchor identity to another exact revision', async () => {
    const root = await makeRoot();
    const store = await ContentStore.open(root);
    const firstLease = await store.admitBytes(Buffer.from('first revision'));
    const first = await store.createAnchor(firstLease.leaseId, 'outline', 'asset:first', 'anchor:stable');
    expect(await store.releaseAnchor(first.anchorId)).toBe(true);

    const secondLease = await store.admitBytes(Buffer.from('other revision'));
    await expect(store.createAnchor(secondLease.leaseId, 'outline', 'asset:second', first.anchorId))
      .rejects.toMatchObject({ code: 'unavailable' });
    expect(await readFile(await store.verifiedAdmissionPath(secondLease.leaseId), 'utf8')).toBe('other revision');
    store.close();
  });
});

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'tenon-content-store-'));
  roots.push(root);
  return root;
}

async function runWorker(
  action: 'admit' | 'retain' | 'clone' | 'release' | 'gc',
  root: string,
  value = '',
  namespace = '',
  anchorId = '',
): Promise<any> {
  const worker = Bun.spawn([
    process.execPath,
    path.join(import.meta.dir, '..', 'fixtures', 'contentStoreWorker.ts'),
    action,
    root,
    value,
    namespace,
    anchorId,
  ], { stdout: 'pipe', stderr: 'pipe' });
  const [exitCode, stdout, stderr] = await Promise.all([
    worker.exited,
    new Response(worker.stdout).text(),
    new Response(worker.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`ContentStore worker failed (${exitCode}): ${stderr}`);
  return JSON.parse(stdout);
}

async function revisionFiles(root: string): Promise<readonly string[]> {
  const revisionsRoot = path.join(root, 'blobs');
  const prefixes = await readdir(revisionsRoot).catch(() => []);
  const result: string[] = [];
  for (const prefix of prefixes) {
    for (const entry of await readdir(path.join(revisionsRoot, prefix))) result.push(`${prefix}/${entry}`);
  }
  return result.sort();
}

async function waitForWorkerReady(
  worker: ReturnType<typeof spawn>,
  stderr: () => string,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`ContentStore staging worker did not become ready: ${stderr()}`));
    }, 5_000);
    const onData = (chunk: Buffer | string) => {
      stdout += chunk.toString();
      const newline = stdout.indexOf('\n');
      if (newline < 0) return;
      cleanup();
      try {
        resolve(JSON.parse(stdout.slice(0, newline)));
      } catch (error) {
        reject(error);
      }
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`ContentStore staging worker exited before ready (${code ?? signal}): ${stderr()}`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      worker.stdout?.off('data', onData);
      worker.off('exit', onExit);
    };
    worker.stdout?.on('data', onData);
    worker.once('exit', onExit);
  });
}
