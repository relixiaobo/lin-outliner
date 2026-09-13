import { lstat, open, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ThreadProjectionRebuilder } from '../agent/recovery/ThreadProjectionRebuilder';
import { DataBackupStore } from './BackupStore';
import { DataOperationJournal, type DataOperation } from './OperationJournal';
import { assertOwnedPath, ensureDurableDirectory, fingerprint, missing, readPrivateJson, record, syncDirectory, writeDurableJson, type DataLifecycleCheckpoint } from './durableFiles';

export class HistoryRepairSession {
  constructor(private readonly userData: string, private readonly rebuilder: ThreadProjectionRebuilder,
    private readonly backups: DataBackupStore, private readonly journal: DataOperationJournal,
    private readonly checkpoint?: DataLifecycleCheckpoint) {}

  async run(initial: DataOperation, applicationVersion: string): Promise<DataOperation> {
    if (initial.kind !== 'repair-history') throw new Error('Invalid projection repair operation');
    let operation = initial;
    const directory = await assertOwnedPath(this.userData, `data-lifecycle/operations/${operation.id}/history-repair`);
    const staged = join(directory, 'staged.sqlite');
    const target = await assertOwnedPath(this.userData, 'agent/thread_history.sqlite');
    await ensureDurableDirectory(directory);
    if (operation.phase === 'preparing' || operation.phase === 'retaining') {
      if ((await this.rebuilder.preview()).sourceDigest !== operation.sourceDigest) throw new Error('Conversation event sources changed. Cancel and inspect the repair again.');
      operation = { ...operation, phase: 'retaining' }; await this.journal.write(operation);
      await this.backups.create(applicationVersion, operation.backupId, 'retention');
      operation = { ...operation, phase: 'staging' }; await this.journal.write(operation);
    }
    if (operation.phase === 'staging') {
      for (const suffix of ['', '-wal', '-shm', '-journal']) await rm(`${staged}${suffix}`, { force: true });
      const source = await this.rebuilder.rebuild(staged, this.checkpoint);
      if (source.sourceDigest !== operation.sourceDigest) throw new Error('Conversation sources changed while rebuilding');
      const file = await open(staged, 'r');
      try { await file.sync(); } finally { await file.close(); }
      await writeDurableJson(join(directory, 'staged.json'), await fingerprint(staged), this.checkpoint);
      operation = { ...operation, phase: 'installing' }; await this.journal.write(operation);
    }
    const expected = await readPrivateJson(join(directory, 'staged.json'));
    if (!record(expected) || typeof expected.sha256 !== 'string' || !Number.isSafeInteger(expected.bytes)) throw new Error('History repair staging evidence is invalid');
    if (operation.phase === 'installing' && await exists(staged)) {
      for (const suffix of ['-wal', '-journal', '-shm', '']) {
        const original = join(directory, `original.sqlite${suffix}`);
        if (await exists(original) && await exists(`${target}${suffix}`)) throw new Error('An unexpected writer changed the history repair destination');
        if (!await exists(original) && await exists(`${target}${suffix}`)) {
          await rename(`${target}${suffix}`, original);
          await syncDirectory(dirname(target), this.checkpoint); await syncDirectory(directory, this.checkpoint);
          await this.checkpoint?.(`history-original-retained:${suffix}`);
        }
      }
      await rename(staged, target);
      await syncDirectory(dirname(target), this.checkpoint); await syncDirectory(directory, this.checkpoint);
      await this.checkpoint?.('history-projection-installed');
    }
    const actual = await fingerprint(target);
    if (actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes) throw new Error('Installed history does not match the verified staged projection');
    operation = { ...operation, phase: 'verifying' }; await this.journal.write(operation);
    return operation;
  }
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) { if (missing(error)) return false; throw error; }
}
