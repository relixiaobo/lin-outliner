import { lstat, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DataBackupStore, type DataBackupManifest } from './BackupStore';
import { MANAGED_DATA_ROOTS } from './inventory';
import { DataOperationJournal, type DataOperation } from './OperationJournal';
import { assertOwnedPath, ensureDurableDirectory, copyDurably, copyLinkDurably, fingerprint, fingerprintLink, missing, ownedPath, syncDirectory,
  writeDurableJson, type DataLifecycleCheckpoint } from './durableFiles';

export interface RestoreSessionOptions {
  readonly checkpoint?: DataLifecycleCheckpoint;
  readonly progress?: (completed: number, total: number) => void;
  readonly validateStaged?: (root: string) => Promise<void>;
  readonly canSnapshotCurrent?: () => Promise<boolean>;
}

/** Caller holds the dataset writer barrier for the entire lifetime of this operation. */
export class DataRestoreSession {
  constructor(private readonly userData: string, private readonly backups: DataBackupStore,
    private readonly journal: DataOperationJournal, private readonly options: RestoreSessionOptions = {}) {}

  async run(initial: DataOperation, applicationVersion: string): Promise<DataOperation> {
    if (initial.kind !== 'restore' || !initial.sourceBackupId || !initial.generation) throw new Error('Invalid restore operation');
    let operation = initial;
    const backup = await this.backups.read(operation.sourceBackupId!);
    if (!backup) throw new Error('The selected backup is incomplete');
    await this.backups.verify(backup);
    const operationRoot = await assertOwnedPath(this.userData, `data-lifecycle/operations/${operation.id}`);
    const staging = join(operationRoot, 'staging');
    const retained = join(operationRoot, 'retained');
    await ensureDurableDirectory(operationRoot);
    if (operation.phase === 'complete') return operation;

    if (operation.phase === 'preparing' || operation.phase === 'retaining') {
      operation = { ...operation, phase: 'retaining' };
      await this.journal.write(operation);
      // Damaged current databases must be preserved too; validating them is not
      // a prerequisite for installing a separately verified recovery source.
      const canSnapshot = await this.options.canSnapshotCurrent?.() ?? true;
      await this.backups.create(applicationVersion, operation.backupId, canSnapshot ? 'backup' : 'retention');
      operation = { ...operation, phase: 'staging' };
      await this.journal.write(operation);
    }

    if (operation.phase === 'staging') {
      await rm(staging, { recursive: true, force: true });
      await ensureDurableDirectory(staging);
      for (const root of backup.roots) {
        if (root.kind === 'directory') await ensureDurableDirectory(ownedPath(staging, root.path));
      }
      for (const [index, file] of backup.files.entries()) {
        const source = await assertOwnedPath(join(this.backups.path(backup.id), 'files'), file.path, file.kind === 'link');
        if (file.kind === 'link') await copyLinkDurably(source, ownedPath(staging, file.path), this.options.checkpoint);
        else await copyDurably(source, ownedPath(staging, file.path), this.options.checkpoint);
        this.options.progress?.(index + 1, backup.files.length);
      }
      await this.verifyInstalled(staging, backup);
      await this.options.validateStaged?.(staging);
      operation = { ...operation, phase: 'installing' };
      await this.journal.write(operation);
    }

    if (operation.phase === 'installing') {
      // The fence is outside restored roots and precedes the first replacement.
      await writeDurableJson(join(this.userData, 'data-lifecycle/execution-fence.json'), {
        version: 1, generation: operation.generation, operationId: operation.id, paused: true,
      }, this.options.checkpoint);
      await this.options.checkpoint?.('restore-execution-fenced');
      await ensureDurableDirectory(retained);
      for (const root of backup.roots) {
        if (!(MANAGED_DATA_ROOTS as readonly string[]).includes(root.path)) throw new Error('Restore root is outside its declared scope');
        if (operation.completedRoots.includes(root.path)) continue;
        const target = await assertOwnedPath(this.userData, root.path);
        const original = ownedPath(retained, root.path);
        const staged = ownedPath(staging, root.path);
        const targetExists = await exists(target);
        const originalExists = await exists(original);
        const stagedExists = await exists(staged);
        if (!originalExists && targetExists && (stagedExists || root.kind === 'missing')) {
          await ensureDurableDirectory(dirname(original));
          await this.options.checkpoint?.(`before-retain-root:${root.path}`);
          await rename(target, original);
          await syncDirectory(dirname(target), this.options.checkpoint);
          await syncDirectory(dirname(original), this.options.checkpoint);
          await this.options.checkpoint?.(`retained-root:${root.path}`);
        }
        if (root.kind !== 'missing' && await exists(staged)) {
          if (await exists(target)) throw new Error('An unexpected writer replaced a restore destination');
          await ensureDurableDirectory(dirname(target));
          await rename(staged, target);
          await syncDirectory(dirname(target), this.options.checkpoint);
          await syncDirectory(dirname(staged), this.options.checkpoint);
          await this.options.checkpoint?.(`installed-root:${root.path}`);
        }
        // A rename can be durable even when the following journal receipt was lost.
        await this.verifyInstalled(this.userData, backup, root.path);
        operation = { ...operation, completedRoots: [...operation.completedRoots, root.path] };
        await this.journal.write(operation);
      }
      operation = { ...operation, phase: 'verifying' };
      await this.journal.write(operation);
    }
    await this.verifyInstalled(this.userData, backup);
    await this.options.checkpoint?.('restore-data-verified');
    return operation;
  }

  private async verifyInstalled(root: string, manifest: DataBackupManifest, selected?: string): Promise<void> {
    for (const entry of manifest.roots) {
      if (selected && selected !== entry.path) continue;
      const path = await assertOwnedPath(root, entry.path);
      const info = await lstat(path).catch((error: unknown) => { if (missing(error)) return null; throw error; });
      if (entry.kind === 'missing' ? info !== null : !info || (entry.kind === 'directory' ? !info.isDirectory() : !info.isFile())) {
        throw new Error('Installed backup root does not match its recorded type');
      }
    }
    for (const entry of manifest.files) {
      if (selected && entry.path !== selected && !entry.path.startsWith(`${selected}/`)) continue;
      const path = await assertOwnedPath(root, entry.path, entry.kind === 'link');
      const actual = entry.kind === 'link' ? await fingerprintLink(path) : await fingerprint(path);
      if (actual.bytes !== entry.bytes || actual.sha256 !== entry.sha256) throw new Error('Installed backup content failed verification');
    }
  }
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) { if (missing(error)) return false; throw error; }
}
