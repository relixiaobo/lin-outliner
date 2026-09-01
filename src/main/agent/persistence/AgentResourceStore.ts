import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, open, readFile, realpath, rm, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { ContentStateError, ContentStore, type ExactRevisionReference } from '../../../content';
import { MAX_THREAD_MANAGED_ATTACHMENT_BYTES } from '../../../core/agentAttachmentLimits';
import { safeAttachmentFileName } from '../../../core/agentAttachmentPaths';
import type { ThreadId, ThreadResourceReference } from '../../../core/agent/protocol';
import { isPathInside } from '../capabilities/agentAttachmentMaterialization';
import { openSqlite, type SqliteDatabase } from './sqlite';

const AGENT_CONTENT_NAMESPACE = 'agent';
const RESOURCE_ID_PATTERN = /^resource:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CANONICAL_MIME_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*(?:;[a-z0-9!#$&^_.+-]+=[a-z0-9!#$&^_.+-]+)*$/u;

export type AgentResourceAvailability = 'available' | 'unavailable' | 'denied';
export type AgentResourceScopeKind = 'managedWorkspace' | 'managedWorktree' | 'external';
export type AgentResourceUseIntent =
  | 'openDelivered'
  | 'readCurrentSource'
  | 'revealSource'
  | 'editSource'
  | 'observeExactRevision';

export interface AgentSourceLocator {
  readonly scopeId: string;
  readonly relativePath: string;
  readonly expectedKind: 'file' | 'directory';
}

export interface AgentResourceRecord {
  readonly referenceId: string;
  readonly displayName: string;
  readonly mediaType: string | null;
  readonly source: AgentSourceLocator | null;
  readonly revision: ExactRevisionReference | null;
  readonly availability: AgentResourceAvailability;
}

export type AgentResourceResolution =
  | {
      readonly status: 'resolvedExactRevision';
      readonly record: AgentResourceRecord;
      readonly path: string;
    }
  | {
      readonly status: 'resolvedSource';
      readonly record: AgentResourceRecord;
      readonly path: string;
      readonly entryKind: 'file' | 'directory';
    }
  | {
      readonly status: 'unavailable' | 'denied';
      readonly record: AgentResourceRecord | null;
      readonly reason: string;
    };

export interface WrittenAgentResource {
  readonly ref: ThreadResourceReference;
  readonly created: boolean;
}

export interface BeginAgentResourceUploadInput {
  readonly threadId: ThreadId;
  readonly attachmentId: string;
  readonly expectedBytes: number;
  readonly mimeType: string;
  readonly fileName: string;
}

interface PendingUpload extends BeginAgentResourceUploadInput {
  readonly uploadId: string;
  readonly path: string;
  readonly handle: FileHandle;
  byteLength: number;
}

interface ResourceRow {
  reference_id: string;
  display_name: string;
  media_type: string | null;
  source_json: string | null;
  revision_anchor_id: string | null;
  revision_byte_length: number | null;
  availability: string;
}

interface ScopeRow {
  scope_id: string;
  kind: string;
  root_path: string;
  readable: number;
  editable: number;
  revealable: number;
}

export class ThreadResourceQuotaError extends Error {
  constructor(message = 'Managed attachment exceeds the Thread storage quota.') {
    super(message);
    this.name = 'ThreadResourceQuotaError';
  }
}

export class AgentResourceStore {
  private readonly database: SqliteDatabase;
  private readonly content: Promise<ContentStore>;
  private readonly uploads = new Map<string, PendingUpload>();
  private mutationTail: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(
    private readonly databasePath: string,
    private readonly contentRoot: string,
    private readonly scratchRoot: string,
    private readonly now: () => number = Date.now,
    database?: SqliteDatabase,
  ) {
    this.database = database ?? openSqlite(databasePath);
    this.database.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS resource_references (
        reference_id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        media_type TEXT,
        source_json TEXT,
        revision_anchor_id TEXT,
        revision_byte_length INTEGER,
        availability TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        CHECK ((revision_anchor_id IS NULL) = (revision_byte_length IS NULL))
      );
      CREATE TABLE IF NOT EXISTS resource_links (
        thread_id TEXT NOT NULL,
        reference_id TEXT NOT NULL REFERENCES resource_references(reference_id) ON DELETE CASCADE,
        PRIMARY KEY (thread_id, reference_id)
      );
      CREATE INDEX IF NOT EXISTS resource_links_reference_idx
        ON resource_links(reference_id);
      CREATE TABLE IF NOT EXISTS resource_scopes (
        scope_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        root_path TEXT NOT NULL,
        readable INTEGER NOT NULL,
        editable INTEGER NOT NULL,
        revealable INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS final_citations (
        thread_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        marker_ordinal INTEGER NOT NULL,
        reference_id TEXT REFERENCES resource_references(reference_id) ON DELETE SET NULL,
        status TEXT NOT NULL,
        reason TEXT,
        PRIMARY KEY (thread_id, item_id, marker_ordinal)
      );
    `);
    this.content = ContentStore.open(contentRoot);
  }

  async initialize(
    liveReferences: ReadonlyMap<ThreadId, readonly ThreadResourceReference[]>,
    options: { readonly complete?: boolean } = {},
  ): Promise<void> {
    await this.content;
    await mkdir(path.join(this.scratchRoot, 'uploads'), { recursive: true, mode: 0o700 });
    await this.withMutation(async () => {
      this.database.exec('BEGIN IMMEDIATE');
      try {
        if (options.complete !== false) this.database.prepare('DELETE FROM resource_links').run();
        const insert = this.database.prepare(`
          INSERT OR IGNORE INTO resource_links(thread_id, reference_id) VALUES (?, ?)
        `);
        for (const [threadId, references] of liveReferences) {
          for (const ref of uniqueReferences(references)) {
            if (this.readRecord(ref)) insert.run(threadId, ref.id);
          }
        }
        this.database.exec('COMMIT');
      } catch (error) {
        this.database.exec('ROLLBACK');
        throw error;
      }
      // An incomplete snapshot can only add proven live links. Removing links or
      // collecting records would turn one recoverable Thread read failure into
      // permanent attachment loss.
      if (options.complete !== false) await this.collectOrphanRecords();
      await this.reconcileAnchors();
    });
  }

  registerScope(input: {
    readonly scopeId: string;
    readonly kind: AgentResourceScopeKind;
    readonly rootPath: string;
    readonly readable?: boolean;
    readonly editable?: boolean;
    readonly revealable?: boolean;
  }): void {
    assertOpaqueId(input.scopeId, 'scope');
    const rootPath = path.resolve(input.rootPath);
    this.database.prepare(`
      INSERT INTO resource_scopes(
        scope_id, kind, root_path, readable, editable, revealable, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(scope_id) DO UPDATE SET
        kind = excluded.kind,
        root_path = excluded.root_path,
        readable = excluded.readable,
        editable = excluded.editable,
        revealable = excluded.revealable
    `).run(
      input.scopeId,
      input.kind,
      rootPath,
      Number(input.readable ?? true),
      Number(input.editable ?? input.kind !== 'managedWorktree'),
      Number(input.revealable ?? true),
      this.now(),
    );
  }

  unregisterScope(scopeId: string): void {
    this.database.prepare('DELETE FROM resource_scopes WHERE scope_id = ?').run(scopeId);
  }

  async sourceLocator(
    scopeId: string,
    sourcePath: string,
    expectedKind: AgentSourceLocator['expectedKind'],
  ): Promise<AgentSourceLocator> {
    const scope = this.scope(scopeId);
    if (!scope) throw new Error('Agent resource scope is unavailable.');
    const [canonicalRoot, canonicalSource] = await Promise.all([
      realpath(scope.root_path),
      realpath(sourcePath),
    ]);
    if (!isPathInside(canonicalRoot, canonicalSource)) {
      throw new Error('Agent resource source is outside its admitted scope.');
    }
    const relativePath = path.relative(canonicalRoot, canonicalSource);
    if (!relativePath || path.isAbsolute(relativePath) || relativePath.startsWith('..')) {
      throw new Error('Agent resource source must name an entry inside its scope.');
    }
    return { scopeId, relativePath, expectedKind };
  }

  async beginUpload(input: BeginAgentResourceUploadInput): Promise<string> {
    validateMetadata(input.expectedBytes, input.mimeType, input.fileName);
    if (!input.attachmentId.trim()) throw new Error('Attachment id is required.');
    await this.assertThreadCapacity(input.threadId, input.expectedBytes);
    const uploadId = `upload:${randomUUID()}`;
    const directory = path.join(this.scratchRoot, 'uploads');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const uploadPath = path.join(directory, randomUUID());
    const handle = await open(uploadPath, 'wx', 0o600);
    this.uploads.set(uploadId, { ...input, uploadId, path: uploadPath, handle, byteLength: 0 });
    return uploadId;
  }

  async appendUpload(
    threadId: ThreadId,
    attachmentId: string,
    uploadId: string,
    bytes: Uint8Array,
  ): Promise<void> {
    const upload = this.requireUpload(threadId, attachmentId, uploadId);
    if (upload.byteLength + bytes.byteLength > upload.expectedBytes) {
      await this.abortUpload(threadId, attachmentId, uploadId);
      throw new Error('Managed attachment upload exceeded its declared byte length.');
    }
    const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const written = await upload.handle.write(buffer, offset, buffer.byteLength - offset);
      if (written.bytesWritten <= 0) throw new Error('Managed attachment upload made no write progress.');
      offset += written.bytesWritten;
    }
    upload.byteLength += buffer.byteLength;
  }

  async finishUpload(
    threadId: ThreadId,
    attachmentId: string,
    uploadId: string,
  ): Promise<ThreadResourceReference> {
    const upload = this.requireUpload(threadId, attachmentId, uploadId);
    this.uploads.delete(uploadId);
    try {
      await upload.handle.sync();
      await upload.handle.close();
      if (upload.byteLength !== upload.expectedBytes) {
        throw new Error('Managed attachment upload did not match its declared byte length.');
      }
      return (await this.capturePath({
        threadId,
        sourcePath: upload.path,
        mimeType: upload.mimeType,
        fileName: upload.fileName,
      })).ref;
    } finally {
      await upload.handle.close().catch(() => undefined);
      await rm(upload.path, { force: true }).catch(() => undefined);
    }
  }

  async abortUpload(threadId: ThreadId, attachmentId: string, uploadId: string): Promise<void> {
    const upload = this.requireUpload(threadId, attachmentId, uploadId);
    this.uploads.delete(uploadId);
    await upload.handle.close().catch(() => undefined);
    await rm(upload.path, { force: true });
  }

  async abortAllUploads(): Promise<void> {
    const uploads = [...this.uploads.values()];
    this.uploads.clear();
    await Promise.all(uploads.map(async (upload) => {
      await upload.handle.close().catch(() => undefined);
      await rm(upload.path, { force: true }).catch(() => undefined);
    }));
  }

  async writeBytes(
    threadId: ThreadId,
    bytes: Uint8Array,
    mimeType: string,
    fileName: string,
  ): Promise<WrittenAgentResource> {
    validateMetadata(bytes.byteLength, mimeType, fileName);
    await this.assertThreadCapacity(threadId, bytes.byteLength);
    const content = await this.content;
    const admission = await content.admitBytes(bytes);
    try {
      return await this.commitAdmission(threadId, admission.leaseId, {
        byteLength: admission.byteLength,
        mimeType,
        fileName,
        source: null,
      });
    } catch (error) {
      await content.releaseAdmissionLease(admission.leaseId).catch(() => undefined);
      throw error;
    }
  }

  async capturePath(input: {
    readonly threadId: ThreadId;
    readonly sourcePath: string;
    readonly mimeType: string;
    readonly fileName: string;
    readonly source?: AgentSourceLocator | null;
  }): Promise<WrittenAgentResource> {
    const content = await this.content;
    const admission = await content.admitPath(input.sourcePath);
    try {
      validateMetadata(admission.byteLength, input.mimeType, input.fileName);
      await this.assertThreadCapacity(input.threadId, admission.byteLength);
      return await this.commitAdmission(input.threadId, admission.leaseId, {
        byteLength: admission.byteLength,
        mimeType: input.mimeType,
        fileName: input.fileName,
        source: input.source ?? null,
      });
    } catch (error) {
      await content.releaseAdmissionLease(admission.leaseId).catch(() => undefined);
      throw error;
    }
  }

  async cloneReference(threadId: ThreadId, source: ThreadResourceReference): Promise<WrittenAgentResource> {
    const record = this.readRecord(source);
    if (!record?.revision) throw new Error('Agent resource exact revision is unavailable.');
    await this.assertThreadCapacity(threadId, record.revision.byteLength);
    const referenceId = `resource:${randomUUID()}`;
    const content = await this.content;
    const anchor = await content.cloneAnchor(
      record.revision.anchorId,
      AGENT_CONTENT_NAMESPACE,
      referenceId,
    );
    try {
      this.database.prepare(`
        INSERT INTO resource_references(
          reference_id, display_name, media_type, source_json,
          revision_anchor_id, revision_byte_length, availability, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'available', ?)
      `).run(
        referenceId,
        record.displayName,
        record.mediaType,
        record.source ? JSON.stringify(record.source) : null,
        anchor.anchorId,
        anchor.byteLength,
        this.now(),
      );
      this.link(threadId, referenceId);
    } catch (error) {
      await content.releaseAnchor(anchor.anchorId).catch(() => undefined);
      throw error;
    }
    return { ref: publicReference(referenceId, record.displayName, record.mediaType, anchor.byteLength), created: true };
  }

  createSourceReference(input: {
    readonly threadId: ThreadId;
    readonly displayName: string;
    readonly mediaType?: string | null;
    readonly source: AgentSourceLocator;
  }): ThreadResourceReference {
    validateSourceLocator(input.source);
    const displayName = safeAttachmentFileName(input.displayName);
    const referenceId = `resource:${randomUUID()}`;
    this.database.prepare(`
      INSERT INTO resource_references(
        reference_id, display_name, media_type, source_json,
        revision_anchor_id, revision_byte_length, availability, created_at
      ) VALUES (?, ?, ?, ?, NULL, NULL, 'available', ?)
    `).run(
      referenceId,
      displayName,
      input.mediaType ?? null,
      JSON.stringify(input.source),
      this.now(),
    );
    this.link(input.threadId, referenceId);
    return publicReference(referenceId, displayName, input.mediaType ?? null, 0);
  }

  linkReference(threadId: ThreadId, ref: ThreadResourceReference): boolean {
    if (!this.readRecord(ref)) return false;
    this.link(threadId, ref.id);
    return true;
  }

  hasThreadLink(threadId: ThreadId, ref: ThreadResourceReference): boolean {
    if (!this.readRecord(ref)) return false;
    return Boolean(this.database.prepare(`
      SELECT 1 FROM resource_links WHERE thread_id = ? AND reference_id = ?
    `).get(threadId, ref.id));
  }

  record(ref: ThreadResourceReference): AgentResourceRecord | null {
    return this.readRecord(ref);
  }

  recordCitation(input: {
    readonly threadId: ThreadId;
    readonly itemId: string;
    readonly markerOrdinal: number;
    readonly ref: ThreadResourceReference | null;
    readonly status: 'available' | 'unavailable' | 'denied';
    readonly reason?: string;
  }): void {
    this.database.prepare(`
      INSERT INTO final_citations(
        thread_id, item_id, marker_ordinal, reference_id, status, reason
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(thread_id, item_id, marker_ordinal) DO UPDATE SET
        reference_id = excluded.reference_id,
        status = excluded.status,
        reason = excluded.reason
    `).run(
      input.threadId,
      input.itemId,
      input.markerOrdinal,
      input.ref?.id ?? null,
      input.status,
      input.reason ?? null,
    );
  }

  citationReferences(threadId: ThreadId): ThreadResourceReference[] {
    const rows = this.database.prepare(`
      SELECT reference.* FROM final_citations citation
      JOIN resource_references reference ON reference.reference_id = citation.reference_id
      WHERE citation.thread_id = ?
      ORDER BY citation.item_id, citation.marker_ordinal
    `).all(threadId) as ResourceRow[];
    return rows.map((row) => {
      const record = recordFromRow(row);
      return publicReference(
        record.referenceId,
        record.displayName,
        record.mediaType,
        record.revision?.byteLength ?? 0,
      );
    });
  }

  async resolve(ref: ThreadResourceReference, intent: AgentResourceUseIntent): Promise<AgentResourceResolution> {
    const record = this.readRecord(ref);
    if (!record) return { status: 'unavailable', record: null, reason: 'referenceMissing' };
    if (record.availability === 'denied') return { status: 'denied', record, reason: 'referenceDenied' };
    if (intent === 'openDelivered' || intent === 'observeExactRevision') {
      if (!record.revision) return { status: 'unavailable', record, reason: 'revisionMissing' };
      try {
        return {
          status: 'resolvedExactRevision',
          record,
          path: await (await this.content).verifiedPath(
            record.revision,
            AGENT_CONTENT_NAMESPACE,
            record.referenceId,
          ),
        };
      } catch (error) {
        this.markUnavailable(record.referenceId);
        return { status: 'unavailable', record, reason: contentErrorReason(error) };
      }
    }
    if (!record.source) return { status: 'unavailable', record, reason: 'sourceMissing' };
    const scope = this.scope(record.source.scopeId);
    if (!scope || !scope.readable) return { status: 'denied', record, reason: 'scopeDenied' };
    if (intent === 'editSource' && !scope.editable) return { status: 'denied', record, reason: 'editDenied' };
    if (intent === 'revealSource' && !scope.revealable) return { status: 'denied', record, reason: 'revealDenied' };
    try {
      const canonicalRoot = await realpath(scope.root_path);
      const candidate = path.resolve(canonicalRoot, record.source.relativePath);
      const canonical = await realpath(candidate);
      if (!isPathInside(canonicalRoot, canonical)) {
        return { status: 'denied', record, reason: 'sourceEscapedScope' };
      }
      const entry = await lstat(canonical);
      const entryKind = entry.isFile() ? 'file' : entry.isDirectory() ? 'directory' : null;
      if (!entryKind || entryKind !== record.source.expectedKind || entry.isSymbolicLink()) {
        return { status: 'unavailable', record, reason: 'sourceChangedKind' };
      }
      return { status: 'resolvedSource', record, path: canonical, entryKind };
    } catch {
      return { status: 'unavailable', record, reason: 'sourceMissing' };
    }
  }

  async useExactPath<T>(ref: ThreadResourceReference, use: (path: string) => Promise<T>): Promise<T | null> {
    const resolution = await this.resolve(ref, 'observeExactRevision');
    return resolution.status === 'resolvedExactRevision' ? use(resolution.path) : null;
  }

  async readExact(ref: ThreadResourceReference): Promise<Buffer | null> {
    return this.useExactPath(ref, async (resolvedPath) => readFile(resolvedPath));
  }

  async copyForObservation(ref: ThreadResourceReference, targetDirectory: string): Promise<string | null> {
    const sourcePath = await this.useExactPath(ref, async (resolved) => resolved);
    if (!sourcePath) return null;
    const directory = await lstat(targetDirectory);
    if (!directory.isDirectory() || directory.isSymbolicLink()) {
      throw new Error('Agent resource observation target is not a safe directory.');
    }
    const target = path.join(targetDirectory, ref.fileName);
    await copyFile(sourcePath, target, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
    const copied = await lstat(target);
    if (!copied.isFile() || copied.isSymbolicLink() || copied.size !== ref.byteLength) {
      await rm(target, { force: true });
      throw new Error('Agent resource observation copy is invalid.');
    }
    return target;
  }

  async setThreadReferences(threadId: ThreadId, references: readonly ThreadResourceReference[]): Promise<void> {
    await this.withMutation(async () => {
      this.database.exec('BEGIN IMMEDIATE');
      try {
        this.database.prepare('DELETE FROM resource_links WHERE thread_id = ?').run(threadId);
        for (const ref of uniqueReferences(references)) {
          if (this.readRecord(ref)) this.link(threadId, ref.id);
        }
        this.database.exec('COMMIT');
      } catch (error) {
        this.database.exec('ROLLBACK');
        throw error;
      }
      await this.collectOrphanRecords();
    });
  }

  async discardThreadReference(threadId: ThreadId, ref: ThreadResourceReference): Promise<boolean> {
    if (!this.readRecord(ref)) return false;
    return this.withMutation(async () => {
      const removed = Number(this.database.prepare(`
        DELETE FROM resource_links WHERE thread_id = ? AND reference_id = ?
      `).run(threadId, ref.id).changes) > 0;
      await this.collectOrphanRecords();
      return removed;
    });
  }

  async deleteThread(threadId: ThreadId): Promise<void> {
    await this.withMutation(async () => {
      this.database.prepare('DELETE FROM final_citations WHERE thread_id = ?').run(threadId);
      this.database.prepare('DELETE FROM resource_links WHERE thread_id = ?').run(threadId);
      await this.collectOrphanRecords();
    });
  }

  async reconcileAnchors(): Promise<readonly string[]> {
    const rows = this.database.prepare(`
      SELECT * FROM resource_references
      WHERE revision_anchor_id IS NOT NULL
      ORDER BY reference_id
    `).all() as ResourceRow[];
    const expected = new Map(rows.map((row) => [row.revision_anchor_id!, row]));
    const anchors = await (await this.content).anchors(AGENT_CONTENT_NAMESPACE);
    const actual = new Map(anchors.map((anchor) => [anchor.anchorId, anchor]));
    for (const [anchorId, row] of expected) {
      const anchor = actual.get(anchorId);
      if (!anchor
        || anchor.recordKey !== row.reference_id
        || anchor.byteLength !== row.revision_byte_length) {
        this.markUnavailable(row.reference_id);
      }
    }
    const released: string[] = [];
    for (const anchor of anchors) {
      if (expected.has(anchor.anchorId)) continue;
      if (await (await this.content).releaseAnchor(anchor.anchorId)) released.push(anchor.anchorId);
    }
    return released;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.abortAllUploads();
    await this.mutationTail.catch(() => undefined);
    (await this.content).close();
    this.database.close();
  }

  private async commitAdmission(
    threadId: ThreadId,
    admissionLeaseId: string,
    metadata: {
      readonly byteLength: number;
      readonly mimeType: string;
      readonly fileName: string;
      readonly source: AgentSourceLocator | null;
    },
  ): Promise<WrittenAgentResource> {
    return this.withMutation(async () => {
      const referenceId = `resource:${randomUUID()}`;
      const content = await this.content;
      const anchor = await content.createAnchor(
        admissionLeaseId,
        AGENT_CONTENT_NAMESPACE,
        referenceId,
      );
      try {
        this.database.exec('BEGIN IMMEDIATE');
        this.database.prepare(`
          INSERT INTO resource_references(
            reference_id, display_name, media_type, source_json,
            revision_anchor_id, revision_byte_length, availability, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'available', ?)
        `).run(
          referenceId,
          safeAttachmentFileName(metadata.fileName),
          metadata.mimeType,
          metadata.source ? JSON.stringify(metadata.source) : null,
          anchor.anchorId,
          anchor.byteLength,
          this.now(),
        );
        this.link(threadId, referenceId);
        this.database.exec('COMMIT');
      } catch (error) {
        try { this.database.exec('ROLLBACK'); } catch { /* transaction did not start */ }
        await content.releaseAnchor(anchor.anchorId).catch(() => undefined);
        throw error;
      }
      return {
        ref: publicReference(referenceId, metadata.fileName, metadata.mimeType, anchor.byteLength),
        created: true,
      };
    });
  }

  private readRecord(ref: ThreadResourceReference): AgentResourceRecord | null {
    validatePublicReference(ref);
    const row = this.database.prepare(`
      SELECT * FROM resource_references WHERE reference_id = ?
    `).get(ref.id) as ResourceRow | undefined;
    if (!row) return null;
    const record = recordFromRow(row);
    if (
      record.displayName !== ref.fileName
      || (record.mediaType ?? 'application/octet-stream') !== ref.mimeType
      || (record.revision?.byteLength ?? 0) !== ref.byteLength
    ) return null;
    return record;
  }

  private scope(scopeId: string): ScopeRow | null {
    return (this.database.prepare(`
      SELECT * FROM resource_scopes WHERE scope_id = ?
    `).get(scopeId) as ScopeRow | undefined) ?? null;
  }

  private link(threadId: ThreadId, referenceId: string): void {
    this.database.prepare(`
      INSERT OR IGNORE INTO resource_links(thread_id, reference_id) VALUES (?, ?)
    `).run(threadId, referenceId);
  }

  private markUnavailable(referenceId: string): void {
    this.database.prepare(`
      UPDATE resource_references SET availability = 'unavailable' WHERE reference_id = ?
    `).run(referenceId);
  }

  private async assertThreadCapacity(threadId: ThreadId, incomingBytes: number): Promise<void> {
    const row = this.database.prepare(`
      SELECT COALESCE(SUM(reference.revision_byte_length), 0) AS byte_length
      FROM resource_links link
      JOIN resource_references reference ON reference.reference_id = link.reference_id
      WHERE link.thread_id = ? AND reference.revision_anchor_id IS NOT NULL
    `).get(threadId) as { byte_length: number | bigint };
    const storedBytes = Number(row.byte_length);
    if (storedBytes + incomingBytes > MAX_THREAD_MANAGED_ATTACHMENT_BYTES) {
      throw new ThreadResourceQuotaError();
    }
  }

  private requireUpload(threadId: ThreadId, attachmentId: string, uploadId: string): PendingUpload {
    const upload = this.uploads.get(uploadId);
    if (!upload || upload.threadId !== threadId || upload.attachmentId !== attachmentId) {
      throw new Error('Unknown managed attachment upload.');
    }
    return upload;
  }

  private async collectOrphanRecords(): Promise<void> {
    const rows = this.database.prepare(`
      SELECT reference.* FROM resource_references reference
      LEFT JOIN resource_links link ON link.reference_id = reference.reference_id
      WHERE link.reference_id IS NULL
      ORDER BY reference.reference_id
    `).all() as ResourceRow[];
    if (rows.length === 0) return;
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const remove = this.database.prepare('DELETE FROM resource_references WHERE reference_id = ?');
      for (const row of rows) remove.run(row.reference_id);
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
    const content = await this.content;
    for (const row of rows) {
      if (row.revision_anchor_id) await content.releaseAnchor(row.revision_anchor_id).catch(() => undefined);
    }
    await content.collectGarbage();
  }

  private withMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation, operation);
    this.mutationTail = result.catch(() => undefined);
    return result;
  }
}

function publicReference(
  referenceId: string,
  displayName: string,
  mediaType: string | null,
  byteLength: number,
): ThreadResourceReference {
  return Object.freeze({
    id: referenceId,
    mimeType: mediaType ?? 'application/octet-stream',
    byteLength,
    fileName: safeAttachmentFileName(displayName),
  });
}

function recordFromRow(row: ResourceRow): AgentResourceRecord {
  const source = row.source_json ? JSON.parse(row.source_json) as AgentSourceLocator : null;
  if (source) validateSourceLocator(source);
  const revision = row.revision_anchor_id === null
    ? null
    : { anchorId: row.revision_anchor_id, byteLength: row.revision_byte_length! };
  if (!['available', 'unavailable', 'denied'].includes(row.availability)) {
    throw new Error('Invalid Agent resource availability.');
  }
  return {
    referenceId: row.reference_id,
    displayName: row.display_name,
    mediaType: row.media_type,
    source,
    revision,
    availability: row.availability as AgentResourceAvailability,
  };
}

function validateSourceLocator(locator: AgentSourceLocator): void {
  assertOpaqueId(locator.scopeId, 'scope');
  if (!locator.relativePath || path.isAbsolute(locator.relativePath) || locator.relativePath.startsWith('..')) {
    throw new Error('Invalid Agent resource source locator.');
  }
  if (locator.expectedKind !== 'file' && locator.expectedKind !== 'directory') {
    throw new Error('Invalid Agent resource source kind.');
  }
}

function validateMetadata(byteLength: number, mimeType: string, fileName: string): void {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) throw new Error('Invalid Agent resource byte length.');
  if (!CANONICAL_MIME_PATTERN.test(mimeType) || mimeType !== mimeType.trim().toLowerCase()) {
    throw new Error('Invalid Agent resource MIME type.');
  }
  if (!fileName.trim() || safeAttachmentFileName(fileName) !== fileName) {
    throw new Error('Invalid Agent resource file name.');
  }
}

function validatePublicReference(ref: ThreadResourceReference): void {
  if (!RESOURCE_ID_PATTERN.test(ref.id)) throw new Error('Invalid Agent resource reference id.');
  validateMetadata(ref.byteLength, ref.mimeType, ref.fileName);
}

function uniqueReferences(references: readonly ThreadResourceReference[]): ThreadResourceReference[] {
  return [...new Map(references.map((ref) => [ref.id, ref])).values()];
}

function assertOpaqueId(value: string, kind: string): void {
  if (!value.trim() || value.length > 512) throw new Error(`Invalid Agent resource ${kind} id.`);
}

function contentErrorReason(error: unknown): string {
  if (error instanceof ContentStateError) return error.code;
  return 'revisionUnavailable';
}
