import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import {
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  stat,
  type FileHandle,
} from 'node:fs/promises';
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
const CONTAINER_SCAN_CHUNK_BYTES = 64 * 1024;
const JPEG_SCAN_CHUNK_BYTES = 64 * 1024;
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
  private metadataByAssetId = new Map<string, AssetMetadata>();
  private metadataRevisionValue = 0;

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

  metadataSnapshot(): ReadonlyMap<string, AssetMetadata> {
    return new Map([...this.metadataByAssetId].map(([assetId, metadata]) => [
      assetId,
      structuredClone(metadata),
    ]));
  }

  get metadataRevision(): number {
    return this.metadataRevisionValue;
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

  async resolveLeasesForAssetIds(assetIds: readonly string[]): Promise<ReadonlyMap<string, AssetLease>> {
    if (assetIds.length === 0) return new Map();
    return this.transactions.resolveAssetLeasesForAssetIds(assetIds, this.now());
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
      for (const stored of removed) this.metadataByAssetId.delete(stored.record.assetId);
      if (removed.length > 0) this.metadataRevisionValue += 1;
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
      const records = await this.transactions.assetRecords();
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
      this.metadataByAssetId = new Map(records.map((record) => [
        record.assetId,
        structuredClone(record.metadata),
      ]));
      this.metadataRevisionValue += 1;
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
      const admittedPath = await this.content.verifiedAdmissionPath(admission.leaseId).catch(() => {
        throw new OutlineContractError(outlineError(
          'recovery_inconsistent',
          'durability',
          'Staged asset integrity verification failed.',
        ));
      });
      const dimensions = assetImageDimensions(metadataBytes, mimeType)
        ?? await assetFileImageDimensions(admittedPath, admission.byteLength, mimeType);
      const durationMs = assetMediaDurationMs(metadataBytes, mimeType)
        ?? await assetFileMediaDurationMs(admittedPath, admission.byteLength, mimeType);
      const pdfPageCount = mimeType === 'application/pdf'
        ? metadataBytes.byteLength < admission.byteLength
          ? await assetFilePdfPageCount(admittedPath)
          : assetPdfPageCount(metadataBytes)
        : undefined;
      const mediaKind = mediaKindForMimeType(mimeType);
      const thumbnailLease = mimeType === 'application/pdf'
        ? await this.ingestPdfThumbnail(admittedPath, originalFilename)
        : undefined;
      const metadata: AssetMetadata = {
        mimeType,
        byteSize: admission.byteLength,
        ...(originalFilename ? { originalFilename } : {}),
        ...(dimensions ? { imageWidth: dimensions.width, imageHeight: dimensions.height } : {}),
        ...(pdfPageCount !== undefined ? { pdfPageCount } : {}),
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
      this.metadataByAssetId.set(record.assetId, structuredClone(record.metadata));
      this.metadataRevisionValue += 1;
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

async function assetFileMediaDurationMs(
  filePath: string,
  byteLength: number,
  mimeType: string,
): Promise<number | undefined> {
  if (mimeType === 'audio/wav') return wavFileDurationMs(filePath, byteLength);
  if (mimeType !== 'video/mp4' && mimeType !== 'video/quicktime' && mimeType !== 'audio/mp4') {
    return undefined;
  }
  const handle = await open(filePath, 'r');
  try {
    const reader = new FileWindowReader(handle, byteLength);
    const moov = await findMp4Box(reader, 0, byteLength, 'moov');
    if (!moov) return undefined;
    const mvhd = await findMp4Box(reader, moov.payloadOffset, moov.end, 'mvhd');
    if (!mvhd || mvhd.end - mvhd.payloadOffset < 20) return undefined;
    const payload = await reader.read(mvhd.payloadOffset, Math.min(32, mvhd.end - mvhd.payloadOffset));
    if (!payload || payload.byteLength < 20) return undefined;
    if (payload.readUInt8(0) === 1) {
      if (payload.byteLength < 32) return undefined;
      const timescale = payload.readUInt32BE(20);
      const duration = payload.readBigUInt64BE(24);
      return timescale > 0 ? Math.round(Number(duration) * 1_000 / timescale) : undefined;
    }
    const timescale = payload.readUInt32BE(12);
    const duration = payload.readUInt32BE(16);
    return timescale > 0 ? Math.round(duration * 1_000 / timescale) : undefined;
  } finally {
    await handle.close();
  }
}

async function assetFileImageDimensions(
  filePath: string,
  byteLength: number,
  mimeType: string,
): Promise<{ width: number; height: number } | undefined> {
  if (mimeType !== 'image/jpeg') return undefined;
  const handle = await open(filePath, 'r');
  try {
    const scanBuffer = Buffer.alloc(JPEG_SCAN_CHUNK_BYTES);
    let offset = 2;
    while (offset + 9 < byteLength) {
      const markerOffset = await findNextJpegMarker(
        handle,
        offset,
        byteLength,
        scanBuffer,
      );
      if (markerOffset === undefined) return undefined;
      offset = markerOffset;
      const header = await readAt(handle, offset, 10);
      if (!header || header.byteLength < 10) return undefined;
      const marker = header[1]!;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: header.readUInt16BE(5), width: header.readUInt16BE(7) };
      }
      if (marker === 0xda || marker === 0xd9) return undefined;
      if (marker === 0x01 || marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2;
        continue;
      }
      const segmentLength = header.readUInt16BE(2);
      if (segmentLength < 2 || offset + 2 + segmentLength > byteLength) return undefined;
      offset += 2 + segmentLength;
    }
    return undefined;
  } finally {
    await handle.close();
  }
}

async function findNextJpegMarker(
  handle: FileHandle,
  start: number,
  end: number,
  buffer: Buffer,
): Promise<number | undefined> {
  let offset = start;
  let markerOffset: number | undefined;
  while (offset < end) {
    const length = Math.min(buffer.byteLength, end - offset);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    if (bytesRead <= 0) return undefined;
    for (let index = 0; index < bytesRead; index += 1) {
      const byte = buffer[index]!;
      if (byte === 0xff) {
        markerOffset = offset + index;
        continue;
      }
      if (markerOffset === undefined) continue;
      if (byte !== 0x00) return markerOffset;
      markerOffset = undefined;
    }
    offset += bytesRead;
  }
  return undefined;
}

async function wavFileDurationMs(filePath: string, byteLength: number): Promise<number | undefined> {
  if (byteLength < 44) return undefined;
  const handle = await open(filePath, 'r');
  try {
    const reader = new FileWindowReader(handle, byteLength);
    const riff = await reader.read(0, 12);
    if (!riff || riff.toString('ascii', 0, 4) !== 'RIFF' || riff.toString('ascii', 8, 12) !== 'WAVE') {
      return undefined;
    }
    let offset = 12;
    let byteRate: number | undefined;
    let dataSize: number | undefined;
    while (offset + 8 <= byteLength) {
      const header = await reader.read(offset, 8);
      if (!header) return undefined;
      const chunk = header.toString('ascii', 0, 4);
      const size = header.readUInt32LE(4);
      const dataOffset = offset + 8;
      if (chunk === 'fmt ' && size >= 12) {
        const format = await reader.read(dataOffset, 12);
        if (!format) return undefined;
        byteRate = format.readUInt32LE(8);
      }
      if (chunk === 'data') dataSize = size;
      if (byteRate && dataSize !== undefined) return Math.round((dataSize / byteRate) * 1_000);
      const nextOffset = dataOffset + size + (size % 2);
      if (!Number.isSafeInteger(nextOffset) || nextOffset <= offset || nextOffset > byteLength) return undefined;
      offset = nextOffset;
    }
    return undefined;
  } finally {
    await handle.close();
  }
}

async function assetFilePdfPageCount(filePath: string): Promise<number | undefined> {
  let state = 0;
  let pages = 0;
  for await (const chunk of createReadStream(filePath)) {
    for (const byte of chunk) {
      if (state === 10) {
        if (!isWordByte(byte)) pages += 1;
        state = byte === 0x2f ? 1 : 0;
        continue;
      }
      if (state === 0) state = byte === 0x2f ? 1 : 0;
      else if (state === 1) state = byte === 0x54 ? 2 : byte === 0x2f ? 1 : 0;
      else if (state === 2) state = byte === 0x79 ? 3 : byte === 0x2f ? 1 : 0;
      else if (state === 3) state = byte === 0x70 ? 4 : byte === 0x2f ? 1 : 0;
      else if (state === 4) state = byte === 0x65 ? 5 : byte === 0x2f ? 1 : 0;
      else if (state === 5) state = isWhitespaceByte(byte) ? 5 : byte === 0x2f ? 6 : 0;
      else if (state === 6) state = byte === 0x50 ? 7 : byte === 0x2f ? 1 : 0;
      else if (state === 7) state = byte === 0x61 ? 8 : byte === 0x2f ? 1 : 0;
      else if (state === 8) state = byte === 0x67 ? 9 : byte === 0x2f ? 1 : 0;
      else if (state === 9) state = byte === 0x65 ? 10 : byte === 0x2f ? 1 : 0;
    }
  }
  if (state === 10) pages += 1;
  return pages > 0 ? pages : undefined;
}

function isWhitespaceByte(byte: number): boolean {
  return (byte >= 0x09 && byte <= 0x0d) || byte === 0x20 || byte === 0xa0;
}

function isWordByte(byte: number): boolean {
  return (byte >= 0x30 && byte <= 0x39)
    || (byte >= 0x41 && byte <= 0x5a)
    || byte === 0x5f
    || (byte >= 0x61 && byte <= 0x7a);
}

async function readAt(handle: FileHandle, position: number, length: number): Promise<Buffer | undefined> {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  return bytesRead === length ? buffer : undefined;
}

interface Mp4Box {
  readonly payloadOffset: number;
  readonly end: number;
}

class FileWindowReader {
  private readonly buffer = Buffer.alloc(CONTAINER_SCAN_CHUNK_BYTES);
  private windowStart = 0;
  private windowEnd = 0;

  constructor(
    private readonly handle: FileHandle,
    private readonly byteLength: number,
  ) {}

  async read(position: number, length: number): Promise<Buffer | undefined> {
    if (!Number.isSafeInteger(position)
      || !Number.isSafeInteger(length)
      || position < 0
      || length < 0
      || length > this.buffer.byteLength
      || position + length > this.byteLength) {
      return undefined;
    }
    if (position >= this.windowStart && position + length <= this.windowEnd) {
      return this.buffer.subarray(position - this.windowStart, position - this.windowStart + length);
    }

    this.windowStart = position;
    let bytesRead = 0;
    const readLength = Math.min(this.buffer.byteLength, this.byteLength - position);
    while (bytesRead < readLength) {
      const result = await this.handle.read(
        this.buffer,
        bytesRead,
        readLength - bytesRead,
        position + bytesRead,
      );
      if (result.bytesRead <= 0) break;
      bytesRead += result.bytesRead;
    }
    this.windowEnd = position + bytesRead;
    return length <= bytesRead ? this.buffer.subarray(0, length) : undefined;
  }
}

async function findMp4Box(
  reader: FileWindowReader,
  start: number,
  end: number,
  target: string,
): Promise<Mp4Box | undefined> {
  let offset = start;
  while (offset + 8 <= end) {
    const header = await reader.read(offset, Math.min(16, end - offset));
    if (!header || header.byteLength < 8) return undefined;
    const size32 = header.readUInt32BE(0);
    const headerSize = size32 === 1 ? 16 : 8;
    if (header.byteLength < headerSize) return undefined;
    const boxSize = size32 === 0
      ? end - offset
      : size32 === 1
        ? Number(header.readBigUInt64BE(8))
        : size32;
    if (!Number.isSafeInteger(boxSize) || boxSize < headerSize || offset + boxSize > end) return undefined;
    const boxEnd = offset + boxSize;
    if (header.toString('ascii', 4, 8) === target) {
      return { payloadOffset: offset + headerSize, end: boxEnd };
    }
    offset = boxEnd;
  }
  return undefined;
}
