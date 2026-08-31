import { constants } from 'node:fs';
import { lstat, open, type FileHandle } from 'node:fs/promises';
import { MAX_MANAGED_ATTACHMENT_BYTES } from '../../../core/agentAttachmentLimits';
import { safeAttachmentFileName } from '../../../core/agentAttachmentPaths';
import type { ThreadResourceReference } from '../../../core/agent/protocol';
import type { TurnExecutionContext } from './types';

export const MAX_TOOL_ARTIFACT_BYTES = Math.min(
  MAX_MANAGED_ATTACHMENT_BYTES,
  64 * 1024 * 1024,
);

export interface ToolArtifactResource {
  readonly ref: ThreadResourceReference;
  readonly readablePath: string | null;
}

export interface ToolArtifactSink {
  persistBytes(input: {
    readonly bytes: Uint8Array;
    readonly mimeType: string;
    readonly fileName: string;
  }): Promise<ToolArtifactResource>;
  persistFile(input: {
    readonly path: string;
    readonly mimeType: string;
    readonly fileName: string;
  }): Promise<ToolArtifactResource>;
}

export class ToolArtifactAdmissionError extends Error {
  constructor(
    readonly code: 'artifact_too_large' | 'artifact_metadata_invalid' | 'artifact_source_invalid' | 'artifact_store_invalid',
    message: string,
  ) {
    super(message);
    this.name = 'ToolArtifactAdmissionError';
  }
}

export function createToolArtifactSink(context: TurnExecutionContext): ToolArtifactSink {
  const persistBytes: ToolArtifactSink['persistBytes'] = async (input) => {
    validateToolArtifactMetadata(input.mimeType, input.fileName);
    if (input.bytes.byteLength > MAX_TOOL_ARTIFACT_BYTES) {
      throw new ToolArtifactAdmissionError(
        'artifact_too_large',
        `Tool artifact exceeds the ${MAX_TOOL_ARTIFACT_BYTES}-byte admission limit.`,
      );
    }
    let ref: ThreadResourceReference;
    try {
      ref = await context.persistOutputResource(input.bytes, input.mimeType, input.fileName);
    } catch (error) {
      console.warn('[agent] Tool artifact storage rejected admitted bytes', error);
      throw new ToolArtifactAdmissionError(
        'artifact_store_invalid',
        error instanceof Error && error.name === 'ThreadResourceQuotaError'
          ? 'Tool artifact storage quota is exhausted.'
          : 'Tool artifact storage failed.',
      );
    }
    if (
      ref.byteLength !== input.bytes.byteLength
      || ref.mimeType !== input.mimeType
      || ref.fileName !== input.fileName
    ) {
      throw new ToolArtifactAdmissionError(
        'artifact_store_invalid',
        'Tool artifact storage returned metadata that does not match the admitted bytes.',
      );
    }
    const readablePath = (await context.resolveResourceObservationPath(ref).catch(() => null)) || null;
    return { ref, readablePath };
  };

  return {
    persistBytes,
    persistFile: async (input) => {
      validateToolArtifactMetadata(input.mimeType, input.fileName);
      const before = await lstat(input.path).catch(() => null);
      if (!before?.isFile() || before.isSymbolicLink()) {
        throw new ToolArtifactAdmissionError('artifact_source_invalid', 'Tool artifact source is not a regular file.');
      }
      if (before.size > MAX_TOOL_ARTIFACT_BYTES) {
        throw new ToolArtifactAdmissionError(
          'artifact_too_large',
          `Tool artifact exceeds the ${MAX_TOOL_ARTIFACT_BYTES}-byte admission limit.`,
        );
      }

      const noFollow = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW;
      const handle = await open(input.path, constants.O_RDONLY | noFollow).catch(() => null);
      if (!handle) {
        throw new ToolArtifactAdmissionError('artifact_source_invalid', 'Tool artifact source could not be opened safely.');
      }
      try {
        const after = await handle.stat();
        const hasPhysicalIdentity = before.dev !== 0 || before.ino !== 0 || after.dev !== 0 || after.ino !== 0;
        const identityChanged = hasPhysicalIdentity
          && (before.dev !== after.dev || before.ino !== after.ino);
        const metadataChanged = after.size !== before.size
          || after.mtimeMs !== before.mtimeMs
          || after.ctimeMs !== before.ctimeMs;
        if (!after.isFile() || identityChanged || metadataChanged) {
          throw new ToolArtifactAdmissionError('artifact_source_invalid', 'Tool artifact source changed during admission.');
        }
        const bytes = await readBoundedFile(handle, after.size);
        const final = await handle.stat();
        const changedWhileReading = final.dev !== after.dev
          || final.ino !== after.ino
          || final.size !== after.size
          || final.mtimeMs !== after.mtimeMs
          || final.ctimeMs !== after.ctimeMs;
        if (bytes.byteLength !== after.size || changedWhileReading) {
          throw new ToolArtifactAdmissionError('artifact_source_invalid', 'Tool artifact source changed while it was read.');
        }
        return persistBytes({ bytes, mimeType: input.mimeType, fileName: input.fileName });
      } finally {
        await handle.close();
      }
    },
  };
}

function validateToolArtifactMetadata(mimeType: string, fileName: string): void {
  const canonicalMimeType = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*(?:;[a-z0-9!#$&^_.+-]+=[a-z0-9!#$&^_.+-]+)*$/u;
  if (
    !canonicalMimeType.test(mimeType)
    || mimeType !== mimeType.trim().toLowerCase()
    || !fileName.trim()
    || safeAttachmentFileName(fileName) !== fileName
  ) {
    throw new ToolArtifactAdmissionError(
      'artifact_metadata_invalid',
      'Tool artifact MIME type and file name must already be safe canonical metadata.',
    );
  }
}

async function readBoundedFile(handle: FileHandle, expectedSize: number): Promise<Buffer> {
  const bytes = Buffer.allocUnsafe(expectedSize);
  let offset = 0;
  while (offset < bytes.byteLength) {
    const read = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
    if (read.bytesRead === 0) break;
    offset += read.bytesRead;
  }
  const overflow = Buffer.allocUnsafe(1);
  const extra = await handle.read(overflow, 0, 1, offset);
  if (offset !== expectedSize || extra.bytesRead !== 0) {
    throw new ToolArtifactAdmissionError('artifact_source_invalid', 'Tool artifact source changed while it was read.');
  }
  return bytes;
}
