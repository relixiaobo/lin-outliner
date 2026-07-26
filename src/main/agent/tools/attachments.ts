import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  MAX_IMAGE_ATTACHMENT_SOURCE_BYTES,
  MAX_PROMPT_IMAGE_BYTES,
} from '../../../core/agentAttachmentLimits';
import type {
  ThreadAttachmentContent,
  ThreadResourceReference,
  ThreadUserContent,
} from '../../../core/agent/protocol';
import { isPathInside } from '../capabilities/agentAttachmentMaterialization';
import type { ThreadUserContentResolutionContext } from '../ThreadService';

export interface AttachmentResolverOptions {
  readonly resolveResourcePath: (
    threadId: string,
    ref: ThreadResourceReference,
  ) => Promise<string | null>;
  readonly prepareImageSnapshot: (input: {
    readonly threadId: string;
    readonly attachment: ThreadAttachmentContent;
    readonly sourcePath: string;
  }) => Promise<{
    readonly ref: ThreadResourceReference;
    readonly created: boolean;
  }>;
}

export class AttachmentResolver {
  constructor(private readonly options: AttachmentResolverOptions) {}

  async resolve(
    content: readonly ThreadUserContent[],
    context: ThreadUserContentResolutionContext,
  ): Promise<readonly ThreadUserContent[]> {
    const resolved: ThreadUserContent[] = [];
    for (const part of content) {
      resolved.push(part.type === 'attachment' ? await this.resolveAttachment(part, context) : part);
    }
    return resolved;
  }

  private async resolveAttachment(
    attachment: ThreadAttachmentContent,
    context: ThreadUserContentResolutionContext,
  ): Promise<ThreadAttachmentContent> {
    const sourceMimeType = attachment.source.kind === 'threadPayload'
      ? attachment.source.ref.mimeType
      : attachment.mimeType;
    if (
      sourceMimeType.startsWith('image/')
      && attachment.source.kind === 'threadPayload'
      && attachment.source.ref.byteLength > MAX_IMAGE_ATTACHMENT_SOURCE_BYTES
    ) throw new Error('Image attachment exceeds the image decode budget.');
    const sourcePath = attachment.source.kind === 'localFile'
      ? await canonicalAttachmentPath(context.cwd, attachment.source.path)
      : await this.resolveManagedPath(context.threadId, attachment.source.ref);
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
    if (normalized.promptImage) {
      await this.validatePromptImage(context.threadId, normalized.promptImage);
      return normalized;
    }
    const promptImage = await this.options.prepareImageSnapshot({
      threadId: context.threadId,
      attachment: normalized,
      sourcePath,
    });
    if (promptImage.created) context.recordCreatedResource(promptImage.ref);
    return {
      ...normalized,
      promptImage: promptImage.ref,
    };
  }

  private async resolveManagedPath(threadId: string, ref: ThreadResourceReference): Promise<string> {
    const path = await this.options.resolveResourcePath(threadId, ref);
    if (!path) throw new Error(`Managed attachment payload is unavailable or corrupt: ${ref.id}`);
    return path;
  }

  private async validatePromptImage(threadId: string, ref: ThreadResourceReference): Promise<void> {
    if (!ref.mimeType.startsWith('image/') || ref.byteLength > MAX_PROMPT_IMAGE_BYTES) {
      throw new Error('Attachment prompt image exceeds the model-input image budget.');
    }
    await this.resolveManagedPath(threadId, ref);
  }
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
