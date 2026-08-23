import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import path from 'node:path';
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

const ASSET_DIRECTORY = 'assets';
const BLOB_DIRECTORY = 'blobs';
const QUARANTINE_DIRECTORY = 'quarantine';
const METADATA_HEAD_BYTES = 8 * 1024 * 1024;
const DEFAULT_LEASE_MS = 24 * 60 * 60 * 1_000;
const MAX_ASSET_BYTES = 2 * 1024 * 1024 * 1024;

export interface OutlineVerifiedAsset {
  readonly record: AssetRecord;
  readonly path: string;
}

export interface OutlineAssetStoreOptions {
  readonly now?: () => Date;
  readonly leaseMs?: number;
  readonly renderPdfThumbnail?: (pdfPath: string) => Promise<Uint8Array | undefined>;
}

export class OutlineAssetStore {
  readonly root: string;
  readonly blobDirectory: string;
  readonly quarantineDirectory: string;
  private readonly now: () => Date;
  private readonly leaseMs: number;
  private readonly renderPdfThumbnail: (pdfPath: string) => Promise<Uint8Array | undefined>;

  constructor(
    workspaceRoot: string,
    private readonly transactions: WorkspaceTransactionLog,
    options: OutlineAssetStoreOptions = {},
  ) {
    this.root = path.join(workspaceRoot, ASSET_DIRECTORY);
    this.blobDirectory = path.join(this.root, BLOB_DIRECTORY);
    this.quarantineDirectory = path.join(this.root, QUARANTINE_DIRECTORY);
    this.now = options.now ?? (() => new Date());
    this.leaseMs = Math.max(1, options.leaseMs ?? DEFAULT_LEASE_MS);
    this.renderPdfThumbnail = options.renderPdfThumbnail ?? renderPdfThumbnail;
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
    const record = await this.transactions.assetRecord(assetId);
    if (!record) {
      throw new OutlineContractError(outlineError('not_found', 'selection', `AssetRecord not found: ${assetId}`));
    }
    const blobPath = this.blobPath(record.metadata.sha256);
    const actual = await fileDigest(blobPath).catch(async (error: unknown) => {
      await this.quarantine(record.metadata.sha256).catch(() => undefined);
      throw assetIntegrityError(assetId, error instanceof Error ? error.message : String(error));
    });
    if (actual.byteSize !== record.metadata.byteSize || actual.sha256 !== record.metadata.sha256) {
      await this.quarantine(record.metadata.sha256).catch(() => undefined);
      throw assetIntegrityError(assetId, 'stored bytes do not match the AssetRecord digest');
    }
    return { record, path: blobPath };
  }

  async readVerified(assetId: string): Promise<{ record: AssetRecord; bytes: Uint8Array }> {
    const verified = await this.verify(assetId);
    return { record: verified.record, bytes: await readFile(verified.path) };
  }

  async resolveLeases(leaseIds: readonly string[]): Promise<ReadonlyMap<string, AssetLease>> {
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

  async byteSizeOf(assetIds: readonly string[]): Promise<number> {
    const digests = new Set<string>();
    let bytes = 0;
    for (const assetId of await this.expandAssetIds(assetIds)) {
      const record = await this.transactions.assetRecord(assetId);
      if (record && !digests.has(record.metadata.sha256)) {
        digests.add(record.metadata.sha256);
        bytes += record.metadata.byteSize;
      }
    }
    return bytes;
  }

  async collectGarbage(liveAssetRecordIds: readonly string[]): Promise<readonly string[]> {
    const removed = await this.transactions.collectUnprotectedAssetRecords(liveAssetRecordIds, this.now());
    const referencedDigests = new Set((await this.transactions.assetRecords()).map((record) => record.metadata.sha256));
    const entries = await readdir(this.blobDirectory).catch((error: unknown) => {
      if (isNotFound(error)) return [] as string[];
      throw error;
    });
    const deleted: string[] = [];
    for (const entry of entries.sort()) {
      const match = /^([a-f0-9]{64})\.blob$/.exec(entry);
      if (!match || referencedDigests.has(match[1]!)) continue;
      try {
        await rm(path.join(this.blobDirectory, entry), { force: true });
        deleted.push(match[1]!);
      } catch {
        // GC is retryable maintenance and never changes a committed Operation result.
      }
    }
    return removed.map((record) => record.assetId).concat(deleted.map((digest) => `blob:${digest}`));
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
    await mkdir(this.blobDirectory, { recursive: true, mode: 0o700 });
    const temporaryPath = path.join(this.blobDirectory, `.stage-${crypto.randomUUID()}.tmp`);
    const handle = await open(temporaryPath, 'wx', 0o600);
    const hash = createHash('sha256');
    const head: Buffer[] = [];
    let headBytes = 0;
    let byteSize = 0;
    try {
      for await (const value of source) {
        const chunk = Buffer.from(value);
        byteSize += chunk.byteLength;
        if (byteSize > MAX_ASSET_BYTES) {
          throw new OutlineContractError(outlineError('invalid_input', 'usage', 'Asset exceeds the 2 GiB limit.'));
        }
        hash.update(chunk);
        await handle.write(chunk);
        if (headBytes < METADATA_HEAD_BYTES) {
          const retained = chunk.subarray(0, Math.min(chunk.length, METADATA_HEAD_BYTES - headBytes));
          head.push(retained);
          headBytes += retained.length;
        }
      }
      await handle.sync();
      await handle.close();
      const sha256 = hash.digest('hex');
      const finalPath = this.blobPath(sha256);
      if (await exists(finalPath)) {
        const existing = await fileDigest(finalPath);
        if (existing.sha256 !== sha256 || existing.byteSize !== byteSize) {
          throw new Error(`Content-addressed asset collision: ${sha256}`);
        }
        await rm(temporaryPath, { force: true });
      } else {
        await rename(temporaryPath, finalPath);
        await syncDirectory(this.blobDirectory);
      }
      const metadataBytes = Buffer.concat(head);
      const mimeType = sniffAssetMimeType(metadataBytes, originalFilename)
        ?? hintedMimeType
        ?? 'application/octet-stream';
      const dimensions = assetImageDimensions(metadataBytes, mimeType);
      const durationMs = assetMediaDurationMs(metadataBytes, mimeType);
      const mediaKind = mediaKindForMimeType(mimeType);
      const thumbnailLease = mimeType === 'application/pdf'
        ? await this.ingestPdfThumbnail(finalPath, originalFilename)
        : undefined;
      const metadata: AssetMetadata = {
        mimeType,
        byteSize,
        sha256,
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
      await this.transactions.stageAsset({ record, lease });
      return lease;
    } catch (error) {
      await handle.close().catch(() => undefined);
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
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

  private blobPath(sha256: string): string {
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error(`Invalid asset blob digest: ${sha256}`);
    return path.join(this.blobDirectory, `${sha256}.blob`);
  }

  private async quarantine(sha256: string): Promise<void> {
    const source = this.blobPath(sha256);
    if (!await exists(source)) return;
    await mkdir(this.quarantineDirectory, { recursive: true, mode: 0o700 });
    await rename(source, path.join(this.quarantineDirectory, `${sha256}-${crypto.randomUUID()}.blob`));
  }
}

async function renderPdfThumbnail(pdfPath: string): Promise<Uint8Array | undefined> {
  const temporaryDirectory = await mkdtemp(path.join(path.dirname(pdfPath), '.pdf-thumbnail-'));
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

async function fileDigest(filePath: string): Promise<{ sha256: string; byteSize: number }> {
  const hash = createHash('sha256');
  let byteSize = 0;
  for await (const chunk of createReadStream(filePath)) {
    const bytes = Buffer.from(chunk);
    byteSize += bytes.byteLength;
    hash.update(bytes);
  }
  return { sha256: hash.digest('hex'), byteSize };
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function assetIntegrityError(assetId: string, reason: string): OutlineContractError {
  return new OutlineContractError(outlineError(
    'recovery_inconsistent',
    'durability',
    `Asset integrity verification failed: ${assetId}`,
    { details: reason },
  ));
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
}
