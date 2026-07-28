import { createHash, randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { copyFile, link, lstat, mkdir, open, readFile, readdir, realpath, rm, rmdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  MAX_MANAGED_ATTACHMENT_BYTES,
  MAX_THREAD_MANAGED_ATTACHMENT_BYTES,
} from '../../../core/agentAttachmentLimits';
import { safeAttachmentFileName } from '../../../core/agentAttachmentPaths';
import {
  CONTEXT_PAYLOAD_KINDS,
  MAX_THREAD_CONTEXT_PAYLOAD_BYTES,
  MAX_TURN_DIAGNOSTICS_PAYLOAD_BYTES,
  type ContextPayloadKind,
  type ThreadContextPayload,
  type ThreadContextPayloadReference,
  type ThreadId,
  type ThreadItemOutputReference,
  type ThreadResourceReference,
  type TurnDiagnosticsPayload,
  type TurnDiagnosticsPayloadReference,
} from '../../../core/agent/protocol';
import {
  decodeTurnDiagnosticsPayload,
  decodeTurnDiagnosticsPayloadJson,
  decodeThreadContextPayload,
  decodeThreadContextPayloadJson,
  encodeTurnDiagnosticsPayload,
  encodeThreadContextPayload,
} from '../../../core/agent/codec';

const MIME_EXTENSIONS: Readonly<Record<string, string>> = {
  'image/gif': '.gif',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};

const TEXT_MIME_EXTENSIONS = {
  'text/plain': '.txt',
  'application/json': '.json',
} as const satisfies Readonly<Record<ThreadItemOutputReference['mimeType'], string>>;
const SHA_256_PATTERN = /^[a-f0-9]{64}$/;
const CONTEXT_PAYLOAD_FILENAME_PATTERN = /^[a-f0-9]{64}\.json$/;
const TURN_DIAGNOSTICS_FILENAME_PATTERN = /^[a-f0-9]{64}\.json$/;
const TEXT_PAYLOAD_FILENAME_PATTERN = /^[a-f0-9]{64}\.(?:txt|json)$/;
const CONTEXT_DIR = 'context';
const TURN_DIAGNOSTICS_DIR = 'turn-diagnostics';
const RESOURCE_DIR = 'resources';
const STAGING_DIR = '.staging';

export const MAX_TOOL_PAYLOAD_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_TOOL_PAYLOAD_IMAGE_BASE64_CHARS = Math.ceil(MAX_TOOL_PAYLOAD_IMAGE_BYTES / 3) * 4;

export type ToolPayloadImageMeasurement =
  | { readonly ok: true; readonly byteLength: number }
  | { readonly ok: false; readonly reason: 'invalidBase64' | 'imageByteLimit' };

interface PendingResourceUpload {
  readonly id: string;
  readonly threadId: ThreadId;
  readonly attachmentId: string;
  readonly expectedBytes: number;
  readonly mimeType: string;
  readonly fileName: string;
  readonly path: string;
  readonly handle: FileHandle;
  readonly hash: ReturnType<typeof createHash>;
  byteLength: number;
}

interface ResourceFileIdentity {
  readonly ctimeMs: number;
  readonly dev: number;
  readonly ino: number;
  readonly mtimeMs: number;
  readonly size: number;
}

export interface BeginResourceUploadInput {
  readonly threadId: ThreadId;
  readonly attachmentId: string;
  readonly expectedBytes: number;
  readonly mimeType: string;
  readonly fileName: string;
}

export interface WrittenThreadResource {
  readonly ref: ThreadResourceReference;
  readonly created: boolean;
}

export class ToolPayloadStore {
  private readonly pendingUploads = new Map<string, PendingResourceUpload>();
  private readonly resourceOperationTails = new Map<ThreadId, Promise<void>>();
  private readonly verifiedResourceFiles = new Map<string, ResourceFileIdentity>();

  constructor(private readonly rootPath: string) {}

  async initialize(): Promise<void> {
    const root = await this.existingManagedDirectory(null);
    if (!root) return;
    const threadIds = await readdir(root);
    await Promise.all(threadIds.map(async (threadId) => {
      const threadRoot = await this.existingManagedDirectory(threadId);
      if (!threadRoot) return;
      await rm(join(threadRoot, STAGING_DIR), { recursive: true, force: true });
    }));
  }

  async beginResourceUpload(input: BeginResourceUploadInput): Promise<string> {
    validateResourceMetadata(input.expectedBytes, input.mimeType, input.fileName);
    if (!input.attachmentId.trim()) throw new Error('Attachment id is required');
    return this.withResourceLock(input.threadId, async () => {
      await this.assertResourceCapacity(input.threadId, input.expectedBytes);
      const id = randomUUID();
      const directory = await this.ensureManagedDirectory(input.threadId, STAGING_DIR);
      const path = join(directory, id);
      const handle = await open(path, 'wx');
      this.pendingUploads.set(id, {
        ...input,
        id,
        fileName: safeAttachmentFileName(input.fileName),
        path,
        handle,
        hash: createHash('sha256'),
        byteLength: 0,
      });
      return id;
    });
  }

  async appendResourceUpload(
    threadId: ThreadId,
    attachmentId: string,
    uploadId: string,
    bytes: Uint8Array,
  ): Promise<void> {
    await this.withResourceLock(threadId, async () => {
      const upload = this.requireUpload(threadId, attachmentId, uploadId);
      if (bytes.byteLength === 0) return;
      if (upload.byteLength + bytes.byteLength > upload.expectedBytes) {
        await this.abortResourceUploadUnlocked(upload);
        throw new Error('Managed attachment upload exceeded its declared byte length.');
      }
      const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      let offset = 0;
      while (offset < buffer.byteLength) {
        const { bytesWritten } = await upload.handle.write(buffer, offset, buffer.byteLength - offset);
        if (bytesWritten <= 0) throw new Error('Managed attachment upload made no write progress.');
        offset += bytesWritten;
      }
      upload.hash.update(buffer);
      upload.byteLength += buffer.byteLength;
    });
  }

  async finishResourceUpload(
    threadId: ThreadId,
    attachmentId: string,
    uploadId: string,
  ): Promise<ThreadResourceReference> {
    return this.withResourceLock(threadId, async () => {
      const upload = this.requireUpload(threadId, attachmentId, uploadId);
      try {
        await upload.handle.close();
        if (upload.byteLength !== upload.expectedBytes) {
          throw new Error('Managed attachment upload did not match its declared byte length.');
        }
        const ref: ThreadResourceReference = {
          id: upload.hash.digest('hex'),
          mimeType: upload.mimeType,
          byteLength: upload.byteLength,
          fileName: upload.fileName,
        };
        const directory = await this.ensureManagedDirectory(threadId, RESOURCE_DIR, ref.id);
        const target = join(directory, ref.fileName);
        try {
          await link(upload.path, target);
          try {
            await this.rememberVerifiedResource(threadId, ref, target);
          } catch (error) {
            await this.rollbackPublishedResource(threadId, ref, target, error);
            throw error;
          }
        } catch (error) {
          if (!isAlreadyExists(error)) throw error;
          await this.verifyAndRememberResource(threadId, ref, target);
        }
        this.pendingUploads.delete(uploadId);
        await rm(upload.path, { force: true }).catch(() => undefined);
        return ref;
      } catch (error) {
        this.pendingUploads.delete(uploadId);
        await upload.handle.close().catch(() => undefined);
        await rm(upload.path, { force: true });
        throw error;
      }
    });
  }

  async abortResourceUpload(threadId: ThreadId, attachmentId: string, uploadId: string): Promise<void> {
    await this.withResourceLock(threadId, async () => {
      const upload = this.requireUpload(threadId, attachmentId, uploadId);
      await this.abortResourceUploadUnlocked(upload);
    });
  }

  async writeResource(
    threadId: ThreadId,
    bytes: Uint8Array,
    mimeType: string,
    fileName: string,
  ): Promise<ThreadResourceReference> {
    return (await this.writeResourceWithStatus(threadId, bytes, mimeType, fileName)).ref;
  }

  async writeResourceWithStatus(
    threadId: ThreadId,
    bytes: Uint8Array,
    mimeType: string,
    fileName: string,
  ): Promise<WrittenThreadResource> {
    validateResourceMetadata(bytes.byteLength, mimeType, fileName);
    const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const ref: ThreadResourceReference = {
      id: createHash('sha256').update(buffer).digest('hex'),
      mimeType,
      byteLength: buffer.byteLength,
      fileName: safeAttachmentFileName(fileName),
    };
    return this.withResourceLock(threadId, async () => {
      const directory = await this.ensureManagedDirectory(threadId, RESOURCE_DIR, ref.id);
      const target = join(directory, ref.fileName);
      const existing = await lstat(target).catch((error: unknown) => {
        if (isNotFound(error)) return null;
        throw error;
      });
      if (existing) {
        await this.verifyAndRememberResource(threadId, ref, target);
        return { ref, created: false };
      }
      await this.assertResourceCapacity(threadId, buffer.byteLength);
      let created = false;
      try {
        try {
          await writeFile(target, buffer, { flag: 'wx' });
          created = true;
        } catch (error) {
          if (!isAlreadyExists(error)) throw error;
          await this.verifyAndRememberResource(threadId, ref, target);
          return { ref, created: false };
        }
        await this.rememberVerifiedResource(threadId, ref, target);
        return { ref, created: true };
      } catch (error) {
        if (created) await this.rollbackPublishedResource(threadId, ref, target, error);
        throw error;
      }
    });
  }

  async useResourcePath<T>(
    threadId: ThreadId,
    ref: ThreadResourceReference,
    use: (path: string) => Promise<T>,
  ): Promise<T | null> {
    const path = await this.resourcePath(threadId, ref);
    return path ? use(path) : null;
  }

  async copyResourceForObservation(
    threadId: ThreadId,
    ref: ThreadResourceReference,
    targetDirectory: string,
  ): Promise<string | null> {
    const sourcePath = await this.resourcePath(threadId, ref);
    if (!sourcePath) return null;
    const directoryStat = await lstat(targetDirectory);
    if (!isPlainDirectory(directoryStat)) {
      throw new Error('Managed attachment observation target is not a safe directory.');
    }
    const targetPath = join(targetDirectory, ref.fileName);
    await copyFile(
      sourcePath,
      targetPath,
      constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE,
    );
    const targetStat = await lstat(targetPath);
    if (!isStoredResourceFile(targetStat, ref.byteLength)) {
      await rm(targetPath, { force: true });
      throw new Error('Managed attachment observation copy is invalid.');
    }
    return targetPath;
  }

  private async resourcePath(threadId: ThreadId, ref: ThreadResourceReference): Promise<string | null> {
    validateResourceReference(ref);
    const directory = await this.existingManagedDirectory(threadId, RESOURCE_DIR, ref.id);
    if (!directory) return null;
    const path = join(directory, ref.fileName);
    const fileStat = await lstat(path).catch((error: unknown) => {
      if (isNotFound(error)) return null;
      throw error;
    });
    if (!fileStat?.isFile() || fileStat.isSymbolicLink() || fileStat.size !== ref.byteLength) return null;
    const [canonicalPath, canonicalRoot] = await Promise.all([
      realpath(path).catch(() => null),
      realpath(join(this.rootPath, threadId, RESOURCE_DIR)).catch(() => null),
    ]);
    if (!canonicalPath || !canonicalRoot || !isPathInside(canonicalRoot, canonicalPath)) return null;
    const key = resourceFileKey(threadId, ref);
    const identity = resourceFileIdentity(fileStat);
    if (!sameResourceFileIdentity(this.verifiedResourceFiles.get(key), identity)) {
      const verified = await verifyStoredResource(canonicalPath, ref);
      if (!verified) {
        this.verifiedResourceFiles.delete(key);
        return null;
      }
      this.verifiedResourceFiles.set(key, verified);
    }
    return canonicalPath;
  }

  async readResource(threadId: ThreadId, ref: ThreadResourceReference): Promise<Buffer | null> {
    const path = await this.resourcePath(threadId, ref);
    if (!path) return null;
    const bytes = await readFile(path);
    if (createHash('sha256').update(bytes).digest('hex') !== ref.id) return null;
    return bytes;
  }

  async copyResourceToThread(
    sourceThreadId: ThreadId,
    targetThreadId: ThreadId,
    ref: ThreadResourceReference,
  ): Promise<boolean> {
    const sourcePath = await this.resourcePath(sourceThreadId, ref);
    if (!sourcePath) return false;
    return this.withResourceLock(targetThreadId, async () => {
      const targetDirectory = await this.ensureManagedDirectory(targetThreadId, RESOURCE_DIR, ref.id);
      const targetPath = join(targetDirectory, ref.fileName);
      const existing = await lstat(targetPath).catch((error: unknown) => {
        if (isNotFound(error)) return null;
        throw error;
      });
      if (existing) {
        await this.verifyAndRememberResource(targetThreadId, ref, targetPath);
        return true;
      }
      await this.assertResourceCapacity(targetThreadId, ref.byteLength);
      try {
        await copyFile(
          sourcePath,
          targetPath,
          constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE,
        );
        await this.rememberVerifiedResource(targetThreadId, ref, targetPath);
      } catch (error) {
        if (isAlreadyExists(error)) {
          await this.verifyAndRememberResource(targetThreadId, ref, targetPath);
          return true;
        }
        if (isNotFound(error)) return false;
        throw error;
      }
      return true;
    });
  }

  async deleteResource(threadId: ThreadId, ref: ThreadResourceReference): Promise<boolean> {
    validateResourceReference(ref);
    return this.withResourceLock(threadId, async () => {
      const directory = await this.existingManagedDirectory(threadId, RESOURCE_DIR, ref.id);
      if (!directory) return false;
      const target = join(directory, ref.fileName);
      const existing = await lstat(target).catch((error: unknown) => {
        if (isNotFound(error)) return null;
        throw error;
      });
      if (!existing) return false;
      await rm(target, { force: true });
      this.verifiedResourceFiles.delete(resourceFileKey(threadId, ref));
      await rmdir(dirname(target)).catch((error: unknown) => {
        if (!isNotFound(error) && !isDirectoryNotEmpty(error)) throw error;
      });
      return true;
    });
  }

  async pruneUnreferencedResources(
    threadId: ThreadId,
    references: readonly ThreadResourceReference[],
  ): Promise<void> {
    const retained = new Set(references.map((ref) => {
      validateResourceReference(ref);
      return resourceStorageKey(ref);
    }));
    await this.withResourceLock(threadId, async () => {
      this.clearVerifiedResources(threadId);
      const root = await this.existingManagedDirectory(threadId, RESOURCE_DIR);
      if (!root) return;
      const digests = await readdir(root);
      for (const digest of digests) {
        const digestPath = join(root, digest);
        const digestStat = await lstat(digestPath).catch((error: unknown) => {
          if (isNotFound(error)) return null;
          throw error;
        });
        if (!digestStat) continue;
        if (!SHA_256_PATTERN.test(digest) || !isPlainDirectory(digestStat)) {
          await rm(digestPath, { recursive: true, force: true });
          continue;
        }
        const files = await readdir(digestPath).catch((error: unknown) => {
          if (isNotFound(error)) return [];
          throw error;
        });
        for (const fileName of files) {
          if (!retained.has(resourceStorageKey({ id: digest, fileName }))) {
            await rm(join(digestPath, fileName), { recursive: true, force: true });
          }
        }
        await rmdir(digestPath).catch((error: unknown) => {
          if (!isNotFound(error) && !isDirectoryNotEmpty(error)) throw error;
        });
      }
    });
  }

  async writeContext(
    threadId: ThreadId,
    payload: unknown,
  ): Promise<ThreadContextPayloadReference> {
    const decoded = decodeThreadContextPayload(payload);
    const encoded = encodeThreadContextPayload(decoded);
    const bytes = Buffer.from(encoded, 'utf8');
    validateContextPayloadByteLength(bytes.byteLength);
    const ref: ThreadContextPayloadReference = {
      id: createHash('sha256').update(bytes).digest('hex'),
      mimeType: 'application/vnd.tenon.agent-context+json',
      byteLength: bytes.byteLength,
      schemaVersion: 1,
      kind: decoded.kind,
    };
    return this.withResourceLock(threadId, async () => {
      const directory = await this.ensureManagedDirectory(threadId, CONTEXT_DIR);
      const target = join(directory, contextPayloadFileName(ref));
      const existing = await lstat(target).catch((error: unknown) => {
        if (isNotFound(error)) return null;
        throw error;
      });
      if (existing) {
        if (!await verifyStoredPayload(target, ref)) throw new Error('Context payload conflicts with existing bytes.');
        return ref;
      }

      await this.assertResourceCapacity(threadId, bytes.byteLength);
      const stagingDirectory = await this.ensureManagedDirectory(threadId, STAGING_DIR);
      const stagingPath = join(stagingDirectory, randomUUID());
      try {
        await writeFile(stagingPath, bytes, { flag: 'wx' });
        await link(stagingPath, target).catch(async (error: unknown) => {
          if (!isAlreadyExists(error)) throw error;
          if (!await verifyStoredPayload(target, ref)) {
            throw new Error('Context payload conflicts with existing bytes.');
          }
        });
        if (!await verifyStoredPayload(target, ref)) throw new Error('Published context payload is invalid.');
        return ref;
      } finally {
        await rm(stagingPath, { force: true });
      }
    });
  }

  async readContext(
    threadId: ThreadId,
    ref: ThreadContextPayloadReference,
  ): Promise<ThreadContextPayload | null> {
    validateContextPayloadReference(ref);
    const directory = await this.existingManagedDirectory(threadId, CONTEXT_DIR);
    if (!directory) return null;
    const path = join(directory, contextPayloadFileName(ref));
    const bytes = await readVerifiedPayloadBytes(path, ref);
    if (!bytes) return null;
    const payload = decodeThreadContextPayloadJson(bytes.toString('utf8'));
    return payload.kind === ref.kind ? payload : null;
  }

  async copyContextToThread(
    sourceThreadId: ThreadId,
    targetThreadId: ThreadId,
    ref: ThreadContextPayloadReference,
  ): Promise<boolean> {
    validateContextPayloadReference(ref);
    const sourceDirectory = await this.existingManagedDirectory(sourceThreadId, CONTEXT_DIR);
    if (!sourceDirectory) return false;
    const sourcePath = join(sourceDirectory, contextPayloadFileName(ref));
    const sourceBytes = await readVerifiedPayloadBytes(sourcePath, ref);
    if (!sourceBytes) return false;
    if (decodeThreadContextPayloadJson(sourceBytes.toString('utf8')).kind !== ref.kind) return false;
    return this.withResourceLock(targetThreadId, async () => {
      const targetDirectory = await this.ensureManagedDirectory(targetThreadId, CONTEXT_DIR);
      const targetPath = join(targetDirectory, contextPayloadFileName(ref));
      const existing = await lstat(targetPath).catch((error: unknown) => {
        if (isNotFound(error)) return null;
        throw error;
      });
      if (existing) {
        if (!await verifyStoredPayload(targetPath, ref)) {
          throw new Error('Context payload conflicts with existing bytes.');
        }
        return true;
      }
      await this.assertResourceCapacity(targetThreadId, ref.byteLength);
      try {
        await copyFile(
          sourcePath,
          targetPath,
          constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE,
        );
      } catch (error) {
        if (isNotFound(error)) return false;
        if (!isAlreadyExists(error)) throw error;
      }
      if (!await verifyStoredPayload(targetPath, ref)) {
        await rm(targetPath, { force: true });
        throw new Error('Copied context payload is invalid.');
      }
      return true;
    });
  }

  async pruneUnreferencedContexts(
    threadId: ThreadId,
    references: readonly ThreadContextPayloadReference[],
  ): Promise<void> {
    const retained = new Set(references.map((ref) => {
      validateContextPayloadReference(ref);
      return contextPayloadFileName(ref);
    }));
    await this.withResourceLock(threadId, async () => {
      const directory = await this.existingManagedDirectory(threadId, CONTEXT_DIR);
      if (!directory) return;
      const files = await readdir(directory);
      for (const fileName of files) {
        if (!CONTEXT_PAYLOAD_FILENAME_PATTERN.test(fileName) || !retained.has(fileName)) {
          await rm(join(directory, fileName), { recursive: true, force: true });
        }
      }
    });
  }

  async writeTurnDiagnostics(
    threadId: ThreadId,
    payload: unknown,
  ): Promise<TurnDiagnosticsPayloadReference> {
    const decoded = decodeTurnDiagnosticsPayload(payload);
    const encoded = encodeTurnDiagnosticsPayload(decoded);
    const bytes = Buffer.from(encoded, 'utf8');
    validateTurnDiagnosticsPayloadByteLength(bytes.byteLength);
    const ref: TurnDiagnosticsPayloadReference = {
      id: createHash('sha256').update(bytes).digest('hex'),
      mimeType: 'application/vnd.tenon.agent-turn-diagnostics+json',
      byteLength: bytes.byteLength,
      schemaVersion: 1,
    };
    return this.withResourceLock(threadId, async () => {
      const directory = await this.ensureManagedDirectory(threadId, TURN_DIAGNOSTICS_DIR);
      const target = join(directory, turnDiagnosticsFileName(ref));
      const existing = await lstat(target).catch((error: unknown) => {
        if (isNotFound(error)) return null;
        throw error;
      });
      if (existing) {
        if (!await verifyStoredPayload(target, ref)) throw new Error('Turn diagnostics conflict with existing bytes.');
        return ref;
      }
      await this.assertResourceCapacity(threadId, bytes.byteLength);
      const stagingDirectory = await this.ensureManagedDirectory(threadId, STAGING_DIR);
      const stagingPath = join(stagingDirectory, randomUUID());
      try {
        await writeFile(stagingPath, bytes, { flag: 'wx' });
        await link(stagingPath, target).catch(async (error: unknown) => {
          if (!isAlreadyExists(error)) throw error;
          if (!await verifyStoredPayload(target, ref)) {
            throw new Error('Turn diagnostics conflict with existing bytes.');
          }
        });
        if (!await verifyStoredPayload(target, ref)) throw new Error('Published Turn diagnostics are invalid.');
        return ref;
      } finally {
        await rm(stagingPath, { force: true });
      }
    });
  }

  async readTurnDiagnostics(
    threadId: ThreadId,
    ref: TurnDiagnosticsPayloadReference,
  ): Promise<TurnDiagnosticsPayload | null> {
    validateTurnDiagnosticsPayloadReference(ref);
    const directory = await this.existingManagedDirectory(threadId, TURN_DIAGNOSTICS_DIR);
    if (!directory) return null;
    const path = join(directory, turnDiagnosticsFileName(ref));
    const bytes = await readVerifiedPayloadBytes(path, ref);
    return bytes ? decodeTurnDiagnosticsPayloadJson(bytes.toString('utf8')) : null;
  }

  async copyTurnDiagnosticsToThread(
    sourceThreadId: ThreadId,
    targetThreadId: ThreadId,
    ref: TurnDiagnosticsPayloadReference,
  ): Promise<boolean> {
    validateTurnDiagnosticsPayloadReference(ref);
    const sourceDirectory = await this.existingManagedDirectory(sourceThreadId, TURN_DIAGNOSTICS_DIR);
    if (!sourceDirectory) return false;
    const sourcePath = join(sourceDirectory, turnDiagnosticsFileName(ref));
    const sourceBytes = await readVerifiedPayloadBytes(sourcePath, ref);
    if (!sourceBytes) return false;
    decodeTurnDiagnosticsPayloadJson(sourceBytes.toString('utf8'));
    return this.withResourceLock(targetThreadId, async () => {
      const targetDirectory = await this.ensureManagedDirectory(targetThreadId, TURN_DIAGNOSTICS_DIR);
      const targetPath = join(targetDirectory, turnDiagnosticsFileName(ref));
      const existing = await lstat(targetPath).catch((error: unknown) => {
        if (isNotFound(error)) return null;
        throw error;
      });
      if (existing) {
        if (!await verifyStoredPayload(targetPath, ref)) {
          throw new Error('Turn diagnostics conflict with existing bytes.');
        }
        return true;
      }
      await this.assertResourceCapacity(targetThreadId, ref.byteLength);
      try {
        await copyFile(
          sourcePath,
          targetPath,
          constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE,
        );
      } catch (error) {
        if (isNotFound(error)) return false;
        if (!isAlreadyExists(error)) throw error;
      }
      if (!await verifyStoredPayload(targetPath, ref)) {
        await rm(targetPath, { force: true });
        throw new Error('Copied Turn diagnostics are invalid.');
      }
      return true;
    });
  }

  async pruneUnreferencedTurnDiagnostics(
    threadId: ThreadId,
    references: readonly TurnDiagnosticsPayloadReference[],
  ): Promise<void> {
    const retained = new Set(references.map((ref) => {
      validateTurnDiagnosticsPayloadReference(ref);
      return turnDiagnosticsFileName(ref);
    }));
    await this.withResourceLock(threadId, async () => {
      const directory = await this.existingManagedDirectory(threadId, TURN_DIAGNOSTICS_DIR);
      if (!directory) return;
      const files = await readdir(directory);
      for (const fileName of files) {
        if (!TURN_DIAGNOSTICS_FILENAME_PATTERN.test(fileName) || !retained.has(fileName)) {
          await rm(join(directory, fileName), { recursive: true, force: true });
        }
      }
    });
  }

  async writeText(
    threadId: ThreadId,
    _itemId: string,
    text: string,
    mimeType: ThreadItemOutputReference['mimeType'],
    summary: string,
  ): Promise<ThreadItemOutputReference> {
    const bytes = Buffer.from(text, 'utf8');
    const digest = createHash('sha256').update(bytes).digest('hex');
    const directory = await this.ensureManagedDirectory(threadId);
    const path = join(directory, `${digest}${TEXT_MIME_EXTENSIONS[mimeType]}`);
    const ref: ThreadItemOutputReference = {
      id: digest,
      mimeType,
      byteLength: bytes.byteLength,
      summary,
    };
    await writeFile(path, bytes, { flag: 'wx' }).catch((error: unknown) => {
      if (!isAlreadyExists(error)) throw error;
    });
    if (!await verifyStoredPayload(path, ref)) throw new Error('Tool output conflicts with existing bytes.');
    return ref;
  }

  async readTextReference(
    threadId: ThreadId,
    ref: ThreadItemOutputReference,
  ): Promise<string | null> {
    validateTextPayloadReference(ref);
    const directory = await this.existingManagedDirectory(threadId);
    if (!directory) return null;
    const path = join(directory, textPayloadFileName(ref));
    const bytes = await readVerifiedPayloadBytes(path, ref);
    return bytes?.toString('utf8') ?? null;
  }

  async copyTextToThread(
    sourceThreadId: ThreadId,
    targetThreadId: ThreadId,
    ref: ThreadItemOutputReference,
  ): Promise<boolean> {
    validateTextPayloadReference(ref);
    const filename = textPayloadFileName(ref);
    const sourceDirectory = await this.existingManagedDirectory(sourceThreadId);
    if (!sourceDirectory) return false;
    const sourcePath = join(sourceDirectory, filename);
    if (!await verifyStoredPayload(sourcePath, ref)) return false;
    const targetDirectory = await this.ensureManagedDirectory(targetThreadId);
    const targetPath = join(targetDirectory, filename);
    try {
      await copyFile(sourcePath, targetPath, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
    } catch (error) {
      if (isNotFound(error)) return false;
      if (!isAlreadyExists(error)) throw error;
    }
    if (!await verifyStoredPayload(targetPath, ref)) {
      await rm(targetPath, { force: true });
      throw new Error('Copied tool output is invalid.');
    }
    return true;
  }

  async pruneUnreferencedTextOutputs(
    threadId: ThreadId,
    references: readonly ThreadItemOutputReference[],
  ): Promise<void> {
    const retained = new Set(references.map((ref) => {
      validateTextPayloadReference(ref);
      return textPayloadFileName(ref);
    }));
    await this.withResourceLock(threadId, async () => {
      const directory = await this.existingManagedDirectory(threadId);
      if (!directory) return;
      const files = await readdir(directory);
      for (const fileName of files) {
        if (TEXT_PAYLOAD_FILENAME_PATTERN.test(fileName) && !retained.has(fileName)) {
          await rm(join(directory, fileName), { force: true });
        }
      }
    });
  }

  async writeImage(
    threadId: ThreadId,
    dataBase64: string,
    mimeType: string,
  ): Promise<ThreadResourceReference> {
    return (await this.writeImageWithStatus(threadId, dataBase64, mimeType)).ref;
  }

  async writeImageWithStatus(
    threadId: ThreadId,
    dataBase64: string,
    mimeType: string,
  ): Promise<WrittenThreadResource> {
    const normalizedMimeType = mimeType.trim().toLowerCase();
    if (!/^image\/[a-z0-9][a-z0-9.+-]*$/u.test(normalizedMimeType)) {
      throw new Error('Tool image payload MIME type must be an image.');
    }
    const measurement = measureToolPayloadImage(dataBase64);
    if (!measurement.ok) throw new Error(`Tool image payload rejected: ${measurement.reason}`);
    const bytes = Buffer.from(dataBase64, 'base64');
    if (bytes.length !== measurement.byteLength) throw new Error('Tool image payload decoded to an unexpected size');
    const extension = MIME_EXTENSIONS[normalizedMimeType] ?? '.bin';
    return this.writeResourceWithStatus(threadId, bytes, normalizedMimeType, `tool-output${extension}`);
  }

  async deleteThread(threadId: ThreadId): Promise<void> {
    await this.withResourceLock(threadId, async () => {
      await Promise.all([...this.pendingUploads.values()]
        .filter((upload) => upload.threadId === threadId)
        .map((upload) => this.abortResourceUploadUnlocked(upload)));
      await rm(join(this.rootPath, threadId), { recursive: true, force: true });
      this.clearVerifiedResources(threadId);
    });
  }

  async abortAllResourceUploads(): Promise<void> {
    await Promise.all([...this.pendingUploads.values()].map((upload) => (
      this.abortResourceUpload(upload.threadId, upload.attachmentId, upload.id)
    )));
  }

  private requireUpload(threadId: ThreadId, attachmentId: string, uploadId: string): PendingResourceUpload {
    const upload = this.pendingUploads.get(uploadId);
    if (!upload || upload.threadId !== threadId || upload.attachmentId !== attachmentId) {
      throw new Error('Managed attachment upload was not found.');
    }
    return upload;
  }

  private async rollbackPublishedResource(
    threadId: ThreadId,
    ref: ThreadResourceReference,
    target: string,
    originalError: unknown,
  ): Promise<void> {
    try {
      await rm(target, { force: true });
      this.verifiedResourceFiles.delete(resourceFileKey(threadId, ref));
      await rmdir(dirname(target)).catch((error: unknown) => {
        if (!isNotFound(error) && !isDirectoryNotEmpty(error)) throw error;
      });
    } catch (rollbackError) {
      throw new AggregateError(
        [originalError, rollbackError],
        'Managed attachment publication failed and could not be rolled back.',
      );
    }
  }

  private async abortResourceUploadUnlocked(upload: PendingResourceUpload): Promise<void> {
    this.pendingUploads.delete(upload.id);
    await upload.handle.close().catch(() => undefined);
    await rm(upload.path, { force: true });
  }

  private async withResourceLock<T>(threadId: ThreadId, operation: () => Promise<T>): Promise<T> {
    const previous = this.resourceOperationTails.get(threadId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const tail = previous.catch(() => undefined).then(() => gate);
    this.resourceOperationTails.set(threadId, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.resourceOperationTails.get(threadId) === tail) {
        this.resourceOperationTails.delete(threadId);
      }
    }
  }

  private async managedResourceBytes(threadId: ThreadId): Promise<number> {
    const directory = await this.existingManagedDirectory(threadId, RESOURCE_DIR);
    let total = 0;
    if (directory) {
      const digests = await readdir(directory);
      for (const digest of digests) {
        if (!SHA_256_PATTERN.test(digest)) continue;
        const digestPath = join(directory, digest);
        const digestStat = await lstat(digestPath).catch(() => null);
        if (!digestStat || !isPlainDirectory(digestStat)) continue;
        const files = await readdir(digestPath).catch(() => []);
        for (const file of files) {
          const fileStat = await lstat(join(digestPath, file)).catch(() => null);
          if (fileStat?.isFile() && !fileStat.isSymbolicLink()) total += fileStat.size;
        }
      }
    }
    const contextDirectory = await this.existingManagedDirectory(threadId, CONTEXT_DIR);
    if (contextDirectory) {
      const files = await readdir(contextDirectory);
      for (const file of files) {
        if (!CONTEXT_PAYLOAD_FILENAME_PATTERN.test(file)) continue;
        const fileStat = await lstat(join(contextDirectory, file)).catch(() => null);
        if (fileStat?.isFile() && !fileStat.isSymbolicLink()) total += fileStat.size;
      }
    }
    return total;
  }

  private async rememberVerifiedResource(
    threadId: ThreadId,
    ref: ThreadResourceReference,
    path: string,
  ): Promise<void> {
    const fileStat = await lstat(path);
    if (!isStoredResourceFile(fileStat, ref.byteLength)) {
      throw new Error('Managed attachment payload conflicts with an existing resource.');
    }
    this.verifiedResourceFiles.set(resourceFileKey(threadId, ref), resourceFileIdentity(fileStat));
  }

  private async verifyAndRememberResource(
    threadId: ThreadId,
    ref: ThreadResourceReference,
    path: string,
  ): Promise<void> {
    const identity = await verifyStoredResource(path, ref);
    if (!identity) throw new Error('Managed attachment payload conflicts with an existing resource.');
    this.verifiedResourceFiles.set(resourceFileKey(threadId, ref), identity);
  }

  private clearVerifiedResources(threadId: ThreadId): void {
    const prefix = `${threadId}\0`;
    for (const key of this.verifiedResourceFiles.keys()) {
      if (key.startsWith(prefix)) this.verifiedResourceFiles.delete(key);
    }
  }

  private async ensureManagedDirectory(threadId: ThreadId, ...segments: string[]): Promise<string> {
    const paths = [this.rootPath];
    if (threadId) paths.push(join(paths.at(-1)!, threadId));
    for (const segment of segments) paths.push(join(paths.at(-1)!, segment));
    for (const path of paths) {
      await mkdir(path, { recursive: true });
      const fileStat = await lstat(path);
      if (!isPlainDirectory(fileStat)) {
        throw new Error('Managed attachment storage contains an unsafe directory entry.');
      }
    }
    return paths.at(-1)!;
  }

  private async existingManagedDirectory(threadId: ThreadId | null, ...segments: string[]): Promise<string | null> {
    const paths = [this.rootPath];
    if (threadId) paths.push(join(paths.at(-1)!, threadId));
    for (const segment of segments) paths.push(join(paths.at(-1)!, segment));
    for (const path of paths) {
      const fileStat = await lstat(path).catch((error: unknown) => {
        if (isNotFound(error)) return null;
        throw error;
      });
      if (!fileStat || !isPlainDirectory(fileStat)) return null;
    }
    return paths.at(-1)!;
  }

  private async assertResourceCapacity(threadId: ThreadId, additionalBytes: number): Promise<void> {
    const activeBytes = [...this.pendingUploads.values()]
      .filter((upload) => upload.threadId === threadId)
      .reduce((total, upload) => total + upload.expectedBytes, 0);
    const storedBytes = await this.managedResourceBytes(threadId);
    if (storedBytes + activeBytes + additionalBytes > MAX_THREAD_MANAGED_ATTACHMENT_BYTES) {
      throw new Error('Managed attachment exceeds the Thread storage quota.');
    }
  }
}

export function measureToolPayloadImage(dataBase64: string): ToolPayloadImageMeasurement {
  if (dataBase64.length === 0) return { ok: false, reason: 'invalidBase64' };
  if (dataBase64.length > MAX_TOOL_PAYLOAD_IMAGE_BASE64_CHARS) {
    return { ok: false, reason: 'imageByteLimit' };
  }
  const padding = dataBase64.endsWith('==') ? 2 : dataBase64.endsWith('=') ? 1 : 0;
  if (padding > 0 && dataBase64.length % 4 !== 0) return { ok: false, reason: 'invalidBase64' };
  const bodyLength = dataBase64.length - padding;
  if (bodyLength % 4 === 1 || !/^[A-Za-z0-9+/]+={0,2}$/.test(dataBase64)) {
    return { ok: false, reason: 'invalidBase64' };
  }
  const byteLength = Math.floor(bodyLength * 3 / 4);
  return byteLength <= MAX_TOOL_PAYLOAD_IMAGE_BYTES
    ? { ok: true, byteLength }
    : { ok: false, reason: 'imageByteLimit' };
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { code?: unknown }).code === 'EEXIST';
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { code?: unknown }).code === 'ENOENT';
}

function isDirectoryNotEmpty(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { code?: unknown }).code === 'ENOTEMPTY';
}

function isPathInside(root: string, candidate: string): boolean {
  const pathFromRoot = relative(resolve(root), resolve(candidate));
  return pathFromRoot === '' || (!pathFromRoot.startsWith('..') && !isAbsolute(pathFromRoot));
}

function validateResourceMetadata(byteLength: number, mimeType: string, fileName: string): void {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
    throw new Error('Managed attachment byte length must be a non-negative safe integer.');
  }
  if (byteLength > MAX_MANAGED_ATTACHMENT_BYTES) {
    throw new Error('Managed attachment exceeds the pathless input storage budget.');
  }
  if (!mimeType.trim()) throw new Error('Managed attachment MIME type is required.');
  if (!fileName.trim()) throw new Error('Managed attachment file name is required.');
}

async function verifyStoredResource(
  path: string,
  ref: ThreadResourceReference,
): Promise<ResourceFileIdentity | null> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null);
  if (!handle) return null;
  try {
    const before = await handle.stat();
    if (!isStoredResourceFile(before, ref.byteLength)) return null;
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(1024 * 1024);
    let position = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = await handle.stat();
    const current = await lstat(path).catch(() => null);
    if (
      position !== ref.byteLength
      || hash.digest('hex') !== ref.id
      || !current
      || !sameResourceFileIdentity(resourceFileIdentity(before), resourceFileIdentity(after))
      || !sameResourceFileIdentity(resourceFileIdentity(after), resourceFileIdentity(current))
    ) return null;
    return resourceFileIdentity(after);
  } finally {
    await handle.close();
  }
}

async function verifyStoredPayload(
  path: string,
  ref: Pick<ThreadContextPayloadReference, 'id' | 'byteLength'>,
): Promise<boolean> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null);
  if (!handle) return false;
  try {
    const before = await handle.stat();
    if (!isStoredResourceFile(before, ref.byteLength)) return false;
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(Math.min(1024 * 1024, Math.max(1, ref.byteLength)));
    let position = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = await handle.stat();
    const current = await lstat(path).catch(() => null);
    return position === ref.byteLength
      && hash.digest('hex') === ref.id
      && current !== null
      && sameResourceFileIdentity(resourceFileIdentity(before), resourceFileIdentity(after))
      && sameResourceFileIdentity(resourceFileIdentity(after), resourceFileIdentity(current));
  } finally {
    await handle.close();
  }
}

async function readVerifiedPayloadBytes(
  path: string,
  ref: Pick<ThreadContextPayloadReference, 'id' | 'byteLength'>,
): Promise<Buffer | null> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null);
  if (!handle) return null;
  try {
    const before = await handle.stat();
    if (!isStoredResourceFile(before, ref.byteLength)) return null;
    const bytes = await handle.readFile();
    const after = await handle.stat();
    const current = await lstat(path).catch(() => null);
    if (
      bytes.byteLength !== ref.byteLength
      || createHash('sha256').update(bytes).digest('hex') !== ref.id
      || !current
      || !sameResourceFileIdentity(resourceFileIdentity(before), resourceFileIdentity(after))
      || !sameResourceFileIdentity(resourceFileIdentity(after), resourceFileIdentity(current))
    ) return null;
    return bytes;
  } finally {
    await handle.close();
  }
}

function isPlainDirectory(fileStat: Awaited<ReturnType<typeof lstat>>): boolean {
  return fileStat.isDirectory() && !fileStat.isSymbolicLink();
}

function isStoredResourceFile(fileStat: Stats, byteLength: number): boolean {
  return fileStat.isFile() && !fileStat.isSymbolicLink() && fileStat.size === byteLength;
}

function resourceFileIdentity(fileStat: Stats): ResourceFileIdentity {
  return {
    ctimeMs: fileStat.ctimeMs,
    dev: fileStat.dev,
    ino: fileStat.ino,
    mtimeMs: fileStat.mtimeMs,
    size: fileStat.size,
  };
}

function sameResourceFileIdentity(
  left: ResourceFileIdentity | undefined,
  right: ResourceFileIdentity,
): boolean {
  if (!left) return false;
  return left.ctimeMs === right.ctimeMs
    && left.dev === right.dev
    && left.ino === right.ino
    && left.mtimeMs === right.mtimeMs
    && left.size === right.size;
}

function resourceFileKey(threadId: ThreadId, ref: ThreadResourceReference): string {
  return `${threadId}\0${resourceStorageKey(ref)}`;
}

function resourceStorageKey(ref: Pick<ThreadResourceReference, 'id' | 'fileName'>): string {
  return `${ref.id}\0${ref.fileName}`;
}

export function referencesSameResourceFile(
  left: ThreadResourceReference,
  right: ThreadResourceReference,
): boolean {
  return resourceStorageKey(left) === resourceStorageKey(right);
}

function validateResourceReference(ref: ThreadResourceReference): void {
  if (!SHA_256_PATTERN.test(ref.id)) throw new Error('Invalid managed attachment digest');
  validateResourceMetadata(ref.byteLength, ref.mimeType, ref.fileName);
  if (safeAttachmentFileName(ref.fileName) !== ref.fileName) {
    throw new Error('Invalid managed attachment file name');
  }
}

function contextPayloadFileName(ref: ThreadContextPayloadReference): string {
  return `${ref.id}.json`;
}

function turnDiagnosticsFileName(ref: TurnDiagnosticsPayloadReference): string {
  return `${ref.id}.json`;
}

function textPayloadFileName(ref: ThreadItemOutputReference): string {
  return `${ref.id}${TEXT_MIME_EXTENSIONS[ref.mimeType]}`;
}

function validateContextPayloadByteLength(byteLength: number): void {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
    throw new Error('Context payload byte length must be a non-negative safe integer.');
  }
  if (byteLength > MAX_THREAD_CONTEXT_PAYLOAD_BYTES) {
    throw new Error('Context payload exceeds the managed payload budget.');
  }
}

function validateContextPayloadReference(ref: ThreadContextPayloadReference): void {
  if (!SHA_256_PATTERN.test(ref.id)) throw new Error('Invalid context payload digest.');
  if (ref.mimeType !== 'application/vnd.tenon.agent-context+json') {
    throw new Error('Invalid context payload MIME type.');
  }
  if (ref.schemaVersion !== 1) throw new Error('Invalid context payload schema version.');
  if (!(CONTEXT_PAYLOAD_KINDS as readonly ContextPayloadKind[]).includes(ref.kind)) {
    throw new Error('Invalid context payload kind.');
  }
  validateContextPayloadByteLength(ref.byteLength);
}

function validateTurnDiagnosticsPayloadReference(ref: TurnDiagnosticsPayloadReference): void {
  if (!SHA_256_PATTERN.test(ref.id)) throw new Error('Invalid Turn diagnostics digest.');
  if (ref.mimeType !== 'application/vnd.tenon.agent-turn-diagnostics+json') {
    throw new Error('Invalid Turn diagnostics MIME type.');
  }
  if (ref.schemaVersion !== 1) throw new Error('Invalid Turn diagnostics schema version.');
  validateTurnDiagnosticsPayloadByteLength(ref.byteLength);
}

function validateTurnDiagnosticsPayloadByteLength(byteLength: number): void {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
    throw new Error('Turn diagnostics byte length must be a non-negative safe integer.');
  }
  if (byteLength > MAX_TURN_DIAGNOSTICS_PAYLOAD_BYTES) {
    throw new Error('Turn diagnostics exceed the managed payload budget.');
  }
}

function validateTextPayloadReference(ref: ThreadItemOutputReference): void {
  if (!SHA_256_PATTERN.test(ref.id)) throw new Error('Invalid tool output digest');
  if (!(ref.mimeType in TEXT_MIME_EXTENSIONS)) throw new Error('Invalid tool output MIME type');
  if (!Number.isSafeInteger(ref.byteLength) || ref.byteLength < 0) {
    throw new Error('Invalid tool output byte length');
  }
}
