import type { ThreadUserContent } from '../../../core/agent/protocol';

export function assertCanonicalUserContent(content: readonly ThreadUserContent[]): void {
  for (const part of content) {
    if (part.type !== 'attachment') continue;
    const image = part.mimeType.startsWith('image/');
    if (image && !part.promptImage) {
      throw new Error(`Canonical image attachment is missing its prompt snapshot: ${part.name}`);
    }
    if (!image && part.promptImage) {
      throw new Error(`Non-image attachment cannot carry a prompt image: ${part.name}`);
    }
    if (part.promptImage && !part.promptImage.mimeType.startsWith('image/')) {
      throw new Error(`Attachment prompt snapshot is not an image: ${part.name}`);
    }
    if (part.source.kind === 'threadPayload' && (
      part.source.ref.mimeType !== part.mimeType
      || part.source.ref.byteLength !== part.sizeBytes
    )) {
      throw new Error(`Managed attachment metadata does not match its resource reference: ${part.name}`);
    }
  }
}
