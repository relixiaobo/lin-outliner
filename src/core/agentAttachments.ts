import type { AgentTextAttachmentInput } from './agentTypes';

const ATTACHMENT_START = '[lin attached file: ';
const ATTACHMENT_END = '[/lin attached file]';

export interface ParsedAgentTextAttachment {
  name: string;
  mimeType: string;
  sizeBytes: number;
  truncated: boolean;
  text: string;
}

export function serializeAgentTextAttachment(attachment: AgentTextAttachmentInput): string {
  const metadata = {
    name: attachment.name,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    truncated: !!attachment.truncated,
  };
  return `${ATTACHMENT_START}${JSON.stringify(metadata)}]\n${attachment.text}\n${ATTACHMENT_END}`;
}

export function parseAgentTextAttachmentBlock(text: string): ParsedAgentTextAttachment | null {
  if (!text.startsWith(ATTACHMENT_START) || !text.endsWith(ATTACHMENT_END)) return null;

  const headerEnd = text.indexOf(']\n');
  if (headerEnd < ATTACHMENT_START.length) return null;

  const metadataText = text.slice(ATTACHMENT_START.length, headerEnd);
  const bodyStart = headerEnd + 2;
  const bodyEnd = text.length - ATTACHMENT_END.length;
  const body = text.slice(bodyStart, bodyEnd).replace(/\n$/, '');

  try {
    const metadata = JSON.parse(metadataText) as Partial<ParsedAgentTextAttachment>;
    if (typeof metadata.name !== 'string' || typeof metadata.mimeType !== 'string') return null;
    return {
      name: metadata.name,
      mimeType: metadata.mimeType,
      sizeBytes: typeof metadata.sizeBytes === 'number' ? metadata.sizeBytes : 0,
      truncated: !!metadata.truncated,
      text: body,
    };
  } catch {
    return null;
  }
}
