import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  ContentStore,
  type ContentAnchorCoordinate,
  type ContentAdmissionLease,
  type ExactRevisionReference,
} from '../../../content';
import {
  assetImageDimensions,
  assetMediaDurationMs,
  assetPdfPageCount,
  sniffAssetMimeType,
} from '../../../core/assetMetadata';
import { mediaKindForMimeType } from '../../../core/mediaKind';
import { OutlineContractError, outlineError } from '../../contract/errors';
import type {
  AssetLease,
  AssetMetadata,
  AssetRecord,
} from '../../contract/schemas';
import { OUTLINE_PROTOCOL_VERSION } from '../../contract/version';
import type { WorkspaceTransactionLog } from './workspaceTransactionLog';
import type { OutlineAssetStage, OutlineStoredAssetRecord } from './assetTypes';

const METADATA_HEAD_BYTES = 8 * 1024 * 1024;
const DEFAULT_LEASE_MS = 24 * 60 * 60 * 1_000;
const OUTLINE_CONTENT_NAMESPACE = 'outline';

export interface OutlineVerifiedAsset {
  readonly record: AssetRecord;
  readonly path: string;
}

export interface OutlineAssetStoreOptions {
  readonly now?: () => Date;
  readonly leaseMs?: number;
  readonly renderPdfThumbnail?: (pdfPath: string) => Promise<Uint8Array | undefined>;
  readonly hooks?: {
    readonly afterAnchorCreated?: (anchorId: string) => void | Promise<void>;
    readonly afterAssetRecordsRemoved?: (records: readonly OutlineStoredAssetRecord[]) => void | Promise<void>;
    readonly afterAnchorsReleased?: (records: readonly OutlineStoredAssetRecord[]) => void | Promise<void>;
  };
}

export class OutlineAssetStore {
  private readonly now: () => Date;
  private readonly leaseMs: number;
  private readonly renderPdfThumbnail: (pdfPath: string) => Promise<Uint8Array | undefined>;
  private readonly hooks: NonNullable<OutlineAssetStoreOptions['hooks']>;
  private namespaceChain: Promise<unknown> = Promise.resolve();

  constructor(
    readonly content: ContentStore,
    private readonly transactions: WorkspaceTransactionLog,
    options: OutlineAssetStoreOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.leaseMs = Math.max(1, options.leaseMs ?? DEFAULT_LEASE_MS);
    this.renderPdfThumbnail = options.renderPdfThumbnail ?? renderPdfThumbnail;
    this.hooks = options.hooks ?? {};
  }

  ingestPath(sourcePath: string): Promise<AssetLease> {
    return this.ingestPathInside(sourcePath);
  }

  ingestBytes(bytes: Uint8Array, originalFilename?: string, hintedMimeType?: string): Promise<AssetLease> {
    return this.ingest([bytes], originalFilename, hintedMimeType);
  }

  ingestStream(
    source: AsyncIterable<Uint8Array>,
    originalFilename?: string,
    hintedMimeType?: string,
  ): Promise<AssetLease> {
    return this.ingest(source, originalFilename, hintedMimeType);
  }

  async show(assetId: string): Promise<AssetRecord> {
    const verified = await this.verify(assetId);
    return verified.record;
  }

  async verify(assetId: string): Promise<OutlineVerifiedAsset> {
    const stored = await this.transactions.storedAssetRecord(assetId);
    if (!stored) {
      throw new OutlineContractError(outlineError('not_found', 'selection', `AssetRecord not found: ${assetId}`));
    }
    try {
      return {
        record: stored.record,
        path: await this.content.verifiedPath(
          stored.exactRevision,
          OUTLINE_CONTENT_NAMESPACE,
          stored.record.assetId,
        ),
      };
    } catch {
      throw assetIntegrityError(assetId);
    }
  }

  async readVerified(assetId: string): Promise<{ record: AssetRecord; bytes: Uint8Array }> {
    const verified = await this.verify(assetId);
    return { record: verified.record, bytes: await readFile(verified.path) };
  }

  async resolveLeases(leaseIds: readonly string[]): Promise<ReadonlyMap<string, AssetLease>> {
    if (leaseIds.length === 0) return new Map();
    return this.transactions.resolveAssetLeases(leaseIds, this.now());
  }

  async expandAssetIds(assetIds: readonly string[]): Promise<readonly string[]> {
    const result = new Set(assetIds);
    const queue = [...result];
    while (queue.length > 0) {
      const record = await this.transactions.assetRecord(queue.shift()!);
      const thumbnailId = record?.metadata.thumbnailAssetId;
      if (thumbnailId && !result.has(thumbnailId)) {
        result.add(thumbnailId);
        queue.push(thumbnailId);
      }
    }
    return [...result].sort();
  }

  measureExactRevisionBytes(
    coordinates: readonly ContentAnchorCoordinate[],
    excluding: readonly ContentAnchorCoordinate[] = [],
  ): Promise<number> {
    return this.content.byteLengthOfDistinctRevisions(coordinates, excluding);
  }

  collectGarbage(liveAssetRecordIds: readonly string[]): Promise<readonly string[]> {
    return this.withNamespaceBarrier(async () => {
      const removed = await this.transactions.collectUnprotectedAssetRecords(liveAssetRecordIds, this.now());
      await this.hooks.afterAssetRecordsRemoved?.(removed);
      for (const stored of removed) {
        await this.content.releaseAnchor(stored.exactRevision.anchorId).catch(() => undefined);
      }
      await this.hooks.afterAnchorsReleased?.(removed);
      await this.content.collectGarbage();
      return removed.map((stored) => stored.record.assetId);
    });
  }

  reconcileAnchors(): Promise<readonly string[]> {
    return this.withNamespaceBarrier(async () => {
      const storedRecords = await this.transactions.verifiedStoredAssetRecords();
      const expected = new Map(storedRecords.map((stored) => [stored.exactRevision.anchorId, stored]));
      const anchors = await this.content.anchors(OUTLINE_CONTENT_NAMESPACE);
      const actual = new Map(anchors.map((anchor) => [anchor.anchorId, anchor]));
      for (const [anchorId, stored] of expected) {
        const anchor = actual.get(anchorId);
        if (!anchor
          || anchor.recordKey !== stored.record.assetId
          || anchor.byteLength !== stored.exactRevision.byteLength) {
          throw assetIntegrityError(stored.record.assetId);
        }
      }
      const released: string[] = [];
      for (const anchor of anchors) {
        if (expected.has(anchor.anchorId)) continue;
        if (await this.content.releaseAnchor(anchor.anchorId)) released.push(anchor.anchorId);
      }
      return released;
    });
  }

  close(): void {
    this.content.close();
  }

  private async ingestPathInside(sourcePath: string): Promise<AssetLease> {
    const resolved = await realpath(sourcePath);
    const source = await stat(resolved);
    if (!source.isFile()) {
      throw new OutlineContractError(outlineError('invalid_input', 'usage', 'Only regular files can be ingested.'));
    }
    return this.ingest(createReadStream(resolved), path.basename(resolved));
  }

  private async ingest(
    source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
    originalFilename?: string,
    hintedMimeType?: string,
  ): Promise<AssetLease> {
    const head: Buffer[] = [];
    let headBytes = 0;
    const admission = await this.content.admit((async function* () {
      for await (const value of source) {
        const chunk = Buffer.from(value);
        if (headBytes < METADATA_HEAD_BYTES) {
          const retained = chunk.subarray(0, Math.min(chunk.length, METADATA_HEAD_BYTES - headBytes));
          head.push(retained);
          headBytes += retained.byteLength;
        }
        yield chunk;
      }
    })()).catch((error: unknown) => {
      throw new OutlineContractError(outlineError(
        'invalid_input',
        'usage',
        contentAdmissionErrorMessage(error),
      ));
    });

    try {
      const metadataBytes = Buffer.concat(head);
      const mimeType = sniffAssetMimeType(metadataBytes, originalFilename)
        ?? hintedMimeType
        ?? 'application/octet-stream';
      const dimensions = assetImageDimensions(metadataBytes, mimeType);
      const durationMs = assetMediaDurationMs(metadataBytes, mimeType);
      const mediaKind = mediaKindForMimeType(mimeType);
      const admittedPath = await this.content.verifiedAdmissionPath(admission.leaseId).catch(() => {
        throw new OutlineContractError(outlineError(
          'recovery_inconsistent',
          'durability',
          'Staged asset integrity verification failed.',
        ));
      });
      const thumbnailLease = mimeType === 'application/pdf'
        ? await this.ingestPdfThumbnail(admittedPath, originalFilename)
        : undefined;
      const metadata: AssetMetadata = {
        mimeType,
        byteSize: admission.byteLength,
        ...(originalFilename ? { originalFilename } : {}),
        ...(dimensions ? { imageWidth: dimensions.width, imageHeight: dimensions.height } : {}),
        ...(mimeType === 'application/pdf' && assetPdfPageCount(metadataBytes) !== undefined
          ? { pdfPageCount: assetPdfPageCount(metadataBytes) }
          : {}),
        ...(thumbnailLease ? { thumbnailAssetId: thumbnailLease.assetId } : {}),
        ...(durationMs !== undefined && mediaKind === 'audio' ? { audioDurationMs: durationMs } : {}),
        ...(durationMs !== undefined && mediaKind === 'video' ? { videoDurationMs: durationMs } : {}),
      };
      const createdAt = this.now();
      const assetId = `asset:${crypto.randomUUID()}`;
      const record: AssetRecord = {
        protocolVersion: OUTLINE_PROTOCOL_VERSION,
        kind: 'outline.asset',
        assetId,
        metadata,
        createdAt: createdAt.toISOString(),
      };
      const lease: AssetLease = {
        protocolVersion: OUTLINE_PROTOCOL_VERSION,
        leaseId: `lease:${crypto.randomUUID()}`,
        assetId,
        metadata,
        expiresAt: new Date(createdAt.getTime() + this.leaseMs).toISOString(),
      };
      await this.settleAssetStage(record, lease, admission);
      return lease;
    } catch (error) {
      await this.content.releaseAdmissionLease(admission.leaseId).catch(() => undefined);
      throw error;
    }
  }

  private settleAssetStage(
    record: AssetRecord,
    lease: AssetLease,
    admission: ContentAdmissionLease,
  ): Promise<void> {
    return this.withNamespaceBarrier(async () => {
      const anchor = await this.content.createAnchor(
        admission.leaseId,
        OUTLINE_CONTENT_NAMESPACE,
        record.assetId,
      );
      await this.hooks.afterAnchorCreated?.(anchor.anchorId);
      const stage: OutlineAssetStage = {
        record,
        lease,
        exactRevision: { anchorId: anchor.anchorId, byteLength: anchor.byteLength },
      };
      try {
        await this.transactions.stageAsset(stage);
      } catch (error) {
        const settlement = await this.confirmStageSettlement(stage).catch(() => 'unknown' as const);
        if (settlement === 'missing') await this.content.releaseAnchor(anchor.anchorId).catch(() => undefined);
        if (settlement !== 'committed') throw error;
      }
    });
  }

  private async confirmStageSettlement(
    stage: OutlineAssetStage,
  ): Promise<'committed' | 'missing' | 'unknown'> {
    const stored = await this.transactions.storedAssetRecord(stage.record.assetId);
    if (!stored) return 'missing';
    return exactRevisionEquals(stored.exactRevision, stage.exactRevision)
      ? 'committed'
      : 'unknown';
  }

  private async ingestPdfThumbnail(
    pdfPath: string,
    originalFilename: string | undefined,
  ): Promise<AssetLease | undefined> {
    const bytes = await this.renderPdfThumbnail(pdfPath).catch(() => undefined);
    if (!bytes || bytes.byteLength === 0) return undefined;
    return this.ingest(
      [bytes],
      `${originalFilename ?? 'attachment.pdf'} thumbnail.png`,
      'image/png',
    );
  }

  private withNamespaceBarrier<TResult>(task: () => Promise<TResult>): Promise<TResult> {
    const next = this.namespaceChain.then(task, task);
    this.namespaceChain = next.then(() => undefined, () => undefined);
    return next;
  }
}

async function renderPdfThumbnail(pdfPath: string): Promise<Uint8Array | undefined> {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'tenon-outline-pdf-thumbnail-'));
  try {
    const outputPrefix = path.join(temporaryDirectory, 'page');
    const rendered = await runProcess('pdftoppm', [
      '-f', '1',
      '-l', '1',
      '-singlefile',
      '-png',
      '-scale-to', '512',
      pdfPath,
      outputPrefix,
    ], 5_000);
    if (!rendered) return undefined;
    const bytes = await readFile(`${outputPrefix}.png`).catch(() => undefined);
    return bytes && bytes.byteLength > 0 ? bytes : undefined;
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}

function runProcess(command: string, args: readonly string[], timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, [...args], { stdio: 'ignore' });
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(ok);
    };
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      finish(false);
    }, timeoutMs);
    timeout.unref?.();
    child.once('error', () => finish(false));
    child.once('exit', (code) => finish(code === 0));
  });
}

function exactRevisionEquals(left: ExactRevisionReference, right: ExactRevisionReference): boolean {
  return left.anchorId === right.anchorId && left.byteLength === right.byteLength;
}

function assetIntegrityError(assetId: string): OutlineContractError {
  return new OutlineContractError(outlineError(
    'recovery_inconsistent',
    'durability',
    `Asset integrity verification failed: ${assetId}`,
  ));
}

function contentAdmissionErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.startsWith('Content exceeds the ')) return error.message;
  return 'Asset content admission failed.';
}
