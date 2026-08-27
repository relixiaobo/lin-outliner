import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Value } from 'typebox/value';
import type { AssetIngestInput, AssetMetadata as DesktopAssetMetadata } from '../core/types';
import type { OutlineClient } from '../outline/client';
import type { OutlineClientSupervisor } from '../outline/client';
import { OutlineContractError } from '../outline/contract/errors';
import {
  AssetLeaseSchema,
  AssetRecordSchema,
  type AssetLease,
  type AssetMetadata,
  type AssetRecord,
} from '../outline/contract/schemas';

export class OutlineDesktopAssetService {
  constructor(
    private readonly supervisor: Pick<OutlineClientSupervisor, 'connect'>,
    private readonly exportRoot: string,
  ) {}

  async ingest(input: AssetIngestInput): Promise<DesktopAssetMetadata> {
    const client = await this.supervisor.connect();
    try {
      const lease = input.kind === 'path'
        ? await ingestPath(client, input.path)
        : await client.ingestAsset([input.data], {
            ...(input.mimeType ? { mimeType: input.mimeType } : {}),
            ...(input.originalFilename ? { originalFilename: input.originalFilename } : {}),
          });
      return desktopMetadata(lease.leaseId, lease.metadata, Date.now());
    } finally {
      client.close();
    }
  }

  async lookup(assetId: string): Promise<DesktopAssetMetadata | null> {
    const record = await this.record(assetId);
    return record
      ? desktopMetadata(record.assetId, record.metadata, Date.parse(record.createdAt))
      : null;
  }

  async pathFor(assetId: string): Promise<string | null> {
    const record = await this.record(assetId);
    if (!record) return null;
    const directory = path.join(this.exportRoot, safePathSegment(record.assetId));
    const filename = exportFilename(record);
    const destination = path.join(directory, filename);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = path.join(directory, `.export-${crypto.randomUUID()}.tmp`);
    const handle = await open(temporary, 'wx', 0o600);
    const client = await this.supervisor.connect();
    try {
      for await (const chunk of client.exportAsset(record.assetId)) await handle.write(chunk);
      await handle.sync();
      await handle.close();
      const exported = await stat(temporary);
      if (!exported.isFile() || exported.size !== record.metadata.byteSize) {
        throw new Error(`Outline Runtime export did not match AssetRecord: ${record.assetId}`);
      }
      await rename(temporary, destination);
      return destination;
    } catch (error) {
      await handle.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    } finally {
      client.close();
    }
  }

  async serve(assetId: string, request?: Pick<Request, 'headers'>): Promise<Response> {
    const client = await this.supervisor.connect();
    try {
      return await client.serveAsset(assetId, request?.headers.get('range') ?? null);
    } catch (error) {
      client.close();
      if (isNotFound(error)) {
        return new Response('Asset not found', {
          status: 404,
          headers: { 'content-type': 'text/plain' },
        });
      }
      throw error;
    }
  }

  private async record(assetId: string): Promise<AssetRecord | null> {
    const client = await this.supervisor.connect();
    try {
      const response = await client.request('asset show', { assetId });
      if (!Value.Check(AssetRecordSchema, response.data)) {
        throw new Error('Outline Runtime returned invalid AssetRecord metadata.');
      }
      return response.data;
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    } finally {
      client.close();
    }
  }
}

async function ingestPath(client: OutlineClient, sourcePath: string): Promise<AssetLease> {
  const response = await client.request('asset ingest', { source: 'path', path: sourcePath });
  if (!Value.Check(AssetLeaseSchema, response.data)) {
    throw new Error('Outline Runtime returned an invalid AssetLease.');
  }
  return response.data;
}

function desktopMetadata(
  id: string,
  metadata: AssetMetadata,
  createdAt: number,
): DesktopAssetMetadata {
  return {
    schemaVersion: 1,
    id,
    mimeType: metadata.mimeType,
    byteSize: metadata.byteSize,
    createdAt,
    originalFilename: metadata.originalFilename,
    imageWidth: metadata.imageWidth,
    imageHeight: metadata.imageHeight,
    thumbnailAssetId: metadata.thumbnailAssetId,
    pdfPageCount: metadata.pdfPageCount,
    audioDurationMs: metadata.audioDurationMs,
    videoDurationMs: metadata.videoDurationMs,
  };
}

function exportFilename(record: AssetRecord): string {
  const original = record.metadata.originalFilename
    ? path.basename(record.metadata.originalFilename).replace(/[\u0000/\\]/gu, '_')
    : '';
  if (original && original !== '.' && original !== '..') return original;
  return `asset${extensionForMimeType(record.metadata.mimeType)}`;
}

function safePathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/gu, '_').slice(0, 255) || 'asset';
}

function extensionForMimeType(mimeType: string): string {
  return ({
    'application/epub+zip': '.epub',
    'application/pdf': '.pdf',
    'audio/mpeg': '.mp3',
    'image/gif': '.gif',
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/svg+xml': '.svg',
    'image/webp': '.webp',
    'text/markdown': '.md',
    'text/plain': '.txt',
    'video/mp4': '.mp4',
    'video/quicktime': '.mov',
    'video/webm': '.webm',
  } as Record<string, string>)[mimeType] ?? '';
}

function isNotFound(error: unknown): boolean {
  return error instanceof OutlineContractError && error.outlineError.code === 'not_found';
}
