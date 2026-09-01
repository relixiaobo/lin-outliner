import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  MAX_COMPOSER_ATTACHMENTS,
  MAX_COMPOSER_IMAGE_ATTACHMENTS,
  MAX_IMAGE_ATTACHMENT_SOURCE_BYTES,
  MAX_PROMPT_IMAGE_BYTES,
  MAX_PROMPT_IMAGE_TOTAL_BYTES,
} from '../../../core/agentAttachmentLimits';
import type {
  ThreadAttachmentContent,
  ThreadImageArtifactReference,
  ThreadResourceReference,
  ThreadUserContent,
} from '../../../core/agent/protocol';
import { isPathInside } from '../capabilities/agentAttachmentMaterialization';
import type { ThreadUserContentResolutionContext } from '../ThreadService';

export interface AttachmentResolverOptions {
  readonly useResourcePath: <T>(
    threadId: string,
    ref: ThreadResourceReference,
    use: (path: string) => Promise<T>,
  ) => Promise<T | null>;
  readonly prepareImageArtifact: (input: {
    readonly threadId: string;
    readonly attachment: ThreadAttachmentContent;
    readonly sourcePath: string;
  }) => Promise<{
    readonly artifactRef: ThreadImageArtifactReference;
    readonly createdResources: readonly ThreadResourceReference[];
  }>;
  readonly captureLocalFile: (
    threadId: string,
    sourcePath: string,
    mimeType: string,
    fileName: string,
  ) => Promise<ThreadResourceReference>;
}

export class AttachmentResolver {
  constructor(private readonly options: AttachmentResolverOptions) {}

  async resolve(
    content: readonly ThreadUserContent[],
    context: ThreadUserContentResolutionContext,
  ): Promise<readonly ThreadUserContent[]> {
    const attachments = content.filter(
      (part): part is ThreadAttachmentContent => part.type === 'attachment',
    );
    if (attachments.length > MAX_COMPOSER_ATTACHMENTS) {
      throw new Error(`A message can contain at most ${MAX_COMPOSER_ATTACHMENTS} attachments.`);
    }
    const imageCount = attachments.reduce((count, attachment) => (
      count + Number(attachmentSourceMimeType(attachment).startsWith('image/'))
    ), 0);
    if (imageCount > MAX_COMPOSER_IMAGE_ATTACHMENTS) {
      throw new Error(`A message can contain at most ${MAX_COMPOSER_IMAGE_ATTACHMENTS} images.`);
    }
    const resolved: ThreadUserContent[] = [];
    let promptImageBytes = 0;
    for (const part of content) {
      const next = part.type === 'attachment' ? await this.resolveAttachment(part, context) : part;
      if (next.type === 'attachment' && next.artifactRef) {
        promptImageBytes += next.artifactRef.observation.byteLength;
        if (promptImageBytes > MAX_PROMPT_IMAGE_TOTAL_BYTES) {
          throw new Error('Image attachments exceed the 24 MiB normalized prompt-image budget.');
        }
      }
      resolved.push(next);
    }
    return resolved;
  }

  private async resolveAttachment(
    attachment: ThreadAttachmentContent,
    context: ThreadUserContentResolutionContext,
  ): Promise<ThreadAttachmentContent> {
    const sourceMimeType = attachmentSourceMimeType(attachment);
    if (
      sourceMimeType.startsWith('image/')
      && attachment.source.kind === 'resource'
      && attachment.source.ref.byteLength > MAX_IMAGE_ATTACHMENT_SOURCE_BYTES
    ) throw new Error('Image attachment exceeds the image decode budget.');
    if (attachment.source.kind === 'resource') {
      const resolved = await this.options.useResourcePath(
        context.threadId,
        attachment.source.ref,
        (sourcePath) => this.resolveFromPath(attachment, sourcePath, context),
      );
      if (!resolved) {
        throw new Error(`Managed attachment payload is unavailable or corrupt: ${attachment.source.ref.id}`);
      }
      return resolved;
    }
    const sourcePath = await canonicalAttachmentPath(context.cwd, attachment.source.path);
    const sourceStat = await stat(sourcePath);
    if (sourceStat.isDirectory()) return this.resolveFromPath(attachment, sourcePath, context);
    const captured = await this.options.captureLocalFile(
      context.threadId,
      sourcePath,
      attachment.mimeType,
      attachment.name,
    );
    context.recordCreatedResource(captured);
    return this.resolveFromPath({
      ...attachment,
      source: { kind: 'resource', ref: captured },
    }, sourcePath, context);
  }

  private async resolveFromPath(
    attachment: ThreadAttachmentContent,
    sourcePath: string,
    context: ThreadUserContentResolutionContext,
  ): Promise<ThreadAttachmentContent> {
    const sourceMimeType = attachment.source.kind === 'resource'
      ? attachment.source.ref.mimeType
      : attachment.mimeType;
    const sourceStat = await stat(sourcePath);
    const source = attachment.source.kind === 'localFile'
      ? { kind: 'localFile' as const, path: sourcePath }
      : attachment.source;
    const normalized: ThreadAttachmentContent = {
      ...attachment,
      mimeType: sourceMimeType,
      sizeBytes: sourceStat.isFile() ? sourceStat.size : 0,
      source,
    };
    if (!normalized.mimeType.startsWith('image/')) return normalized;
    if (normalized.artifactRef) {
      await this.validateImageArtifact(context.threadId, normalized);
      return normalized;
    }
    const prepared = await this.options.prepareImageArtifact({
      threadId: context.threadId,
      attachment: normalized,
      sourcePath,
    });
    for (const ref of prepared.createdResources) context.recordCreatedResource(ref);
    return {
      ...normalized,
      artifactRef: prepared.artifactRef,
    };
  }

  private async validateImageArtifact(threadId: string, attachment: ThreadAttachmentContent): Promise<void> {
    const artifact = attachment.artifactRef!;
    const ref = artifact.observation;
    if (!ref.mimeType.startsWith('image/') || ref.byteLength > MAX_PROMPT_IMAGE_BYTES) {
      throw new Error('Attachment observation exceeds the model-input image budget.');
    }
    if (JSON.stringify(artifact.original) !== JSON.stringify(attachment.source)) {
      throw new Error('Attachment source does not match its image artifact original.');
    }
    const available = await this.options.useResourcePath(threadId, ref, async () => true);
    if (!available) throw new Error(`Managed attachment payload is unavailable or corrupt: ${ref.id}`);
  }
}

function attachmentSourceMimeType(attachment: ThreadAttachmentContent): string {
  return (attachment.source.kind === 'resource'
    ? attachment.source.ref.mimeType
    : attachment.mimeType).trim().toLowerCase();
}

async function canonicalAttachmentPath(cwd: string, inputPath: string): Promise<string> {
  const root = await realpath(path.resolve(cwd));
  const candidate = path.resolve(path.isAbsolute(inputPath) ? inputPath : path.join(root, inputPath));
  const canonical = await realpath(candidate);
  const fileStat = await stat(canonical);
  if (fileStat.isFile()) return canonical;
  if (fileStat.isDirectory() && isPathInside(root, canonical)) return canonical;
  if (fileStat.isDirectory()) {
    throw new Error('Directory attachments outside the Thread working directory are not supported.');
  }
  throw new Error('Only regular file attachments can be used by the Agent.');
}
