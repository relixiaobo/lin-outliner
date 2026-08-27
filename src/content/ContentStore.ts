import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import {
  openContentDatabase,
  retryContentSqliteBusy,
  type ContentSqliteDatabase,
} from './sqlite';
import {
  ContentIntegrityError,
  ContentStateError,
  type ContentAnchorCoordinate,
  type ContentAdmissionLease,
  type ContentGarbageCollectionResult,
  type ContentRetentionAnchor,
  type ContentStoreOptions,
  type ExactRevisionReference,
} from './types';

const CONTENT_SCHEMA_VERSION = 2;
const DEFAULT_ADMISSION_LEASE_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_MAXIMUM_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_PUBLICATION_STALE_MS = 30_000;
const PUBLICATION_WAIT_ATTEMPTS = 3_000;

type RevisionState = 'publishing' | 'published' | 'deleting' | 'quarantined';

interface PhysicalRevisionReference {
  readonly digest: string;
  readonly byteLength: number;
}

interface RevisionRow {
  readonly digest: string;
  readonly byte_length: number;
  readonly state: RevisionState;
  readonly owner_pid: number | null;
  readonly owner_token: string | null;
  readonly updated_at: number;
}

interface PublicationRow extends RevisionRow {
  readonly temp_path: string;
}

interface AdmissionStageRow {
  readonly stage_id: string;
  readonly owner_pid: number;
  readonly owner_token: string;
  readonly created_at: number;
  readonly updated_at: number;
}

interface AdmissionStage {
  readonly stageId: string;
  readonly ownerToken: string;
  readonly tempPath: string;
}

interface AnchorRow {
  readonly anchor_id: string;
  readonly namespace: string;
  readonly record_key: string;
  readonly digest: string;
  readonly byte_length: number;
  readonly created_at: number;
}

interface DeletionRow {
  readonly digest: string;
  readonly byte_length: number;
}

export class ContentStore {
  readonly databasePath: string;
  readonly revisionsRoot: string;
  readonly stagingRoot: string;
  readonly quarantineRoot: string;
  private readonly now: () => Date;
  private readonly admissionLeaseMs: number;
  private readonly maximumBytes: number;
  private readonly publicationStaleMs: number;
  private closed = false;

  private constructor(
    readonly root: string,
    private readonly database: ContentSqliteDatabase,
    private readonly options: ContentStoreOptions,
  ) {
    this.databasePath = path.join(root, 'state.sqlite');
    this.revisionsRoot = path.join(root, 'blobs');
    this.stagingRoot = path.join(root, 'staging');
    this.quarantineRoot = path.join(root, 'quarantine');
    this.now = options.now ?? (() => new Date());
    this.admissionLeaseMs = Math.max(1, options.admissionLeaseMs ?? DEFAULT_ADMISSION_LEASE_MS);
    this.maximumBytes = Math.max(1, options.maximumBytes ?? DEFAULT_MAXIMUM_BYTES);
    this.publicationStaleMs = Math.max(1, options.publicationStaleMs ?? DEFAULT_PUBLICATION_STALE_MS);
  }

  static async open(root: string, options: ContentStoreOptions = {}): Promise<ContentStore> {
    const resolved = path.resolve(root);
    await ensurePrivateDirectory(resolved);
    await Promise.all([
      ensurePrivateDirectory(path.join(resolved, 'blobs')),
      ensurePrivateDirectory(path.join(resolved, 'staging')),
      ensurePrivateDirectory(path.join(resolved, 'quarantine')),
    ]);
    const database = await openContentDatabase(path.join(resolved, 'state.sqlite'));
    const store = new ContentStore(resolved, database, options);
    try {
      await store.initializeSchema();
      await store.repairInterruptedState();
      return store;
    } catch (error) {
      store.close();
      throw error;
    }
  }

  admitBytes(
    bytes: Uint8Array,
    options: { readonly leaseId?: string; readonly leaseMs?: number } = {},
  ): Promise<ContentAdmissionLease> {
    return this.admit([bytes], options);
  }

  async admitPath(
    sourcePath: string,
    options: { readonly leaseId?: string; readonly leaseMs?: number } = {},
  ): Promise<ContentAdmissionLease> {
    const source = await stat(sourcePath);
    if (!source.isFile()) throw new Error(`Content admission requires a regular file: ${sourcePath}`);
    return this.admit(createReadStream(sourcePath), options);
  }

  async admit(
    source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
    options: { readonly leaseId?: string; readonly leaseMs?: number } = {},
  ): Promise<ContentAdmissionLease> {
    this.assertOpen();
    const stage = await this.beginAdmissionStage();
    let handle: FileHandle;
    try {
      handle = await open(stage.tempPath, 'wx', 0o600);
    } catch (error) {
      await this.forgetAdmissionStage(stage).catch(() => undefined);
      throw error;
    }
    const hash = createHash('sha256');
    let byteLength = 0;
    try {
      for await (const value of source) {
        const chunk = Buffer.from(value);
        byteLength += chunk.byteLength;
        if (byteLength > this.maximumBytes) throw new Error(`Content exceeds the ${this.maximumBytes} byte limit.`);
        hash.update(chunk);
        await handle.write(chunk);
      }
      await handle.sync();
      await handle.close();
      await this.touchAdmissionStage(stage);
    } catch (error) {
      await handle.close().catch(() => undefined);
      await this.cleanupAdmissionStage(stage).catch(() => undefined);
      throw error;
    }

    const reference: PhysicalRevisionReference = { digest: hash.digest('hex'), byteLength };
    const leaseId = options.leaseId ?? `admission:${crypto.randomUUID()}`;
    const expiresAt = new Date(this.now().getTime() + Math.max(1, options.leaseMs ?? this.admissionLeaseMs));
    try {
      for (let attempt = 0; attempt < PUBLICATION_WAIT_ATTEMPTS; attempt += 1) {
        const token = crypto.randomUUID();
        const claim = await this.claimPublication(reference, stage, token);
        if (claim === 'owned') {
          await this.options.hooks?.afterPublicationClaim?.();
          await this.publishOwned(reference, stage.tempPath, token, leaseId, expiresAt);
          return { leaseId, byteLength, expiresAt: expiresAt.toISOString() };
        }
        if (claim === 'published') {
          await this.insertAdmissionLease(leaseId, reference, expiresAt);
          await this.verifyReference(reference);
          await this.cleanupAdmissionStage(stage).catch(() => undefined);
          return { leaseId, byteLength, expiresAt: expiresAt.toISOString() };
        }
        await this.repairStalePublication(reference.digest);
        await delay(Math.min(50, 2 + Math.floor(attempt / 25)));
      }
      throw new ContentStateError('Content publication did not settle.', 'unavailable');
    } catch (error) {
      await this.cleanupAdmissionStage(stage).catch(() => undefined);
      throw error;
    }
  }

  async createAnchor(
    admissionLeaseId: string,
    namespace: string,
    recordKey: string,
    anchorId = `anchor:${crypto.randomUUID()}`,
  ): Promise<ContentRetentionAnchor> {
    assertOpaqueId(admissionLeaseId, 'admission lease');
    assertOpaqueId(anchorId, 'anchor');
    const normalizedNamespace = namespace.trim();
    const normalizedRecordKey = recordKey.trim();
    assertOpaqueId(normalizedNamespace, 'anchor namespace');
    assertOpaqueId(normalizedRecordKey, 'anchor record key');
    const createdAt = this.now();
    let byteLength = 0;
    await this.immediateTransaction(() => {
      this.assertAnchorIdAvailable(anchorId);
      const lease = this.database.prepare(`
        SELECT digest, byte_length, expires_at
        FROM admission_leases WHERE lease_id = ?
      `).get<{ digest: string; byte_length: number; expires_at: number }>(admissionLeaseId);
      if (!lease || lease.expires_at <= createdAt.getTime()) {
        throw new ContentStateError('Content admission lease is unavailable.', 'not_found');
      }
      const reference = { digest: lease.digest, byteLength: lease.byte_length };
      const revision = this.revision(reference.digest);
      if (!revision || revision.state !== 'published' || revision.byte_length !== reference.byteLength) {
        throw unavailableReference(reference, revision?.state);
      }
      byteLength = reference.byteLength;
      this.database.prepare(`
        INSERT INTO retention_anchors(anchor_id, namespace, record_key, digest, byte_length, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        anchorId,
        normalizedNamespace,
        normalizedRecordKey,
        reference.digest,
        reference.byteLength,
        createdAt.getTime(),
      );
      this.database.prepare('DELETE FROM admission_leases WHERE lease_id = ?').run(admissionLeaseId);
    });
    return {
      anchorId,
      namespace: normalizedNamespace,
      recordKey: normalizedRecordKey,
      byteLength,
      createdAt: createdAt.toISOString(),
    };
  }

  async cloneAnchor(
    sourceAnchorId: string,
    namespace: string,
    recordKey: string,
    anchorId = `anchor:${crypto.randomUUID()}`,
  ): Promise<ContentRetentionAnchor> {
    assertOpaqueId(sourceAnchorId, 'anchor');
    assertOpaqueId(anchorId, 'anchor');
    const normalizedNamespace = namespace.trim();
    const normalizedRecordKey = recordKey.trim();
    assertOpaqueId(normalizedNamespace, 'anchor namespace');
    assertOpaqueId(normalizedRecordKey, 'anchor record key');
    const createdAt = this.now();
    let source: AnchorRow | undefined;
    await this.immediateTransaction(() => {
      this.assertAnchorIdAvailable(anchorId);
      source = this.database.prepare('SELECT * FROM retention_anchors WHERE anchor_id = ?').get<AnchorRow>(sourceAnchorId);
      if (!source) throw new ContentStateError('Content anchor is unavailable.', 'not_found');
      const revision = this.revision(source.digest);
      if (!revision || revision.state !== 'published' || revision.byte_length !== source.byte_length) {
        throw unavailableReference({ digest: source.digest, byteLength: source.byte_length }, revision?.state);
      }
      this.database.prepare(`
        INSERT INTO retention_anchors(anchor_id, namespace, record_key, digest, byte_length, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        anchorId,
        normalizedNamespace,
        normalizedRecordKey,
        source.digest,
        source.byte_length,
        createdAt.getTime(),
      );
    });
    return {
      anchorId,
      namespace: normalizedNamespace,
      recordKey: normalizedRecordKey,
      byteLength: source!.byte_length,
      createdAt: createdAt.toISOString(),
    };
  }

  async releaseAnchor(anchorId: string): Promise<boolean> {
    assertOpaqueId(anchorId, 'anchor');
    return this.immediateTransaction(() => {
      const removed = this.database.prepare('DELETE FROM retention_anchors WHERE anchor_id = ?').run(anchorId).changes;
      if (removed === 0) return false;
      this.database.prepare(`
        INSERT INTO retired_anchor_ids(anchor_id, released_at) VALUES (?, ?)
      `).run(anchorId, this.now().getTime());
      return true;
    });
  }

  async releaseAdmissionLease(leaseId: string): Promise<boolean> {
    assertOpaqueId(leaseId, 'admission lease');
    return this.immediateTransaction(() => (
      this.database.prepare('DELETE FROM admission_leases WHERE lease_id = ?').run(leaseId).changes > 0
    ));
  }

  anchors(namespace: string): Promise<readonly ContentRetentionAnchor[]> {
    const normalizedNamespace = namespace.trim();
    assertOpaqueId(normalizedNamespace, 'anchor namespace');
    return this.readTransaction(() => this.database.prepare(`
      SELECT anchor_id, namespace, record_key, digest, byte_length, created_at
      FROM retention_anchors WHERE namespace = ? ORDER BY anchor_id
    `).all<AnchorRow>(normalizedNamespace).map((row) => ({
      anchorId: row.anchor_id,
      namespace: row.namespace,
      recordKey: row.record_key,
      byteLength: row.byte_length,
      createdAt: new Date(row.created_at).toISOString(),
    })));
  }

  async verifiedPath(reference: ExactRevisionReference, namespace: string, recordKey: string): Promise<string> {
    assertExactRevisionReference(reference);
    const normalizedNamespace = namespace.trim();
    const normalizedRecordKey = recordKey.trim();
    assertOpaqueId(normalizedNamespace, 'anchor namespace');
    assertOpaqueId(normalizedRecordKey, 'anchor record key');
    const anchor = await this.readTransaction(() => (
      this.database.prepare('SELECT * FROM retention_anchors WHERE anchor_id = ?').get<AnchorRow>(reference.anchorId)
    ));
    if (!anchor
      || anchor.namespace !== normalizedNamespace
      || anchor.record_key !== normalizedRecordKey
      || anchor.byte_length !== reference.byteLength) {
      throw new ContentStateError('Content anchor does not match the requested exact revision coordinate.', 'not_found');
    }
    const physical = { digest: anchor.digest, byteLength: anchor.byte_length };
    await this.verifyReference(physical);
    return this.revisionPath(physical.digest);
  }

  async verifiedAdmissionPath(leaseId: string): Promise<string> {
    assertOpaqueId(leaseId, 'admission lease');
    const lease = await this.readTransaction(() => this.database.prepare(`
      SELECT digest, byte_length, expires_at
      FROM admission_leases WHERE lease_id = ?
    `).get<{ digest: string; byte_length: number; expires_at: number }>(leaseId));
    if (!lease
      || lease.expires_at <= this.now().getTime()) {
      throw new ContentStateError('Content admission lease is unavailable.', 'not_found');
    }
    const reference = { digest: lease.digest, byteLength: lease.byte_length };
    await this.verifyReference(reference);
    return this.revisionPath(reference.digest);
  }

  async readVerified(reference: ExactRevisionReference, namespace: string, recordKey: string): Promise<Uint8Array> {
    return readFile(await this.verifiedPath(reference, namespace, recordKey));
  }

  async byteLengthOfDistinctRevisions(
    coordinates: readonly ContentAnchorCoordinate[],
    excluding: readonly ContentAnchorCoordinate[] = [],
  ): Promise<number> {
    if (coordinates.length === 0) return 0;
    return this.readTransaction(() => {
      const resolve = (coordinate: ContentAnchorCoordinate): AnchorRow => {
        assertExactRevisionReference(coordinate.reference);
        const normalizedNamespace = coordinate.namespace.trim();
        const normalizedRecordKey = coordinate.recordKey.trim();
        assertOpaqueId(normalizedNamespace, 'anchor namespace');
        assertOpaqueId(normalizedRecordKey, 'anchor record key');
        const anchor = this.database.prepare(`
          SELECT * FROM retention_anchors WHERE anchor_id = ?
        `).get<AnchorRow>(coordinate.reference.anchorId);
        if (!anchor
          || anchor.namespace !== normalizedNamespace
          || anchor.record_key !== normalizedRecordKey
          || anchor.byte_length !== coordinate.reference.byteLength) {
          throw new ContentStateError('Content anchor coordinate is unavailable.', 'not_found');
        }
        const revision = this.revision(anchor.digest);
        if (!revision || revision.state !== 'published' || revision.byte_length !== anchor.byte_length) {
          throw unavailableReference({ digest: anchor.digest, byteLength: anchor.byte_length }, revision?.state);
        }
        return anchor;
      };
      const excludedDigests = new Set(excluding.map((coordinate) => resolve(coordinate).digest));
      const digests = new Set<string>();
      let byteLength = 0;
      for (const coordinate of coordinates) {
        const anchor = resolve(coordinate);
        if (excludedDigests.has(anchor.digest) || digests.has(anchor.digest)) continue;
        digests.add(anchor.digest);
        byteLength += anchor.byte_length;
      }
      return byteLength;
    });
  }

  private async verifyReference(reference: PhysicalRevisionReference): Promise<void> {
    assertPhysicalRevisionReference(reference);
    const revision = await this.readTransaction(() => this.revision(reference.digest));
    if (!revision || revision.byte_length !== reference.byteLength || revision.state !== 'published') {
      throw unavailableReference(reference, revision?.state);
    }
    const actual = await fileDigest(this.revisionPath(reference.digest)).catch(() => null);
    if (!actual || actual.digest !== reference.digest || actual.byteLength !== reference.byteLength) {
      await this.quarantine(reference);
      throw new ContentIntegrityError('Exact revision failed physical integrity verification.');
    }
  }

  async collectGarbage(): Promise<ContentGarbageCollectionResult> {
    await this.repairAdmissionStages();
    const now = this.now().getTime();
    const selected = await this.immediateTransaction(() => {
      this.database.prepare('DELETE FROM admission_leases WHERE expires_at <= ?').run(now);
      const rows = this.database.prepare(`
        SELECT r.digest, r.byte_length
        FROM exact_revisions r
        WHERE r.state = 'published'
          AND NOT EXISTS (SELECT 1 FROM admission_leases l WHERE l.digest = r.digest AND l.expires_at > ?)
          AND NOT EXISTS (SELECT 1 FROM retention_anchors a WHERE a.digest = r.digest)
        ORDER BY r.digest
      `).all<{ digest: string; byte_length: number }>(now);
      const mark = this.database.prepare(`
        UPDATE exact_revisions SET state = 'deleting', owner_pid = NULL, owner_token = NULL, updated_at = ?
        WHERE digest = ? AND state = 'published'
      `);
      const journal = this.database.prepare(`
        INSERT OR REPLACE INTO deletion_journal(digest, byte_length, marked_at)
        VALUES (?, ?, ?)
      `);
      const result: PhysicalRevisionReference[] = [];
      for (const row of rows) {
        if (mark.run(now, row.digest).changes === 0) continue;
        journal.run(row.digest, row.byte_length, now);
        result.push({ digest: row.digest, byteLength: row.byte_length });
      }
      return result;
    });
    if (selected.length === 0) return { revisionCount: 0, byteLength: 0 };
    await this.options.hooks?.afterDeletionMarked?.();
    for (const reference of selected) await this.finishDeletion(reference);
    return {
      revisionCount: selected.length,
      byteLength: selected.reduce((total, reference) => total + reference.byteLength, 0),
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }

  private async initializeSchema(): Promise<void> {
    await this.immediateTransaction(() => {
      const existingTables = this.database.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
        ORDER BY name
      `).all<{ name: string }>();
      if (existingTables.length > 0) {
        const metaExists = existingTables.some((entry) => entry.name === 'content_meta');
        const version = metaExists
          ? this.database.prepare("SELECT value FROM content_meta WHERE key = 'schema_version'")
              .get<{ value: string }>()
          : undefined;
        if (!version || version.value !== String(CONTENT_SCHEMA_VERSION)) {
          throw new Error('Unsupported or legacy ContentStore format; reset userData manually before startup.');
        }
      }
      this.database.exec(`
      CREATE TABLE IF NOT EXISTS content_meta(
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS exact_revisions(
        digest TEXT PRIMARY KEY,
        byte_length INTEGER NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('publishing', 'published', 'deleting', 'quarantined')),
        owner_pid INTEGER,
        owner_token TEXT,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS admission_staging(
        stage_id TEXT PRIMARY KEY,
        owner_pid INTEGER NOT NULL,
        owner_token TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS publication_journal(
        digest TEXT PRIMARY KEY REFERENCES exact_revisions(digest) ON DELETE CASCADE,
        byte_length INTEGER NOT NULL,
        owner_pid INTEGER NOT NULL,
        owner_token TEXT NOT NULL,
        temp_path TEXT NOT NULL,
        claimed_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS admission_leases(
        lease_id TEXT PRIMARY KEY,
        digest TEXT NOT NULL REFERENCES exact_revisions(digest) ON DELETE CASCADE,
        byte_length INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS admission_leases_digest ON admission_leases(digest);
      CREATE TABLE IF NOT EXISTS retention_anchors(
        anchor_id TEXT PRIMARY KEY,
        namespace TEXT NOT NULL,
        record_key TEXT NOT NULL,
        digest TEXT NOT NULL REFERENCES exact_revisions(digest) ON DELETE RESTRICT,
        byte_length INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS retention_anchors_namespace ON retention_anchors(namespace);
      CREATE INDEX IF NOT EXISTS retention_anchors_digest ON retention_anchors(digest);
      CREATE UNIQUE INDEX IF NOT EXISTS retention_anchors_coordinate
        ON retention_anchors(namespace, record_key);
      CREATE TABLE IF NOT EXISTS retired_anchor_ids(
        anchor_id TEXT PRIMARY KEY,
        released_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS deletion_journal(
        digest TEXT PRIMARY KEY REFERENCES exact_revisions(digest) ON DELETE CASCADE,
        byte_length INTEGER NOT NULL,
        marked_at INTEGER NOT NULL
      );
      `);
      this.database.prepare(`
        INSERT OR IGNORE INTO content_meta(key, value) VALUES ('schema_version', ?)
      `).run(String(CONTENT_SCHEMA_VERSION));
    });
  }

  private async claimPublication(
    reference: PhysicalRevisionReference,
    stage: AdmissionStage,
    token: string,
  ): Promise<'owned' | 'published' | 'waiting'> {
    return this.immediateTransaction(() => {
      const current = this.revision(reference.digest);
      if (current) {
        if (current.byte_length !== reference.byteLength) {
          throw new ContentIntegrityError('Exact revision digest length collision.');
        }
        if (current.state === 'published') return 'published';
        if (current.state === 'quarantined') throw unavailableReference(reference, current.state);
        if (current.state === 'deleting') throw unavailableReference(reference, current.state);
        return 'waiting';
      }
      const now = this.now().getTime();
      this.database.prepare(`
        INSERT INTO exact_revisions(digest, byte_length, state, owner_pid, owner_token, updated_at)
        VALUES (?, ?, 'publishing', ?, ?, ?)
      `).run(reference.digest, reference.byteLength, process.pid, token, now);
      this.database.prepare(`
        INSERT INTO publication_journal(digest, byte_length, owner_pid, owner_token, temp_path, claimed_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(reference.digest, reference.byteLength, process.pid, token, stage.tempPath, now);
      const transferred = this.database.prepare(`
        DELETE FROM admission_staging WHERE stage_id = ? AND owner_token = ?
      `).run(stage.stageId, stage.ownerToken).changes;
      if (transferred !== 1) {
        throw new ContentStateError('Content admission staging ownership changed.', 'unavailable');
      }
      return 'owned';
    });
  }

  private async publishOwned(
    reference: PhysicalRevisionReference,
    tempPath: string,
    token: string,
    leaseId: string,
    expiresAt: Date,
  ): Promise<void> {
    const finalPath = this.revisionPath(reference.digest);
    await ensurePrivateDirectory(path.dirname(finalPath));
    const existing = await stat(finalPath).catch(() => null);
    if (existing) {
      const actual = await fileDigest(finalPath).catch(() => null);
      if (!actual || actual.digest !== reference.digest || actual.byteLength !== reference.byteLength) {
        await this.quarantine(reference);
        throw new ContentIntegrityError('Published exact revision collides with invalid bytes.');
      }
      await rm(tempPath, { force: true });
    } else {
      await rename(tempPath, finalPath);
      await syncDirectory(path.dirname(finalPath));
    }
    await this.options.hooks?.afterPublicationRename?.();
    await this.immediateTransaction(() => {
      const row = this.database.prepare(`
        SELECT * FROM exact_revisions WHERE digest = ? AND state = 'publishing' AND owner_token = ?
      `).get<RevisionRow>(reference.digest, token);
      if (!row) throw new ContentStateError('Content publication ownership changed.', 'unavailable');
      const now = this.now().getTime();
      this.database.prepare(`
        UPDATE exact_revisions
        SET state = 'published', owner_pid = NULL, owner_token = NULL, updated_at = ?
        WHERE digest = ? AND owner_token = ?
      `).run(now, reference.digest, token);
      this.database.prepare('DELETE FROM publication_journal WHERE digest = ?').run(reference.digest);
      this.insertAdmissionLeaseInside(leaseId, reference, expiresAt, now);
    });
  }

  private async insertAdmissionLease(
    leaseId: string,
    reference: PhysicalRevisionReference,
    expiresAt: Date,
  ): Promise<void> {
    await this.immediateTransaction(() => {
      const row = this.revision(reference.digest);
      if (!row || row.state !== 'published' || row.byte_length !== reference.byteLength) {
        throw unavailableReference(reference, row?.state);
      }
      this.insertAdmissionLeaseInside(leaseId, reference, expiresAt, this.now().getTime());
    });
  }

  private insertAdmissionLeaseInside(
    leaseId: string,
    reference: PhysicalRevisionReference,
    expiresAt: Date,
    createdAt: number,
  ): void {
    this.database.prepare(`
      INSERT INTO admission_leases(lease_id, digest, byte_length, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(leaseId, reference.digest, reference.byteLength, expiresAt.getTime(), createdAt);
  }

  private async quarantine(reference: PhysicalRevisionReference): Promise<void> {
    await this.immediateTransaction(() => {
      this.database.prepare(`
        UPDATE exact_revisions
        SET state = 'quarantined', owner_pid = NULL, owner_token = NULL, updated_at = ?
        WHERE digest = ?
      `).run(this.now().getTime(), reference.digest);
      this.database.prepare('DELETE FROM publication_journal WHERE digest = ?').run(reference.digest);
    });
    const source = this.revisionPath(reference.digest);
    const destination = path.join(this.quarantineRoot, `${reference.digest}-${crypto.randomUUID()}.blob`);
    await rename(source, destination).catch((error: unknown) => {
      if (!isNotFound(error)) throw error;
    });
    await syncDirectory(this.quarantineRoot).catch(() => undefined);
  }

  private async repairInterruptedState(): Promise<void> {
    await this.repairAdmissionStages();

    const publications = await this.readTransaction(() => this.database.prepare(`
      SELECT r.digest, r.byte_length, r.state, r.owner_pid, r.owner_token, r.updated_at, p.temp_path
      FROM exact_revisions r JOIN publication_journal p ON p.digest = r.digest
      WHERE r.state = 'publishing'
    `).all<PublicationRow>());
    for (const row of publications) await this.repairPublication(row);

    const deletions = await this.readTransaction(() => this.database.prepare(`
      SELECT digest, byte_length FROM deletion_journal ORDER BY digest
    `).all<DeletionRow>());
    for (const row of deletions) {
      await this.finishDeletion({ digest: row.digest, byteLength: row.byte_length });
    }
  }

  private async repairAdmissionStages(): Promise<void> {
    const admissionStages = await this.readTransaction(() => this.database.prepare(`
      SELECT stage_id, owner_pid, owner_token, created_at, updated_at
      FROM admission_staging ORDER BY stage_id
    `).all<AdmissionStageRow>());
    for (const row of admissionStages) await this.repairAdmissionStage(row);
  }

  private async beginAdmissionStage(): Promise<AdmissionStage> {
    const stageId = crypto.randomUUID();
    const ownerToken = crypto.randomUUID();
    const now = this.now().getTime();
    await this.immediateTransaction(() => {
      this.database.prepare(`
        INSERT INTO admission_staging(stage_id, owner_pid, owner_token, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(stageId, process.pid, ownerToken, now, now);
    });
    return {
      stageId,
      ownerToken,
      tempPath: this.admissionStagePath(stageId),
    };
  }

  private async touchAdmissionStage(stage: AdmissionStage): Promise<void> {
    await this.immediateTransaction(() => {
      const changed = this.database.prepare(`
        UPDATE admission_staging SET updated_at = ?
        WHERE stage_id = ? AND owner_pid = ? AND owner_token = ?
      `).run(this.now().getTime(), stage.stageId, process.pid, stage.ownerToken).changes;
      if (changed !== 1) {
        throw new ContentStateError('Content admission staging ownership changed.', 'unavailable');
      }
    });
  }

  private async cleanupAdmissionStage(stage: AdmissionStage): Promise<void> {
    await rm(stage.tempPath, { force: true });
    await this.forgetAdmissionStage(stage);
  }

  private async forgetAdmissionStage(stage: AdmissionStage): Promise<void> {
    await this.immediateTransaction(() => {
      this.database.prepare(`
        DELETE FROM admission_staging WHERE stage_id = ? AND owner_token = ?
      `).run(stage.stageId, stage.ownerToken);
    });
  }

  private async repairAdmissionStage(row: AdmissionStageRow): Promise<void> {
    const stage: AdmissionStage = {
      stageId: row.stage_id,
      ownerToken: row.owner_token,
      tempPath: this.admissionStagePath(row.stage_id),
    };
    if (processIsAlive(row.owner_pid)) return;
    await rm(stage.tempPath, { force: true });
    await this.immediateTransaction(() => {
      this.database.prepare(`
        DELETE FROM admission_staging WHERE stage_id = ? AND owner_pid = ? AND owner_token = ?
      `).run(stage.stageId, row.owner_pid, stage.ownerToken);
    });
  }

  private async repairStalePublication(digest: string): Promise<void> {
    const row = await this.readTransaction(() => this.database.prepare(`
      SELECT r.digest, r.byte_length, r.state, r.owner_pid, r.owner_token, r.updated_at, p.temp_path
      FROM exact_revisions r JOIN publication_journal p ON p.digest = r.digest
      WHERE r.digest = ? AND r.state = 'publishing'
    `).get<PublicationRow>(digest));
    if (row) await this.repairPublication(row);
  }

  private async repairPublication(row: PublicationRow): Promise<void> {
    this.assertPublicationTempPath(row.temp_path);
    const ownerAlive = row.owner_pid !== null && processIsAlive(row.owner_pid);
    if (ownerAlive && this.now().getTime() - row.updated_at < this.publicationStaleMs) return;
    const adopted = await this.adoptPublicationRepair(row);
    if (!adopted) return;
    const reference = { digest: row.digest, byteLength: row.byte_length };
    const finalPath = this.revisionPath(row.digest);
    const final = await fileDigest(finalPath).catch(() => null);
    if (final?.digest === row.digest && final.byteLength === row.byte_length) {
      await this.settleRepairedPublication(adopted);
      await rm(row.temp_path, { force: true }).catch(() => undefined);
      return;
    }
    const staged = await fileDigest(row.temp_path).catch(() => null);
    if (staged?.digest === row.digest && staged.byteLength === row.byte_length) {
      await ensurePrivateDirectory(path.dirname(finalPath));
      await rename(row.temp_path, finalPath);
      await syncDirectory(path.dirname(finalPath));
      await this.settleRepairedPublication(adopted);
      return;
    }
    await this.immediateTransaction(() => {
      this.database.prepare(`
        DELETE FROM exact_revisions
        WHERE digest = ? AND state = 'publishing' AND owner_token = ?
      `).run(adopted.digest, adopted.owner_token);
    });
    await rm(row.temp_path, { force: true }).catch(() => undefined);
  }

  private async adoptPublicationRepair(row: PublicationRow): Promise<PublicationRow | undefined> {
    const ownerToken = crypto.randomUUID();
    const updatedAt = this.now().getTime();
    return this.immediateTransaction(() => {
      const changed = this.database.prepare(`
        UPDATE exact_revisions
        SET owner_pid = ?, owner_token = ?, updated_at = ?
        WHERE digest = ? AND state = 'publishing' AND owner_token = ?
      `).run(process.pid, ownerToken, updatedAt, row.digest, row.owner_token).changes;
      if (changed === 0) return undefined;
      this.database.prepare(`
        UPDATE publication_journal
        SET owner_pid = ?, owner_token = ?, claimed_at = ?
        WHERE digest = ?
      `).run(process.pid, ownerToken, updatedAt, row.digest);
      return { ...row, owner_pid: process.pid, owner_token: ownerToken, updated_at: updatedAt };
    });
  }

  private async settleRepairedPublication(row: PublicationRow): Promise<void> {
    await this.immediateTransaction(() => {
      this.database.prepare(`
        UPDATE exact_revisions
        SET state = 'published', owner_pid = NULL, owner_token = NULL, updated_at = ?
        WHERE digest = ? AND state = 'publishing' AND owner_token = ?
      `).run(this.now().getTime(), row.digest, row.owner_token);
      this.database.prepare('DELETE FROM publication_journal WHERE digest = ?').run(row.digest);
    });
  }

  private async finishDeletion(reference: PhysicalRevisionReference): Promise<void> {
    const finalPath = this.revisionPath(reference.digest);
    await rm(finalPath, { force: true });
    await syncDirectory(path.dirname(finalPath)).catch(() => undefined);
    await this.immediateTransaction(() => {
      const row = this.revision(reference.digest);
      if (row?.state === 'deleting') {
        this.database.prepare('DELETE FROM exact_revisions WHERE digest = ?').run(reference.digest);
      } else {
        this.database.prepare('DELETE FROM deletion_journal WHERE digest = ?').run(reference.digest);
      }
    });
  }

  private revision(digest: string): RevisionRow | undefined {
    return this.database.prepare('SELECT * FROM exact_revisions WHERE digest = ?').get<RevisionRow>(digest);
  }

  private assertAnchorIdAvailable(anchorId: string): void {
    const active = this.database.prepare('SELECT 1 FROM retention_anchors WHERE anchor_id = ?').get(anchorId);
    const retired = this.database.prepare('SELECT 1 FROM retired_anchor_ids WHERE anchor_id = ?').get(anchorId);
    if (active || retired) {
      throw new ContentStateError('Content anchor identity is unavailable.', 'unavailable');
    }
  }

  private revisionPath(digest: string): string {
    assertDigest(digest);
    return path.join(this.revisionsRoot, digest.slice(0, 2), `${digest}.blob`);
  }

  private admissionStagePath(stageId: string): string {
    assertUuid(stageId, 'admission stage');
    return path.join(this.stagingRoot, `admit-${stageId}.tmp`);
  }

  private assertPublicationTempPath(tempPath: string): void {
    const resolved = path.resolve(tempPath);
    if (resolved !== tempPath
      || path.dirname(resolved) !== this.stagingRoot
      || !/^admit-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/u
        .test(path.basename(resolved))) {
      throw new Error('ContentStore publication journal contains an invalid staging path.');
    }
  }

  private async immediateTransaction<T>(action: () => T): Promise<T> {
    return this.transaction('BEGIN IMMEDIATE', action);
  }

  private async readTransaction<T>(action: () => T): Promise<T> {
    return this.transaction('BEGIN', action);
  }

  private async transaction<T>(begin: 'BEGIN' | 'BEGIN IMMEDIATE', action: () => T): Promise<T> {
    this.assertOpen();
    return retryContentSqliteBusy(() => {
      let begun = false;
      try {
        this.database.exec(begin);
        begun = true;
        const result = action();
        this.database.exec('COMMIT');
        return result;
      } catch (error) {
        if (begun) {
          try {
            this.database.exec('ROLLBACK');
          } catch {
            // The original transaction error is authoritative.
          }
        }
        throw error;
      }
    });
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('ContentStore is closed.');
  }
}

function unavailableReference(_reference: PhysicalRevisionReference, state?: RevisionState): ContentStateError {
  if (state === 'quarantined') {
    return new ContentStateError('Exact revision is quarantined.', 'quarantined');
  }
  return new ContentStateError('Exact revision is unavailable.', 'not_found');
}

function assertPhysicalRevisionReference(reference: PhysicalRevisionReference): void {
  assertDigest(reference.digest);
  if (!Number.isSafeInteger(reference.byteLength) || reference.byteLength < 0) {
    throw new Error('Exact revision byte length is invalid.');
  }
}

function assertExactRevisionReference(reference: ExactRevisionReference): void {
  assertOpaqueId(reference.anchorId, 'anchor');
  if (!Number.isSafeInteger(reference.byteLength) || reference.byteLength < 0) {
    throw new Error('Exact revision byte length is invalid.');
  }
}

function assertDigest(digest: string): void {
  if (!/^[a-f0-9]{64}$/u.test(digest)) throw new Error('Invalid exact revision digest.');
}

function assertUuid(value: string, kind: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)) {
    throw new Error(`Invalid ContentStore ${kind} id.`);
  }
}

function assertOpaqueId(value: string, kind: string): void {
  if (!value.trim() || value.length > 512) throw new Error(`Invalid ContentStore ${kind} id.`);
}

async function fileDigest(filePath: string): Promise<{ digest: string; byteLength: number }> {
  const file = await lstat(filePath);
  if (!file.isFile() || file.isSymbolicLink()) {
    throw new Error('ContentStore revision is not a regular file.');
  }
  const hash = createHash('sha256');
  let byteLength = 0;
  for await (const chunk of createReadStream(filePath)) {
    const bytes = Buffer.from(chunk);
    hash.update(bytes);
    byteLength += bytes.byteLength;
  }
  return { digest: hash.digest('hex'), byteLength };
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const value = await lstat(directory);
  if (!value.isDirectory() || value.isSymbolicLink()) {
    throw new Error(`ContentStore path is not a private directory: ${directory}`);
  }
  await chmod(directory, 0o700);
}

async function syncDirectory(directory: string): Promise<void> {
  const handle: FileHandle = await open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isRecord(error) && error.code === 'EPERM';
  }
}

function isNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
