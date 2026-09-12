import { randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { initialDataLifecycleState, type DataLifecycleDomain, type DataLifecycleIssue,
  type DataLifecycleState, type DataLifecycleRequest } from '../../core/dataLifecycle';
import { OUTLINE_STORAGE_VERSION } from '../../outline/contract/version';
import type { OutlineDataInspection } from '../../outline/contract/dataInspection';
import { DataBackupStore } from './BackupStore';
import { DataOperationJournal, type DataOperation } from './OperationJournal';
import { DataRestoreSession } from './RestoreSession';
import { HistoryRepairSession } from './HistoryRepairSession';
import { ThreadProjectionRebuilder } from '../agent/recovery/ThreadProjectionRebuilder';
import { DataStoreRegistry, type StoreInspection } from './storeRegistry';
import { assertOwnedPath, ensureDurableDirectory, missing, readPrivateJson, record, writeDurableJson, type DataLifecycleCheckpoint } from './durableFiles';

export interface LifecycleWriterBarrier {
  acquire(): Promise<void>;
  release(): Promise<void>;
  initializeOutline(operationId: string): Promise<void>;
  inspectOutline(userData?: string): Promise<OutlineDataInspection>;
}

export interface DataLifecycleOptions {
  readonly userData: string;
  readonly applicationVersion: string;
  readonly barrier: LifecycleWriterBarrier;
  readonly registry: DataStoreRegistry;
  readonly checkpoint?: DataLifecycleCheckpoint;
  readonly changed?: (state: DataLifecycleState) => void;
  readonly prepareRestoredExecution?: (generation: string) => Promise<void>;
  readonly resumeAutomaticExecution?: (generation: string) => Promise<void>;
}

interface DataManifest {
  readonly manifestVersion: 1;
  readonly baselineRelease: string;
  readonly storeVersions: Readonly<Record<string, number>>;
  readonly identityReferences: Readonly<Record<string, string>>;
  readonly operationId: null;
  readonly lastVerifiedAt: number;
}

export class DataLifecycleCoordinator {
  readonly registry: DataStoreRegistry;
  readonly backups: DataBackupStore;
  readonly journal: DataOperationJournal;
  readonly historyRepair: ThreadProjectionRebuilder;
  private stateValue = initialDataLifecycleState();
  private attempt: Promise<void> | null = null;
  private normalAdmission = false;
  private stopped = false;
  private manifest: DataManifest | null = null;
  private outlineInspection: OutlineDataInspection | null = null;

  constructor(private readonly options: DataLifecycleOptions) {
    this.registry = options.registry;
    this.historyRepair = new ThreadProjectionRebuilder(options.userData, this.registry);
    this.journal = new DataOperationJournal(options.userData, (name) => this.checkpoint(name));
    this.backups = new DataBackupStore(options.userData, this.registry, {
      checkpoint: (name) => this.checkpoint(name),
      progress: (completed, total) => this.publish({ progress: { completed, total } }),
    });
  }

  state(): DataLifecycleState { return this.stateValue; }

  prepare(): Promise<void> {
    if (this.stopped) return Promise.reject(new Error('Data lifecycle is closing'));
    this.attempt ??= this.prepareNow().finally(() => { this.attempt = null; });
    return this.attempt;
  }

  /** Scoped retry may inspect repaired data while an unrelated healthy Host stays open. */
  async retryInspection(): Promise<void> {
    if (!this.normalAdmission) return this.prepare();
    const operation = await this.journal.read();
    if (operation && operation.phase !== 'complete') throw new Error('Restart to finish the pending data operation.');
    const inspections = await this.registry.inspect(this.options.userData);
    const issues = inspections.flatMap((entry) => entry.issue ? [entry.issue] : []);
    for (const entry of inspections) {
      if (this.manifest && entry.store.id in this.manifest.storeVersions && !entry.exists) issues.push({
        storeId: entry.store.id, domain: entry.store.domain, reason: 'invalid-data',
        message: 'An established Store is missing; restore its data from a verified backup.',
      });
    }
    issues.push(...this.manifestIssues());
    this.publish({ issues, phase: issues.length ? 'recoveryRequired' : 'ready' });
  }

  assertDomain(domain: DataLifecycleDomain): void {
    const issue = this.stateValue.issues.find((entry) => entry.domain === domain || entry.domain === 'desktop');
    if (issue) throw Object.assign(new Error(issue.message), { code: issue.reason === 'future-version' ? 'STARTUP_VERSION_MISMATCH' : 'STARTUP_INVALID_DATA',
      found: issue.foundVersion, expected: issue.expectedVersion });
    if (this.stateValue.phase !== 'ready' && this.stateValue.phase !== 'recoveryRequired') throw new Error('Data inspection has not completed');
  }

  admitNormalWriters(): void { this.normalAdmission = true; }
  interrupt(): void { this.stopped = true; }
  resumeAfterCancelledQuit(): void { if (!this.attempt) this.stopped = false; }

  async inspectBackups(): Promise<DataLifecycleState> {
    const operation = await this.journal.read();
    const pinned = new Set(operation && operation.phase !== 'complete' ? [operation.backupId, operation.sourceBackupId ?? ''] : []);
    this.publish({ backups: await this.backups.list(pinned) });
    return this.stateValue;
  }

  async validateRestoreSource(id: string): Promise<void> {
    const backup = await this.backups.read(id);
    if (!backup || backup.purpose !== 'backup') throw new Error('Choose a completed, verified backup for restoration.');
    await this.backups.verify(backup);
    const root = join(this.backups.path(id), 'files');
    const inspections = await this.registry.inspect(root, true);
    const issue = inspections.find((entry) => entry.issue);
    if (issue) throw new Error(`Backup ${issue.store.id}: ${issue.issue!.message}`);
    const outline = await this.options.barrier.inspectOutline(root);
    if (outline.error || outline.exists && !outline.hasTransactionLog) throw new Error(outline.error?.message ?? 'Backup workspace history is incomplete');
  }

  /** Queue only; the desktop drains and restarts before this operation touches data. */
  async request(request: Extract<DataLifecycleRequest, { action: 'restore' | 'resume-execution' | 'repair-history' }> | { action: 'backup' }, historyPreview?: { sourceDigest: string }): Promise<string> {
    if (this.attempt) throw new Error('Data maintenance is already running');
    if (this.stopped) throw new Error('Data lifecycle is closing');
    if (this.stateValue.issues.some((issue) => issue.reason === 'future-version')) throw new Error('Use a compatible application before changing newer data.');
    if (request.action === 'restore') {
      if (request.revision !== this.stateValue.revision) throw new Error('Backup selection changed; inspect again');
      const backup = await this.backups.read(request.backupId);
      if (!backup) throw new Error('The selected backup is incomplete');
      if (backup.purpose !== 'backup') throw new Error('These retained originals require inspection; choose a verified backup for automatic restoration.');
      await this.backups.verify(backup);
    }
    if (request.action === 'resume-execution' && (request.revision !== this.stateValue.revision
      || request.generation !== this.stateValue.restoredGeneration || this.stateValue.phase !== 'ready')) throw new Error('Restore generation changed; inspect again');
    if (request.action === 'repair-history' && (request.revision !== this.stateValue.revision
      || (this.stateValue.phase !== 'ready' && !this.stateValue.issues.some((issue) => issue.storeId === 'agent-history' && issue.reason !== 'future-version')))) throw new Error('History repair scope changed; inspect again');
    const pending = await this.journal.read();
    if (pending && pending.phase !== 'complete' && pending.targetDigest !== this.registry.contractDigest()) throw new Error('The pending operation requires its compatible application version.');
    if (pending && pending.phase !== 'complete' && request.action !== 'restore') throw new Error('Resume the existing data operation before starting another');
    let operation = request.action === 'restore' ? this.operation('restore', request.backupId)
      : request.action === 'repair-history' ? { ...this.operation('repair-history'), sourceDigest: (historyPreview ?? await this.historyRepair.preview()).sourceDigest }
      : request.action === 'resume-execution' ? { ...this.operation('resume'), generation: request.generation }
        : this.operation('backup');
    const supersedeId = pending && pending.phase !== 'complete' ? pending.id : undefined;
    if (supersedeId) operation = { ...operation, supersedes: supersedeId };
    await this.journal.write(operation, supersedeId);
    this.publish({ operationId: operation.id, canCancelOperation: !supersedeId });
    return operation.id;
  }

  async cancelQueuedRequest(id: string, revision?: number): Promise<void> {
    if (this.attempt) throw new Error('Data maintenance is still running');
    if (this.stateValue.issues.some((issue) => issue.reason === 'future-version')) throw new Error('Use a compatible application before changing newer data.');
    if (revision !== undefined && revision !== this.stateValue.revision) throw new Error('Data operation changed; inspect again');
    const operation = await this.journal.read();
    if (!operation || operation.id !== id || operation.supersedes || !['preparing', 'retaining', 'staging'].includes(operation.phase) || operation.kind === 'initialize') throw new Error('Data operation can no longer be cancelled');
    await this.journal.write({ ...operation, phase: 'complete', cancelled: true });
    this.publish({ operationId: null, canCancelOperation: false });
  }

  async close(): Promise<void> {
    this.stopped = true;
    await this.attempt;
    await this.options.barrier.release();
  }

  private async prepareNow(): Promise<void> {
    if (this.normalAdmission) throw new Error('Data maintenance requires a fresh startup after normal writers close');
    this.publish({ phase: 'inspecting', issues: [], progress: null });
    try {
      await ensureDurableDirectory(this.options.userData);
      this.manifest = decodeDataManifest(await readPrivateJson(await assertOwnedPath(this.options.userData, 'data-manifest.json')));
      const pending = await this.journal.read();
      if (pending && pending.phase !== 'complete') {
        await this.runOperation(pending);
      } else {
        const inspected = await this.registry.inspect(this.options.userData, !this.manifest);
        const issues = inspected.flatMap((entry) => entry.issue ? [entry.issue] : []);
        for (const entry of inspected) {
          if (this.manifest && entry.store.id in this.manifest.storeVersions && !entry.exists) issues.push({
            storeId: entry.store.id, domain: entry.store.domain, reason: 'invalid-data',
            message: 'A previously established data Store is missing. Restore it from a verified backup.',
          });
        }
        issues.push(...this.manifestIssues());
        if (this.manifest?.identityReferences.workspaceId) {
          for (const file of ['outline.snapshot.json', 'outline.transactions.jsonl']) {
            const path = await assertOwnedPath(this.options.userData, `outline-runtime/workspace/${file}`);
            const info = await lstat(path).catch((error: unknown) => { if (missing(error)) return null; throw error; });
            if (!info?.isFile() || info.size === 0) issues.push({ storeId: 'outline-workspace', domain: 'outline', reason: 'invalid-data', message: 'An established workspace file is missing. Restore a verified backup.' });
          }
        }
        const outlineIssue = await this.inspectOutline(!this.manifest);
        if (outlineIssue) issues.push(outlineIssue);
        if (issues.length) { this.publish({ issues, phase: 'recoveryRequired' }); return; }
        if (!this.manifest || inspected.some((entry) => !entry.exists || entry.observedVersion !== entry.store.version)) {
          const operation = this.operation('initialize');
          await this.journal.write(operation);
          await this.runOperation(operation);
        }
      }
      const fence = await readPrivateJson(join(this.options.userData, 'data-lifecycle/execution-fence.json'));
      if (fence !== null && (!record(fence) || fence.version !== 1 || typeof fence.generation !== 'string' || typeof fence.paused !== 'boolean')) {
        throw new Error('The restored execution fence is invalid');
      }
      this.publish({ phase: 'ready', operationId: null, progress: null,
        restoredGeneration: record(fence) ? fence.generation as string : null,
        automaticExecutionPaused: record(fence) && fence.paused === true, canCancelOperation: false });
    } catch (error) {
      const reason = record(error) && error.code === 'ENOSPC' ? 'storage-full'
        : record(error) && (error.code === 'SQLITE_BUSY' || error.code === 'SQLITE_LOCKED') ? 'locked'
          : record(error) && error.code === 'STARTUP_VERSION_MISMATCH' ? 'future-version' : 'incomplete-operation';
      const pending = await this.journal.read().catch(() => null);
      this.publish({ phase: 'recoveryRequired', progress: null,
        operationId: pending && pending.phase !== 'complete' ? pending.id : null,
        canCancelOperation: !!pending && !pending.supersedes && pending.kind !== 'initialize' && ['preparing', 'retaining', 'staging'].includes(pending.phase),
        issues: [{ domain: 'desktop', storeId: 'data-lifecycle', reason,
        message: error instanceof Error ? error.message.slice(0, 1000) : 'Data inspection could not complete.' }] });
    }
  }

  private async runOperation(initial: DataOperation): Promise<void> {
    if (initial.targetDigest !== this.registry.contractDigest()) throw Object.assign(new Error('This pending operation requires the application storage contract that created it.'), { code: 'STARTUP_VERSION_MISMATCH' });
    await this.options.barrier.acquire();
    let operation = initial;
    this.publish({ operationId: operation.id, canCancelOperation: false });
    try {
      if (operation.kind === 'resume') {
        if (!this.options.resumeAutomaticExecution) throw new Error('Execution recovery owner is unavailable');
        await this.options.resumeAutomaticExecution(operation.generation!);
        await this.journal.write({ ...operation, phase: 'complete' });
        return;
      } else if (operation.kind === 'restore') {
        this.publish({ phase: 'restoring' });
        if (operation.phase !== 'reconciling') {
          operation = await new DataRestoreSession(this.options.userData, this.backups, this.journal, {
            checkpoint: (name) => this.checkpoint(name),
            progress: (completed, total) => this.publish({ progress: { completed, total } }),
            canSnapshotCurrent: async () => {
              const stores = await this.registry.inspect(this.options.userData, true);
              return !stores.some((store) => store.issue) && !(await this.options.barrier.inspectOutline()).error;
            },
            validateStaged: async (root) => {
              const inspected = await this.registry.inspect(root, true);
              const rejected = inspected.find((entry) => entry.issue);
              if (rejected) throw new Error(`${rejected.store.id}: ${rejected.issue!.message}`);
              const outline = await this.options.barrier.inspectOutline(root);
              if (outline.error) throw new Error(outline.error.message);
            },
          }).run(operation, this.options.applicationVersion);
          operation = { ...operation, phase: 'reconciling' };
          await this.journal.write(operation);
        }
        if (!this.options.prepareRestoredExecution) throw new Error('Restored work classification owner is unavailable');
        await this.options.prepareRestoredExecution(operation.generation!);
        const restoredSource = await this.backups.read(operation.sourceBackupId!);
        const inspected = await this.registry.inspect(this.options.userData, true, this.missingOriginalStores(restoredSource));
        const rejected = inspected.find((entry) => entry.issue);
        if (rejected) throw new Error(`${rejected.store.id}: ${rejected.issue!.message}`);
        await this.registry.establishVersions(this.options.userData, inspected, (name) => this.checkpoint(name));
        const restoredOutline = await this.options.barrier.inspectOutline();
        if (!restoredOutline.exists || !restoredOutline.hasTransactionLog) {
          await this.options.barrier.initializeOutline(operation.id);
        }
      } else if (operation.kind === 'repair-history') {
        this.publish({ phase: 'rebuilding' });
        operation = await new HistoryRepairSession(this.options.userData, this.historyRepair, this.backups, this.journal,
          (name) => this.checkpoint(name)).run(operation, this.options.applicationVersion);
      } else if (operation.kind === 'backup') {
        this.publish({ phase: 'backingUp' });
        await this.backups.create(this.options.applicationVersion, operation.backupId);
      } else {
        this.publish({ phase: 'migrating' });
        const original = await this.backups.read(operation.backupId);
        const inspections = await this.registry.inspect(this.options.userData, true, this.missingOriginalStores(original));
        const blocked = inspections.find((entry) => entry.issue);
        if (blocked) throw new Error(`${blocked.store.id}: ${blocked.issue!.message}`);
        const partialInitialization = !!original && !original.files.some((file) => file.path === 'outline-runtime/workspace/outline.snapshot.json');
        const sourceIssue = await this.inspectOutline(true, partialInitialization);
        if (sourceIssue) throw new Error(sourceIssue.message);
        if (operation.phase === 'preparing' || operation.phase === 'retaining') {
          operation = { ...operation, phase: 'retaining' };
          await this.journal.write(operation);
          await this.backups.create(this.options.applicationVersion, operation.backupId);
          operation = { ...operation, phase: 'installing' };
          await this.journal.write(operation);
        }
        await this.registry.establishVersions(this.options.userData, inspections, (name) => this.checkpoint(name));
        operation = { ...operation, phase: 'verifying' };
        await this.journal.write(operation);
        const outline = await this.options.barrier.inspectOutline();
        if (!outline.exists || !outline.hasTransactionLog) await this.options.barrier.initializeOutline(operation.id);
      }
      const validated = await this.registry.inspect(this.options.userData, true);
      const invalid = validated.find((entry) => entry.issue);
      if (invalid) throw new Error(`${invalid.store.id}: ${invalid.issue!.message}`);
      const outlineIssue = await this.inspectOutline(true);
      if (outlineIssue) throw new Error(outlineIssue.message);
      await this.writeManifest(validated);
      await this.checkpoint('before-normal-admission');
      await this.journal.write({ ...operation, phase: 'complete' });
      await this.backups.prune(new Set([operation.backupId, operation.sourceBackupId ?? '']));
    } finally { await this.options.barrier.release(); }
  }

  private async inspectOutline(full: boolean, allowPartialInitialization = false): Promise<DataLifecycleIssue | null> {
    if (!full) return null;
    try {
      const inspected = await this.options.barrier.inspectOutline();
      this.outlineInspection = inspected;
      if (inspected.error) throw Object.assign(new Error(inspected.error.message), inspected.error);
      if (inspected.exists && !inspected.hasTransactionLog && !allowPartialInitialization) throw new Error('Workspace history is incomplete. Preserve it and restore a verified source.');
      return null;
    } catch (error) {
      return { storeId: 'outline-workspace', domain: 'outline', reason: record(error) && error.code === 'STARTUP_VERSION_MISMATCH' ? 'future-version' : 'invalid-data',
        message: error instanceof Error ? error.message.slice(0, 1000) : 'Outline data could not be verified' };
    }
  }

  private manifestIssues(): DataLifecycleIssue[] {
    if (!this.manifest) return [];
    return Object.entries(this.manifest.storeVersions).flatMap(([id, version]) => {
      if (id === 'outline-workspace') return version > OUTLINE_STORAGE_VERSION
        ? [{ storeId: id, domain: 'outline' as const, reason: 'future-version' as const, message: 'This workspace requires a newer application.', foundVersion: version, expectedVersion: OUTLINE_STORAGE_VERSION }]
        : [];
      const store = this.registry.stores.find((entry) => entry.id === id);
      return !store || version > store.version ? [{ storeId: id, domain: store?.domain ?? 'desktop', reason: 'future-version' as const,
        message: 'This data requires a compatible newer application.', foundVersion: version, expectedVersion: store?.version }] : [];
    });
  }

  private async writeManifest(inspections: readonly StoreInspection[]): Promise<void> {
    const shared = this.outlineInspection?.identity;
    if (!shared || !this.outlineInspection?.hasTransactionLog) throw new Error('Workspace initialization has not produced verified canonical files');
    const manifest: DataManifest = { manifestVersion: 1, baselineRelease: this.manifest?.baselineRelease ?? this.options.applicationVersion,
      storeVersions: { ...Object.fromEntries(inspections.filter((entry) => entry.exists).map((entry) => [entry.store.id, entry.observedVersion])),
        'outline-workspace': OUTLINE_STORAGE_VERSION },
      identityReferences: shared ? { workspaceId: shared.workspaceId, documentId: shared.documentId } : {},
      operationId: null, lastVerifiedAt: Date.now() };
    await writeDurableJson(join(this.options.userData, 'data-manifest.json'), manifest, (name) => this.checkpoint(name));
    this.manifest = manifest;
  }

  private operation(kind: DataOperation['kind'], sourceBackupId?: string): DataOperation {
    return { version: 1, id: randomUUID(), kind, phase: 'preparing', createdAt: Date.now(), backupId: randomUUID(),
      sourceBackupId: sourceBackupId ?? null, completedRoots: [], generation: kind === 'restore' ? randomUUID() : null,
      targetDigest: this.registry.contractDigest(), applicationVersion: this.options.applicationVersion };
  }

  private missingOriginalStores(backup: import('./BackupStore').DataBackupManifest | null): ReadonlySet<string> {
    return new Set(backup ? this.registry.stores.filter((store) => !backup.files.some((file) => file.path === store.path)).map((store) => store.path) : []);
  }

  private publish(update: Partial<DataLifecycleState>): void {
    this.stateValue = { ...this.stateValue, ...update, revision: this.stateValue.revision + 1 };
    try { this.options.changed?.(this.stateValue); } catch { /* Observers cannot change admission. */ }
  }

  private async checkpoint(name: string): Promise<void> {
    if (this.stopped) throw new Error('Data maintenance paused at a recoverable checkpoint.');
    await this.options.checkpoint?.(name);
    if (this.stopped) throw new Error('Data maintenance paused at a recoverable checkpoint.');
  }
}

function decodeDataManifest(value: unknown): DataManifest | null {
  if (value === null) return null;
  if (!record(value) || value.manifestVersion !== 1) throw Object.assign(new Error('Unsupported data manifest version'), { code: 'STARTUP_VERSION_MISMATCH' });
  if (typeof value.baselineRelease !== 'string' || !record(value.storeVersions) || !record(value.identityReferences)
    || value.operationId !== null || !Number.isSafeInteger(value.lastVerifiedAt)
    || Object.values(value.storeVersions).some((version) => !Number.isSafeInteger(version) || (version as number) < 0)
    || Object.values(value.identityReferences).some((id) => typeof id !== 'string')) throw new Error('Invalid data manifest');
  return value as unknown as DataManifest;
}
