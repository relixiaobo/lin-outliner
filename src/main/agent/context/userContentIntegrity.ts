import type { ThreadUserContent } from '../../../core/agent/protocol';

export function assertCanonicalUserContent(content: readonly ThreadUserContent[]): void {
  for (const part of content) {
    if (part.type !== 'attachment') continue;
    const image = part.mimeType.startsWith('image/');
    if (image && !part.artifactRef) {
      throw new Error(`Canonical image attachment is missing its artifact reference: ${part.name}`);
    }
    if (!image && part.artifactRef) {
      throw new Error(`Non-image attachment cannot carry an image artifact: ${part.name}`);
    }
    if (part.artifactRef && !part.artifactRef.observation.mimeType.startsWith('image/')) {
      throw new Error(`Attachment observation is not an image: ${part.name}`);
    }
    if (part.artifactRef && JSON.stringify(part.artifactRef.original) !== JSON.stringify(part.source)) {
      throw new Error(`Attachment source does not match its image artifact original: ${part.name}`);
    }
    if (part.source.kind === 'threadPayload' && (
      part.source.ref.mimeType !== part.mimeType
      || part.source.ref.byteLength !== part.sizeBytes
    )) {
      throw new Error(`Managed attachment metadata does not match its resource reference: ${part.name}`);
    }
  }
}
