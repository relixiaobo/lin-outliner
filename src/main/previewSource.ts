import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import type { AssetMetadata, CommandResult } from '../core/types';
import { assetUrl } from '../core/assets';
import type { ThreadImageArtifactReference, ThreadResourceReference } from '../core/agent/protocol';
import type { PreviewCommand } from '../core/commands';
import {
  normalizePreviewHttpUrl,
  previewTargetFromUnknown,
  previewTargetKey,
  type PreviewDirectoryEntry,
  type PreviewAuthorizeLinkedFileResult,
  type PreviewForgetLinkedFileResult,
  type PreviewListDirectoryResult,
  type PreviewReadBytesResult,
  type PreviewReadTextResult,
  type PreviewResolveSourceResult,
  type PreviewSourceDescriptor,
  type PreviewTarget,
} from '../core/preview';
import type {
  LinkedFileGrantAuthorization,
  LinkedFileGrantAdmission,
  LinkedFileGrantResolution,
  OpenedLinkedFileReference,
} from './linkedFileGrantStore';
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

export interface ThreadAttachmentPreviewFile extends TrustedLocalFileReference {
  readonly acceptedPathHints: readonly string[];
  readonly mimeType?: string;
}

type ResolvedLocalPreviewFile = TrustedLocalFileReference & { readonly mimeType?: string };

export interface PreviewCommandContext {
  // The app-owned roots an absolute local-file preview may resolve under: the agent workdir
  // and its scratch sibling (web-fetch and managed-resource observations live in scratch).
  agentLocalFileRoots: readonly string[];
  assetService: {
    lookup(assetId: string): Promise<AssetMetadata | null>;
    pathFor(assetId: string): Promise<string | null>;
  };
  assetFileStreamUrl?: (filePath: string, mimeType: string) => Promise<string | null>;
  inferMimeType: (filePath: string) => string;
  localFileStreamUrl?: (file: TrustedLocalFileReference, mimeType: string) => Promise<string | null>;
  threadAttachmentFile?: (threadId: string, attachmentId: string) => Promise<ThreadAttachmentPreviewFile | null>;
  threadResourceFile?: (
    threadId: string,
    ref: ThreadResourceReference,
  ) => Promise<ThreadAttachmentPreviewFile | null>;
  threadImageArtifactFile?: (
    threadId: string,
    artifact: ThreadImageArtifactReference,
  ) => Promise<ThreadAttachmentPreviewFile | null>;
  threadManagedFileStreamUrl?: (filePath: string, mimeType: string) => Promise<string | null>;
  localFileReferencePreview: (file: TrustedLocalFileReference) => Promise<LocalFilePreviewMetadata>;
  linkedFileGrant?: {
    resolve(sourceText: string): Promise<LinkedFileGrantResolution>;
    authorize(sourceText: string, selectedPath: string): Promise<LinkedFileGrantAuthorization>;
    admitSelectedFile(selectedPath: string): Promise<LinkedFileGrantAdmission>;
    revoke(sourceText: string): Promise<boolean>;
  };
  chooseLinkedFile?: () => Promise<string | null>;
  linkedFileStreamUrl?: (file: OpenedLinkedFileReference, mimeType: string) => Promise<string | null>;
  mutateLinkedFileSource?: (input: LinkedFileSourceMutation) => Promise<CommandResult>;
}

export type LinkedFileSourceMutation =
  | { kind: 'add'; ownerId: string; sourceText: string }
  | { kind: 'replace'; ownerId: string; sourceValueId: string; sourceText: string };

const PREVIEW_TEXT_BYTE_LIMIT = 1024 * 1024;
const PREVIEW_BYTES_LIMIT = 20 * 1024 * 1024;
const PREVIEW_DIRECTORY_ENTRY_LIMIT = 200;

export async function handlePreviewCommand(
  command: PreviewCommand,
  args: Record<string, unknown>,
  context: PreviewCommandContext,
) {
  if (command === 'preview_link_file_source' || command === 'preview_replace_source_with_file') {
    return mutateLinkedFileSource(command, args, context);
  }
  const target = previewTargetFromUnknown(args.target);
  if (!target) {
    if (command === 'preview_resolve_source') return { source: null, error: 'invalid-target' } satisfies PreviewResolveSourceResult;
    if (command === 'preview_list_directory') return { entries: null, error: 'invalid-target' } satisfies PreviewListDirectoryResult;
    if (command === 'preview_read_bytes') return { bytes: null, error: 'invalid-target' } satisfies PreviewReadBytesResult;
    if (command === 'preview_authorize_linked_file') return { authorized: false, error: 'invalid-source' } satisfies PreviewAuthorizeLinkedFileResult;
    if (command === 'preview_forget_linked_file') return { forgotten: false } satisfies PreviewForgetLinkedFileResult;
    return { text: null, error: 'invalid-target' } satisfies PreviewReadTextResult;
  }

  switch (command) {
    case 'preview_resolve_source': {
      if (target.kind === 'linked-file') return previewLinkedFileSource(target, context);
      return { source: await previewSourceForTarget(target, context) } satisfies PreviewResolveSourceResult;
    }
    case 'preview_read_text':
      return previewTextForTarget(target, context);
    case 'preview_read_bytes':
      return previewBytesForTarget(target, context);
    case 'preview_list_directory':
      return previewDirectoryEntriesForTarget(target, context);
    case 'preview_authorize_linked_file': {
      if (target.kind !== 'linked-file' || !context.linkedFileGrant || !context.chooseLinkedFile) {
        return { authorized: false, error: 'invalid-source' } satisfies PreviewAuthorizeLinkedFileResult;
      }
      const selectedPath = await context.chooseLinkedFile();
      if (!selectedPath) return { authorized: false, canceled: true } satisfies PreviewAuthorizeLinkedFileResult;
      const result = await context.linkedFileGrant.authorize(target.sourceText, selectedPath);
      return result.authorized
        ? { authorized: true } satisfies PreviewAuthorizeLinkedFileResult
        : { authorized: false, error: result.reason } satisfies PreviewAuthorizeLinkedFileResult;
    }
    case 'preview_forget_linked_file':
      return {
        forgotten: target.kind === 'linked-file'
          ? await context.linkedFileGrant?.revoke(target.sourceText) ?? false
          : false,
      } satisfies PreviewForgetLinkedFileResult;
    default:
      throw new Error(`Unknown preview command: ${command}`);
  }
}

async function mutateLinkedFileSource(
  command: 'preview_link_file_source' | 'preview_replace_source_with_file',
  args: Record<string, unknown>,
  context: PreviewCommandContext,
): Promise<CommandResult | null> {
  if (!context.chooseLinkedFile || !context.linkedFileGrant || !context.mutateLinkedFileSource) {
    throw new Error('Linked-file Source mutation is unavailable.');
  }
  const ownerId = requiredInputId(args.ownerId, 'ownerId');
  const sourceValueId = command === 'preview_replace_source_with_file'
    ? requiredInputId(args.sourceValueId, 'sourceValueId')
    : undefined;
  const selectedPath = await context.chooseLinkedFile();
  if (!selectedPath) return null;
  const admission = await context.linkedFileGrant.admitSelectedFile(selectedPath);
  if (!admission.authorized) throw new Error(`Linked-file authorization failed: ${admission.reason}.`);

  try {
    return await context.mutateLinkedFileSource(command === 'preview_link_file_source'
      ? { kind: 'add', ownerId, sourceText: admission.sourceText }
      : { kind: 'replace', ownerId, sourceValueId: sourceValueId!, sourceText: admission.sourceText });
  } catch (error) {
    if (admission.created) await context.linkedFileGrant.revoke(admission.sourceText).catch(() => undefined);
    throw error;
  }
}

function requiredInputId(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a non-empty string.`);
  return value;
}

async function previewSourceForTarget(
  target: PreviewTarget,
  context: PreviewCommandContext,
): Promise<PreviewSourceDescriptor | null> {
  if (target.kind === 'local-file') {
    const file = await resolveLocalFileTarget(target, context);
    if (!file) return null;
    const metadata = await context.localFileReferencePreview(file);
    const mimeType = file.mimeType ?? metadata.mimeType;
    const streamUrl = metadata.entryKind === 'file'
      ? target.threadId && (target.attachmentId || target.resourceRef || target.imageArtifactRef)
        ? await context.threadManagedFileStreamUrl?.(file.path, mimeType)
        : await context.localFileStreamUrl?.(file, mimeType)
      : null;
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
      ext: previewExtension(metadata.name, mimeType),
      mimeType,
      entryKind: metadata.entryKind,
      sizeBytes: metadata.sizeBytes,
      lastModified: metadata.lastModified,
      displayPath: metadata.path,
      ...(streamUrl ? { streamUrl } : {}),
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
    const isEpub = metadata.mimeType === 'application/epub+zip';
    const streamUrl = isEpub
      ? await context.assetFileStreamUrl?.(filePath, metadata.mimeType)
      : assetUrl(target.assetId);
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
      ...(streamUrl ? { streamUrl } : {}),
    };
  }

  if (target.kind === 'linked-file') return (await previewLinkedFileSource(target, context)).source;

  const url = normalizePreviewHttpUrl(target.url);
  if (!url) return null;
  return {
    kind: 'url',
    id: previewTargetKey({ ...target, url }),
    target: { ...target, url },
    url,
    title: previewLabel(target.label) ?? url,
  };
}

async function previewLinkedFileSource(
  target: Extract<PreviewTarget, { kind: 'linked-file' }>,
  context: PreviewCommandContext,
): Promise<PreviewResolveSourceResult> {
  const resolution = await context.linkedFileGrant?.resolve(target.sourceText)
    ?? { status: 'denied' as const };
  if (resolution.status !== 'ready') {
    return {
      source: null,
      error: resolution.status === 'denied' ? 'file-access-denied' : 'file-unavailable',
    };
  }
  const file = resolution.file;
  const mimeType = context.inferMimeType(file.path);
  const fileName = basename(file.path);
  let handleTransferred = false;
  try {
    const streamUrl = await context.linkedFileStreamUrl?.(file, mimeType) ?? null;
    handleTransferred = streamUrl !== null;
    return {
      source: {
        kind: 'file',
        sourceKind: 'linked-file',
        id: previewTargetKey(target),
        target,
        name: previewLabel(target.label) ?? fileName,
        ext: previewExtension(fileName, mimeType),
        mimeType,
        entryKind: 'file',
        sizeBytes: file.stats.size,
        lastModified: file.stats.mtimeMs,
        ...(streamUrl ? { streamUrl } : {}),
      },
    };
  } finally {
    if (!handleTransferred) await file.handle.close().catch(() => undefined);
  }
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
    const file = await resolveLocalFileTarget(target, context);
    if (!file) return { error: 'missing' };
    if (file.entryKind !== 'file') return { error: 'unsupported-entry-kind' };
    if (file.stats.size > limitBytes) return { error: 'too-large' };
    return {
      bytes: await readFile(file.path),
      mimeType: file.mimeType ?? context.inferMimeType(file.path),
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

  if (target.kind === 'linked-file') {
    const resolution = await context.linkedFileGrant?.resolve(target.sourceText)
      ?? { status: 'denied' as const };
    if (resolution.status !== 'ready') {
      return { error: resolution.status === 'denied' ? 'file-access-denied' : 'file-unavailable' };
    }
    const file = resolution.file;
    try {
      if (file.stats.size > limitBytes) return { error: 'too-large' };
      return {
        bytes: await file.handle.readFile(),
        mimeType: context.inferMimeType(file.path),
      };
    } catch {
      return { error: 'file-unavailable' };
    } finally {
      await file.handle.close().catch(() => undefined);
    }
  }

  return { error: 'unsupported-target' };
}

async function previewDirectoryEntriesForTarget(
  target: PreviewTarget,
  context: PreviewCommandContext,
): Promise<PreviewListDirectoryResult> {
  if (target.kind !== 'local-file') return { entries: null, error: 'unsupported-target' };
  const file = await resolveLocalFileTarget(target, context);
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
    const child = await resolveTrustedLocalFileReference(
      join(file.path, dirent.name),
      target.threadId && (target.attachmentId || target.resourceRef) ? [file.path] : context.agentLocalFileRoots,
    );
    if (!child) continue;
    const mimeType = child.entryKind === 'directory' ? 'inode/directory' : context.inferMimeType(child.path);
    entries.push({
      entryKind: child.entryKind,
      name: basename(child.path),
      target: {
        kind: 'local-file',
        path: child.path,
        entryKind: child.entryKind,
          ...(target.threadId && target.attachmentId
            ? { threadId: target.threadId, attachmentId: target.attachmentId }
            : target.threadId && target.resourceRef
              ? { threadId: target.threadId, resourceRef: target.resourceRef }
              : target.threadId && target.imageArtifactRef
                ? { threadId: target.threadId, imageArtifactRef: target.imageArtifactRef }
            : {}),
      },
      mimeType,
      sizeBytes: child.entryKind === 'directory' ? 0 : child.stats.size,
      lastModified: child.stats.mtimeMs,
    });
  }

  return { entries, truncated };
}

async function resolveLocalFileTarget(
  target: Extract<PreviewTarget, { kind: 'local-file' }>,
  context: PreviewCommandContext,
): Promise<ResolvedLocalPreviewFile | null> {
  if (!target.threadId) {
    return resolveTrustedLocalFileReference(
      target.path,
      context.agentLocalFileRoots,
    );
  }
  if (target.imageArtifactRef) {
    const artifact = await context.threadImageArtifactFile?.(target.threadId, target.imageArtifactRef);
    if (!artifact || artifact.entryKind !== 'file') return null;
    return target.path === artifact.path || artifact.acceptedPathHints.includes(target.path)
      ? artifact
      : null;
  }
  if (target.resourceRef) {
    const resource = await context.threadResourceFile?.(target.threadId, target.resourceRef);
    if (!resource || resource.entryKind !== 'file') return null;
    return target.path === resource.path || resource.acceptedPathHints.includes(target.path)
      ? resource
      : null;
  }
  if (!target.attachmentId) return null;
  const attachment = await context.threadAttachmentFile?.(target.threadId, target.attachmentId);
  if (!attachment) return null;
  if (attachment.entryKind === 'file') return target.path === attachment.path
    || attachment.acceptedPathHints.includes(target.path) ? attachment : null;
  if (target.path === attachment.path || attachment.acceptedPathHints.includes(target.path)) return attachment;
  return resolveTrustedLocalFileReference(
    target.path,
    [attachment.path],
  );
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
  if (normalized === 'text/html') return '.html';
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
