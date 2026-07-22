import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MAX_MATERIALIZED_ATTACHMENT_BYTES } from '../../../core/agentAttachmentLimits';
import { safeAttachmentFileName } from '../../../core/agentAttachmentPaths';
import type { ThreadAttachmentContent, ThreadUserContent } from '../../../core/agent/protocol';
import {
  agentAttachmentDir,
  materializePathBackedAttachment,
  pruneOldAgentAttachments,
} from '../capabilities/agentAttachmentMaterialization';
import type { ThreadUserContentResolutionContext } from '../ThreadService';

export interface AttachmentResolverOptions {
  readonly scratchRoot: string;
  readonly resolveAssetPath: (assetId: string) => Promise<string | null>;
}

export class AttachmentResolver {
  constructor(private readonly options: AttachmentResolverOptions) {}

  async resolve(
    content: readonly ThreadUserContent[],
    context: ThreadUserContentResolutionContext,
  ): Promise<readonly ThreadUserContent[]> {
    return Promise.all(content.map(async (part) => (
      part.type === 'attachment' ? this.resolveAttachment(part, context) : part
    )));
  }

  private async resolveAttachment(
    attachment: ThreadAttachmentContent,
    context: ThreadUserContentResolutionContext,
  ): Promise<ThreadAttachmentContent> {
    if (attachment.source.kind === 'inline' && attachment.mimeType.startsWith('image/')) {
      return attachment;
    }
    const sourcePath = attachment.source.kind === 'localFile'
      ? attachment.source.path
      : attachment.source.kind === 'asset'
        ? await this.resolveAsset(attachment.source.assetId)
        : await this.writeInlineAttachment(attachment);
    const materialized = await materializePathBackedAttachment(
      context.cwd,
      this.options.scratchRoot,
      { name: attachment.name, path: sourcePath },
    );
    return {
      ...attachment,
      source: { kind: 'localFile', path: materialized.path },
    };
  }

  private async resolveAsset(assetId: string): Promise<string> {
    const path = await this.options.resolveAssetPath(assetId);
    if (!path) throw new Error(`Attachment asset was not found: ${assetId}`);
    return path;
  }

  private async writeInlineAttachment(attachment: ThreadAttachmentContent): Promise<string> {
    if (attachment.source.kind !== 'inline') throw new Error('Inline attachment source is required');
    const data = Buffer.from(attachment.source.dataBase64, 'base64');
    if (data.byteLength > MAX_MATERIALIZED_ATTACHMENT_BYTES) {
      throw new Error('Inline attachment is too large to materialize for agent access.');
    }
    await pruneOldAgentAttachments(this.options.scratchRoot);
    const directory = agentAttachmentDir(this.options.scratchRoot);
    await mkdir(directory, { recursive: true });
    const path = join(directory, `${randomUUID()}-${safeAttachmentFileName(attachment.name)}`);
    await writeFile(path, data);
    return path;
  }
}
