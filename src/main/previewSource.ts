import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import type { AssetService } from './assetService';
import type { AgentRuntime } from './agentRuntime';
import type { AgentPayloadRef } from '../core/agentEventLog';
import { assetUrl } from '../core/assets';
import type { PreviewCommand } from '../core/commands';
import {
  previewTargetFromUnknown,
  previewTargetKey,
  type PreviewDirectoryEntry,
  type PreviewListDirectoryResult,
  type PreviewReadBytesResult,
  type PreviewReadTextResult,
  type PreviewResolveSourceResult,
  type PreviewSourceDescriptor,
  type PreviewTarget,
} from '../core/preview';
import {
  resolveTrustedLocalFileReference,
  type TrustedLocalFileReference,
} from './localFileReferenceSecurity';

export interface LocalFilePreviewMetadata {
  entryKind: 'file' | 'directory';
  iconDataUrl?: string;
  lastModified: number;
  mimeType: string;
  name: string;
  parentPath: string;
  path: string;
  sizeBytes: number;
  thumbnailDataUrl?: string;
}

export interface PreviewCommandContext {
  // The app-owned roots a local-file preview may resolve under: the agent workdir and its
  // scratch sibling (materialized attachments / web-fetch outputs live in scratch).
  agentLocalFileRoots: readonly string[];
  agentRuntime: Pick<AgentRuntime, 'previewPayload' | 'previewPayloadBytes'>;
  assetService: Pick<AssetService, 'lookup' | 'pathFor'>;
  inferMimeType: (filePath: string) => string;
  localFileReferencePreview: (file: TrustedLocalFileReference) => Promise<LocalFilePreviewMetadata>;
}

const PREVIEW_TEXT_BYTE_LIMIT = 1024 * 1024;
const PREVIEW_BYTES_LIMIT = 20 * 1024 * 1024;
const PREVIEW_DIRECTORY_ENTRY_LIMIT = 200;

export async function handlePreviewCommand(
  command: PreviewCommand,
  args: Record<string, unknown>,
  context: PreviewCommandContext,
) {
  const target = previewTargetFromUnknown(args.target);
  if (!target) {
    if (command === 'preview_resolve_source') return { source: null, error: 'invalid-target' } satisfies PreviewResolveSourceResult;
    if (command === 'preview_list_directory') return { entries: null, error: 'invalid-target' } satisfies PreviewListDirectoryResult;
    if (command === 'preview_read_bytes') return { bytes: null, error: 'invalid-target' } satisfies PreviewReadBytesResult;
    return { text: null, error: 'invalid-target' } satisfies PreviewReadTextResult;
  }

  switch (command) {
    case 'preview_resolve_source':
      return { source: await previewSourceForTarget(target, context) } satisfies PreviewResolveSourceResult;
    case 'preview_read_text':
      return previewTextForTarget(target, context);
    case 'preview_read_bytes':
      return previewBytesForTarget(target, context);
    case 'preview_list_directory':
      return previewDirectoryEntriesForTarget(target, context);
    default:
      throw new Error(`Unknown preview command: ${command}`);
  }
}

async function previewSourceForTarget(
  target: PreviewTarget,
  context: PreviewCommandContext,
): Promise<PreviewSourceDescriptor | null> {
  if (target.kind === 'local-file') {
    const file = await resolveTrustedLocalFileReference(target.path, context.agentLocalFileRoots);
    if (!file) return null;
    const metadata = await context.localFileReferencePreview(file);
    const normalizedTarget: PreviewTarget = {
      ...target,
      path: file.path,
      entryKind: file.entryKind,
    };
    const name = previewLabel(target.label) ?? metadata.name;
    return {
      kind: 'file',
      sourceKind: 'local-file',
      id: previewTargetKey(normalizedTarget),
      target: normalizedTarget,
      name,
      ext: previewExtension(metadata.name, metadata.mimeType),
      mimeType: metadata.mimeType,
      entryKind: metadata.entryKind,
      sizeBytes: metadata.sizeBytes,
      lastModified: metadata.lastModified,
      displayPath: metadata.path,
      ...(metadata.iconDataUrl ? { iconDataUrl: metadata.iconDataUrl } : {}),
      ...(metadata.thumbnailDataUrl ? { thumbnailDataUrl: metadata.thumbnailDataUrl } : {}),
    };
  }

  if (target.kind === 'asset') {
    const [metadata, filePath] = await Promise.all([
      context.assetService.lookup(target.assetId),
      context.assetService.pathFor(target.assetId),
    ]);
    if (!metadata || !filePath) return null;
    const fileStats = await stat(filePath).catch(() => null);
    const name = previewLabel(target.label)
      ?? metadata.originalFilename
      ?? `${target.assetId}${extensionForMimeType(metadata.mimeType)}`;
    return {
      kind: 'file',
      sourceKind: 'asset',
      id: previewTargetKey(target),
      target,
      name,
      ext: previewExtension(name, metadata.mimeType),
      mimeType: metadata.mimeType,
      entryKind: 'file',
      sizeBytes: metadata.byteSize,
      ...(fileStats ? { lastModified: fileStats.mtimeMs } : {}),
      streamUrl: assetUrl(target.assetId),
    };
  }

  if (target.kind === 'agent-payload') {
    const payload = await context.agentRuntime.previewPayload(target.conversationId, target.payloadId, target.runId);
    if (!payload) return null;
    const name = previewLabel(target.label) ?? agentPayloadPreviewName(payload);
    return {
      kind: 'file',
      sourceKind: 'agent-payload',
      id: previewTargetKey(target),
      target,
      name,
      ext: previewExtension(name, payload.mimeType),
      mimeType: payload.mimeType,
      entryKind: 'file',
      sizeBytes: payload.byteLength,
    };
  }

  const url = previewHttpUrl(target.url);
  if (!url) return null;
  return {
    kind: 'url',
    id: previewTargetKey({ ...target, url }),
    target: { ...target, url },
    url,
    title: previewLabel(target.label) ?? url,
  };
}

async function previewTextForTarget(
  target: PreviewTarget,
  context: PreviewCommandContext,
): Promise<PreviewReadTextResult> {
  const result = await previewBytesBufferForTarget(target, PREVIEW_TEXT_BYTE_LIMIT, context);
  if ('error' in result) return { text: null, error: result.error };
  return { text: result.bytes.toString('utf8') };
}

async function previewBytesForTarget(
  target: PreviewTarget,
  context: PreviewCommandContext,
): Promise<PreviewReadBytesResult> {
  const result = await previewBytesBufferForTarget(target, PREVIEW_BYTES_LIMIT, context);
  if ('error' in result) return { bytes: null, error: result.error };
  return {
    bytes: arrayBufferFromBuffer(result.bytes),
    mimeType: result.mimeType,
  };
}

async function previewBytesBufferForTarget(
  target: PreviewTarget,
  limitBytes: number,
  context: PreviewCommandContext,
): Promise<{ bytes: Buffer; mimeType: string; error?: never } | { bytes?: never; mimeType?: never; error: string }> {
  if (target.kind === 'local-file') {
    const file = await resolveTrustedLocalFileReference(target.path, context.agentLocalFileRoots);
    if (!file) return { error: 'missing' };
    if (file.entryKind !== 'file') return { error: 'unsupported-entry-kind' };
    if (file.stats.size > limitBytes) return { error: 'too-large' };
    return {
      bytes: await readFile(file.path),
      mimeType: context.inferMimeType(file.path),
    };
  }

  if (target.kind === 'asset') {
    const [metadata, filePath] = await Promise.all([
      context.assetService.lookup(target.assetId),
      context.assetService.pathFor(target.assetId),
    ]);
    if (!metadata || !filePath) return { error: 'missing' };
    if (metadata.byteSize > limitBytes) return { error: 'too-large' };
    return {
      bytes: await readFile(filePath),
      mimeType: metadata.mimeType,
    };
  }

  if (target.kind === 'agent-payload') {
    const payload = await context.agentRuntime.previewPayload(target.conversationId, target.payloadId, target.runId);
    if (!payload) return { error: 'missing' };
    if (payload.byteLength > limitBytes) return { error: 'too-large' };
    const bytes = await context.agentRuntime.previewPayloadBytes(target.conversationId, target.payloadId, target.runId);
    if (!bytes) return { error: 'missing' };
    return {
      bytes,
      mimeType: payload.mimeType,
    };
  }

  return { error: 'unsupported-target' };
}

async function previewDirectoryEntriesForTarget(
  target: PreviewTarget,
  context: PreviewCommandContext,
): Promise<PreviewListDirectoryResult> {
  if (target.kind !== 'local-file') return { entries: null, error: 'unsupported-target' };
  const file = await resolveTrustedLocalFileReference(target.path, context.agentLocalFileRoots);
  if (!file) return { entries: null, error: 'missing' };
  if (file.entryKind !== 'directory') return { entries: null, error: 'unsupported-entry-kind' };

  const dirents = await readdir(file.path, { withFileTypes: true });
  dirents.sort((left, right) => {
    if (left.isDirectory() !== right.isDirectory()) return left.isDirectory() ? -1 : 1;
    return left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
  });

  const entries: PreviewDirectoryEntry[] = [];
  let truncated = false;
  for (const dirent of dirents) {
    if (entries.length >= PREVIEW_DIRECTORY_ENTRY_LIMIT) {
      truncated = true;
      break;
    }
    const child = await resolveTrustedLocalFileReference(join(file.path, dirent.name), context.agentLocalFileRoots);
    if (!child) continue;
    const mimeType = child.entryKind === 'directory' ? 'inode/directory' : context.inferMimeType(child.path);
    entries.push({
      entryKind: child.entryKind,
      name: basename(child.path),
      target: {
        kind: 'local-file',
        path: child.path,
        entryKind: child.entryKind,
      },
      mimeType,
      sizeBytes: child.entryKind === 'directory' ? 0 : child.stats.size,
      lastModified: child.stats.mtimeMs,
    });
  }

  return { entries, truncated };
}

function arrayBufferFromBuffer(buffer: Buffer): ArrayBuffer {
  const bytes = new Uint8Array(buffer.byteLength);
  bytes.set(buffer);
  return bytes.buffer;
}

function previewLabel(label: string | undefined): string | null {
  const trimmed = label?.trim();
  return trimmed ? trimmed : null;
}

function previewExtension(name: string, mimeType: string): string {
  const fromName = extname(name).toLowerCase().replace(/^\./u, '');
  if (fromName) return fromName;
  return extensionForMimeType(mimeType).replace(/^\./u, '');
}

function extensionForMimeType(mimeType: string): string {
  const normalized = mimeType.toLowerCase();
  if (normalized === 'text/markdown') return '.md';
  if (normalized === 'text/csv') return '.csv';
  if (normalized === 'text/tab-separated-values') return '.tsv';
  if (normalized === 'text/plain') return '.txt';
  if (normalized === 'application/json') return '.json';
  if (normalized === 'application/xml' || normalized === 'text/xml') return '.xml';
  if (normalized === 'application/yaml' || normalized === 'text/yaml') return '.yaml';
  if (normalized === 'image/jpeg') return '.jpg';
  if (normalized === 'image/png') return '.png';
  if (normalized === 'image/gif') return '.gif';
  if (normalized === 'image/webp') return '.webp';
  if (normalized === 'image/svg+xml') return '.svg';
  if (normalized === 'application/pdf') return '.pdf';
  if (normalized === 'application/epub+zip') return '.epub';
  return '';
}

function agentPayloadPreviewName(payload: AgentPayloadRef): string {
  const summary = payload.summary?.replace(/\s+/gu, ' ').trim();
  if (summary) return summary;
  return `${payload.id}${extensionForMimeType(payload.mimeType)}`;
}

function previewHttpUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString();
  } catch {
    return null;
  }
}
