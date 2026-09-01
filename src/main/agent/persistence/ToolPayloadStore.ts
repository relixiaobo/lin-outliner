import { createHash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { copyFile, lstat, mkdir, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { MAX_THREAD_MANAGED_ATTACHMENT_BYTES } from '../../../core/agentAttachmentLimits';
import {
  CONTEXT_PAYLOAD_KINDS,
  MAX_TOOL_ARGUMENT_TEXT_BYTES,
  MAX_THREAD_CONTEXT_PAYLOAD_BYTES,
  MAX_TURN_DIAGNOSTICS_PAYLOAD_BYTES,
  type ContextPayloadKind,
  type JsonValue,
  type ThreadContextPayload,
  type ThreadContextPayloadReference,
  type ThreadId,
  type ThreadInternalTextPayloadReference,
  type ThreadItemOutputReference,
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

const TEXT_MIME_EXTENSIONS = {
  'text/plain': '.txt',
  'application/json': '.json',
} as const satisfies Readonly<Record<ThreadItemOutputReference['mimeType'], string>>;
const SHA_256_PATTERN = /^[a-f0-9]{64}$/;
const CONTEXT_PAYLOAD_FILENAME_PATTERN = /^[a-f0-9]{64}\.json$/;
const TURN_DIAGNOSTICS_FILENAME_PATTERN = /^[a-f0-9]{64}\.json$/;
const TEXT_PAYLOAD_FILENAME_PATTERN = /^[a-f0-9]{64}\.(?:txt|json)$/;
const CONTEXT_DIR = 'context';
const INTERNAL_TEXT_DIR = 'internal-text';
const INTERNAL_TEXT_FILENAME_PATTERN = /^[a-f0-9]{64}\.txt$/;
const TURN_DIAGNOSTICS_DIR = 'turn-diagnostics';

export const MAX_TOOL_PAYLOAD_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_TOOL_PAYLOAD_IMAGE_BASE64_CHARS = Math.ceil(MAX_TOOL_PAYLOAD_IMAGE_BYTES / 3) * 4;

export type ToolPayloadImageMeasurement =
  | { readonly ok: true; readonly byteLength: number }
  | { readonly ok: false; readonly reason: 'invalidBase64' | 'imageByteLimit' };

interface StoredFileIdentity {
  readonly ctimeMs: number;
  readonly dev: number;
  readonly ino: number;
  readonly mtimeMs: number;
  readonly size: number;
}

export interface ToolPayloadStoreOptions {
  readonly maxThreadBytes?: number;
}

export class ThreadResourceQuotaError extends Error {
  constructor(message = 'Managed attachment exceeds the Thread storage quota.') {
    super(message);
    this.name = 'ThreadResourceQuotaError';
  }
}

export class ToolPayloadStore {
  private readonly resourceOperationTails = new Map<ThreadId, Promise<void>>();
  private readonly maxThreadBytes: number;

  constructor(private readonly rootPath: string, options: ToolPayloadStoreOptions = {}) {
    this.maxThreadBytes = options.maxThreadBytes ?? MAX_THREAD_MANAGED_ATTACHMENT_BYTES;
    if (!Number.isSafeInteger(this.maxThreadBytes) || this.maxThreadBytes < 0) {
      throw new Error('Tool payload Thread quota must be a non-negative safe integer.');
    }
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
      await writeFile(target, bytes, { flag: 'wx' }).catch(async (error: unknown) => {
        if (!isAlreadyExists(error)) throw error;
        if (!await verifyStoredPayload(target, ref)) {
          throw new Error('Context payload conflicts with existing bytes.');
        }
      });
      if (!await verifyStoredPayload(target, ref)) throw new Error('Published context payload is invalid.');
      return ref;
    });
  }

  async writeInternalText(
    threadId: ThreadId,
    text: string,
  ): Promise<ThreadInternalTextPayloadReference> {
    if (!hasWellFormedUnicode(text)) throw new Error('Internal text requires well-formed Unicode.');
    const bytes = Buffer.from(text, 'utf8');
    if (bytes.byteLength > MAX_TOOL_ARGUMENT_TEXT_BYTES) throw new Error('Internal text exceeds the payload budget.');
    const ref: ThreadInternalTextPayloadReference = {
      id: createHash('sha256').update(bytes).digest('hex'),
      encoding: 'utf-8',
      byteLength: bytes.byteLength,
    };
    return this.withResourceLock(threadId, async () => {
      const directory = await this.ensureManagedDirectory(threadId, INTERNAL_TEXT_DIR);
      const target = join(directory, internalTextFileName(ref));
      const existing = await lstat(target).catch((error: unknown) => {
        if (isNotFound(error)) return null;
        throw error;
      });
      if (existing) {
        if (!await verifyStoredPayload(target, ref)) throw new Error('Internal text conflicts with existing bytes.');
        return ref;
      }
      await this.assertResourceCapacity(threadId, bytes.byteLength);
      await writeFile(target, bytes, { flag: 'wx' }).catch(async (error: unknown) => {
        if (!isAlreadyExists(error)) throw error;
        if (!await verifyStoredPayload(target, ref)) throw new Error('Internal text conflicts with existing bytes.');
      });
      if (!await verifyStoredPayload(target, ref)) throw new Error('Published internal text is invalid.');
      return ref;
    });
  }

  async readInternalText(
    threadId: ThreadId,
    ref: ThreadInternalTextPayloadReference,
  ): Promise<string | null> {
    validateInternalTextReference(ref);
    const directory = await this.existingManagedDirectory(threadId, INTERNAL_TEXT_DIR);
    if (!directory) return null;
    const bytes = await readVerifiedPayloadBytes(join(directory, internalTextFileName(ref)), ref);
    if (!bytes) return null;
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return null;
    }
  }

  async readInternalTextProjection(
    threadId: ThreadId,
    ref: ThreadInternalTextPayloadReference,
    maxPrefixChars: number,
  ): Promise<{
    readonly textPrefix: string;
    readonly textChars: number;
    readonly jsonStringChars: number;
  } | null> {
    validateInternalTextReference(ref);
    if (!Number.isSafeInteger(maxPrefixChars) || maxPrefixChars < 0) {
      throw new Error('Invalid internal-text projection prefix limit.');
    }
    const directory = await this.existingManagedDirectory(threadId, INTERNAL_TEXT_DIR);
    if (!directory) return null;
    return readVerifiedInternalTextProjection(
      join(directory, internalTextFileName(ref)),
      ref,
      maxPrefixChars,
    );
  }

  async copyInternalTextToThread(
    sourceThreadId: ThreadId,
    targetThreadId: ThreadId,
    ref: ThreadInternalTextPayloadReference,
  ): Promise<boolean> {
    validateInternalTextReference(ref);
    const sourceDirectory = await this.existingManagedDirectory(sourceThreadId, INTERNAL_TEXT_DIR);
    if (!sourceDirectory) return false;
    const sourcePath = join(sourceDirectory, internalTextFileName(ref));
    if (!await readVerifiedPayloadBytes(sourcePath, ref)) return false;
    return this.withResourceLock(targetThreadId, async () => {
      const targetDirectory = await this.ensureManagedDirectory(targetThreadId, INTERNAL_TEXT_DIR);
      const targetPath = join(targetDirectory, internalTextFileName(ref));
      const existing = await lstat(targetPath).catch((error: unknown) => {
        if (isNotFound(error)) return null;
        throw error;
      });
      if (existing) {
        if (!await verifyStoredPayload(targetPath, ref)) {
          throw new Error('Internal text conflicts with existing bytes.');
        }
        return true;
      }
      await this.assertResourceCapacity(targetThreadId, ref.byteLength);
      try {
        await copyFile(sourcePath, targetPath, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
      } catch (error) {
        if (isNotFound(error)) return false;
        if (!isAlreadyExists(error)) throw error;
      }
      if (!await verifyStoredPayload(targetPath, ref)) {
        await rm(targetPath, { force: true });
        throw new Error('Copied internal text is invalid.');
      }
      return true;
    });
  }

  async pruneUnreferencedInternalText(
    threadId: ThreadId,
    references: readonly ThreadInternalTextPayloadReference[],
  ): Promise<void> {
    const retained = new Set(references.map((ref) => {
      validateInternalTextReference(ref);
      return internalTextFileName(ref);
    }));
    await this.withResourceLock(threadId, async () => {
      const directory = await this.existingManagedDirectory(threadId, INTERNAL_TEXT_DIR);
      if (!directory) return;
      for (const fileName of await readdir(directory)) {
        if (!INTERNAL_TEXT_FILENAME_PATTERN.test(fileName) || !retained.has(fileName)) {
          await rm(join(directory, fileName), { recursive: true, force: true });
        }
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
    internalTextReferences: readonly ThreadInternalTextPayloadReference[],
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
    await this.pruneUnreferencedInternalText(threadId, internalTextReferences);
  }

  async writeTurnDiagnostics(
    threadId: ThreadId,
    payload: unknown,
  ): Promise<TurnDiagnosticsPayloadReference> {
    const decoded = decodeTurnDiagnosticsPayload(payload);
    validateTurnDiagnosticsPoolDigests(decoded);
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
      await writeFile(target, bytes, { flag: 'wx' }).catch(async (error: unknown) => {
        if (!isAlreadyExists(error)) throw error;
        if (!await verifyStoredPayload(target, ref)) {
          throw new Error('Turn diagnostics conflict with existing bytes.');
        }
      });
      if (!await verifyStoredPayload(target, ref)) throw new Error('Published Turn diagnostics are invalid.');
      return ref;
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
    if (!bytes) return null;
    const payload = decodeTurnDiagnosticsPayloadJson(bytes.toString('utf8'));
    validateTurnDiagnosticsPoolDigests(payload);
    return payload;
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
    validateTurnDiagnosticsPoolDigests(decodeTurnDiagnosticsPayloadJson(sourceBytes.toString('utf8')));
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

  async deleteThread(threadId: ThreadId): Promise<void> {
    await this.withResourceLock(threadId, async () => {
      await rm(join(this.rootPath, threadId), { recursive: true, force: true });
    });
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

  private async managedPayloadBytes(threadId: ThreadId): Promise<number> {
    let total = 0;
    const contextDirectory = await this.existingManagedDirectory(threadId, CONTEXT_DIR);
    if (contextDirectory) {
      const files = await readdir(contextDirectory);
      for (const file of files) {
        if (!CONTEXT_PAYLOAD_FILENAME_PATTERN.test(file)) continue;
        const fileStat = await lstat(join(contextDirectory, file)).catch(() => null);
        if (fileStat?.isFile() && !fileStat.isSymbolicLink()) total += fileStat.size;
      }
    }
    const internalTextDirectory = await this.existingManagedDirectory(threadId, INTERNAL_TEXT_DIR);
    if (internalTextDirectory) {
      const files = await readdir(internalTextDirectory);
      for (const file of files) {
        if (!INTERNAL_TEXT_FILENAME_PATTERN.test(file)) continue;
        const fileStat = await lstat(join(internalTextDirectory, file)).catch(() => null);
        if (fileStat?.isFile() && !fileStat.isSymbolicLink()) total += fileStat.size;
      }
    }
    return total;
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
    const storedBytes = await this.managedPayloadBytes(threadId);
    if (storedBytes + additionalBytes > this.maxThreadBytes) {
      throw new ThreadResourceQuotaError();
    }
  }
}

export function measureToolPayloadImage(
  dataBase64: string,
  maxBytes = MAX_TOOL_PAYLOAD_IMAGE_BYTES,
): ToolPayloadImageMeasurement {
  if (dataBase64.length === 0) return { ok: false, reason: 'invalidBase64' };
  const maxBase64Chars = maxBytes === MAX_TOOL_PAYLOAD_IMAGE_BYTES
    ? MAX_TOOL_PAYLOAD_IMAGE_BASE64_CHARS
    : Math.ceil(maxBytes / 3) * 4;
  if (dataBase64.length > maxBase64Chars) {
    return { ok: false, reason: 'imageByteLimit' };
  }
  const padding = dataBase64.endsWith('==') ? 2 : dataBase64.endsWith('=') ? 1 : 0;
  if (padding > 0 && dataBase64.length % 4 !== 0) return { ok: false, reason: 'invalidBase64' };
  const bodyLength = dataBase64.length - padding;
  if (bodyLength % 4 === 1 || !/^[A-Za-z0-9+/]+={0,2}$/.test(dataBase64)) {
    return { ok: false, reason: 'invalidBase64' };
  }
  const byteLength = Math.floor(bodyLength * 3 / 4);
  return byteLength <= maxBytes
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

async function readVerifiedInternalTextProjection(
  path: string,
  ref: Pick<ThreadInternalTextPayloadReference, 'id' | 'byteLength'>,
  maxPrefixChars: number,
): Promise<{
  readonly textPrefix: string;
  readonly textChars: number;
  readonly jsonStringChars: number;
} | null> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null);
  if (!handle) return null;
  try {
    const before = await handle.stat();
    if (!isStoredResourceFile(before, ref.byteLength)) return null;
    const hash = createHash('sha256');
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const buffer = Buffer.alloc(Math.min(1024 * 1024, Math.max(1, ref.byteLength)));
    let position = 0;
    let textPrefix = '';
    let prefixTruncated = false;
    let textChars = 0;
    let jsonStringChars = 2;
    const consume = (text: string): void => {
      textChars += text.length;
      jsonStringChars += JSON.stringify(text).length - 2;
      if (prefixTruncated || textPrefix.length >= maxPrefixChars) return;
      const remaining = maxPrefixChars - textPrefix.length;
      let end = Math.min(text.length, remaining);
      if (
        end > 0
        && end < text.length
        && isHighSurrogate(text.charCodeAt(end - 1))
        && isLowSurrogate(text.charCodeAt(end))
      ) end -= 1;
      textPrefix += text.slice(0, end);
      prefixTruncated = end < text.length;
    };
    try {
      for (;;) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, position);
        if (bytesRead === 0) break;
        const chunk = buffer.subarray(0, bytesRead);
        hash.update(chunk);
        consume(decoder.decode(chunk, { stream: true }));
        position += bytesRead;
      }
      consume(decoder.decode());
    } catch {
      return null;
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
    return { textPrefix, textChars, jsonStringChars };
  } finally {
    await handle.close();
  }
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function hasWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (isHighSurrogate(code)) {
      if (!isLowSurrogate(value.charCodeAt(index + 1))) return false;
      index += 1;
    } else if (isLowSurrogate(code)) {
      return false;
    }
  }
  return true;
}

function isPlainDirectory(fileStat: Awaited<ReturnType<typeof lstat>>): boolean {
  return fileStat.isDirectory() && !fileStat.isSymbolicLink();
}

function isStoredResourceFile(fileStat: Stats, byteLength: number): boolean {
  return fileStat.isFile() && !fileStat.isSymbolicLink() && fileStat.size === byteLength;
}

function resourceFileIdentity(fileStat: Stats): StoredFileIdentity {
  return {
    ctimeMs: fileStat.ctimeMs,
    dev: fileStat.dev,
    ino: fileStat.ino,
    mtimeMs: fileStat.mtimeMs,
    size: fileStat.size,
  };
}

function sameResourceFileIdentity(
  left: StoredFileIdentity | undefined,
  right: StoredFileIdentity,
): boolean {
  if (!left) return false;
  return left.ctimeMs === right.ctimeMs
    && left.dev === right.dev
    && left.ino === right.ino
    && left.mtimeMs === right.mtimeMs
    && left.size === right.size;
}

function contextPayloadFileName(ref: ThreadContextPayloadReference): string {
  return `${ref.id}.json`;
}

function internalTextFileName(ref: ThreadInternalTextPayloadReference): string {
  return `${ref.id}.txt`;
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

function validateInternalTextReference(ref: ThreadInternalTextPayloadReference): void {
  if (!SHA_256_PATTERN.test(ref.id)) throw new Error('Invalid internal-text digest.');
  if (ref.encoding !== 'utf-8') throw new Error('Invalid internal-text encoding.');
  if (!Number.isSafeInteger(ref.byteLength) || ref.byteLength < 0 || ref.byteLength > MAX_TOOL_ARGUMENT_TEXT_BYTES) {
    throw new Error('Invalid internal-text byte length.');
  }
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

function validateTurnDiagnosticsPoolDigests(payload: TurnDiagnosticsPayload): void {
  for (const message of payload.canonicalMessages) {
    if (message.id !== diagnosticsValueDigest(message.value)) {
      throw new Error('Canonical diagnostics message digest does not match its value.');
    }
  }
  for (const fragment of payload.requestFragments) {
    if (fragment.id !== diagnosticsValueDigest(fragment.value)) {
      throw new Error('Provider request fragment digest does not match its value.');
    }
  }
}

function diagnosticsValueDigest(value: JsonValue): string {
  return createHash('sha256').update(stableJsonValue(value), 'utf8').digest('hex');
}

function stableJsonValue(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJsonValue).join(',')}]`;
  const record = value as Readonly<Record<string, JsonValue>>;
  return `{${Object.keys(record).sort().map((key) => (
    `${JSON.stringify(key)}:${stableJsonValue(record[key])}`
  )).join(',')}}`;
}

function validateTextPayloadReference(ref: ThreadItemOutputReference): void {
  if (!SHA_256_PATTERN.test(ref.id)) throw new Error('Invalid tool output digest');
  if (!(ref.mimeType in TEXT_MIME_EXTENSIONS)) throw new Error('Invalid tool output MIME type');
  if (!Number.isSafeInteger(ref.byteLength) || ref.byteLength < 0) {
    throw new Error('Invalid tool output byte length');
  }
}
