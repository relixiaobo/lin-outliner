import type { AgentFileAttachmentInput, AgentImageAttachmentInput, AgentTextAttachmentInput } from './agentTypes';
import { basenameForPath } from './referenceMarkup';
import type { ReferenceTarget } from './types';

const ATTACHMENT_START = '[lin attached file: ';
const ATTACHMENT_END = '[/lin attached file]';
const USER_ATTACHMENTS_START = '<user-attachments>';
const USER_ATTACHMENTS_END = '</user-attachments>';
export const SYSTEM_REMINDER_START = '<system-reminder>';
const SYSTEM_REMINDER_END = '</system-reminder>';

export interface ParsedAgentTextAttachment {
  ref: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  truncated: boolean;
  text: string;
}

export type AgentResourceItem =
  | {
      kind: 'image';
      ref: string;
      name: string;
      mimeType: string;
      sizeBytes: number;
      inline: true;
    }
  | {
      kind: 'file';
      ref: string;
      name: string;
      mimeType: string;
      sizeBytes: number;
      path: string;
      readPath: string;
    }
  | {
      kind: 'inline_text';
      ref: string;
      name: string;
      mimeType: string;
      sizeBytes: number;
      truncated: boolean;
    };

export interface AgentAttachmentMarker {
  version: 1;
  instructions: string;
  attachments: AgentResourceItem[];
}

export interface ReferenceTargetResourceMeta {
  ref?: string;
  name?: string;
  mimeType?: string;
  sizeBytes?: number;
  readPath?: string;
}

export function referenceTargetToResourceItem(
  target: ReferenceTarget,
  meta: ReferenceTargetResourceMeta = {},
): AgentResourceItem | null {
  if (target.kind === 'node') return null;
  if (target.kind === 'chat-source') return null;
  const name = meta.name?.trim() || basenameForPath(target.path) || target.path;
  const readPath = meta.readPath || target.path;
  return {
    kind: 'file',
    ref: meta.ref?.trim() || name,
    name,
    mimeType: meta.mimeType?.trim() || (target.entryKind === 'directory' ? 'inode/directory' : 'application/octet-stream'),
    sizeBytes: typeof meta.sizeBytes === 'number' && Number.isFinite(meta.sizeBytes) ? meta.sizeBytes : 0,
    path: target.path,
    readPath,
  };
}

export function serializeAgentTextAttachment(attachment: AgentTextAttachmentInput): string {
  const metadata = {
    ref: attachment.ref ?? attachment.name,
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
      ref: typeof metadata.ref === 'string' && metadata.ref.trim() ? metadata.ref : metadata.name,
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

export function serializeAgentAttachmentMarker(attachments: Array<AgentImageAttachmentInput | AgentFileAttachmentInput | AgentTextAttachmentInput>): string | null {
  const items = attachments.map((attachment): AgentResourceItem => {
    if (attachment.kind === 'image') {
      return {
        kind: 'image',
        ref: attachment.ref ?? attachment.name,
        name: attachment.name,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        inline: true,
      };
    }
    if (attachment.kind === 'file') {
      const entryKind = attachment.mimeType === 'inode/directory' ? 'directory' : 'file';
      return referenceTargetToResourceItem({
        kind: 'local-file',
        path: attachment.path,
        entryKind,
      }, {
        ref: attachment.ref ?? attachment.name,
        name: attachment.name,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        readPath: attachment.path,
      })!;
    }
    return {
      kind: 'inline_text',
      ref: attachment.ref ?? attachment.name,
      name: attachment.name,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      truncated: !!attachment.truncated,
    };
  });
  if (items.length === 0) return null;
  const marker: AgentAttachmentMarker = {
    version: 1,
    instructions: 'When user text includes [[file:<label>^<path>]], use the percent-decoded path and match the label/ref against these attachments when present. Images are visible as image content blocks. Files and folders are available at local paths; use file_read for files and file_glob for folders instead of assuming they are already visible. Inline text attachments are included in this user message.',
    attachments: items,
  };
  return `${USER_ATTACHMENTS_START}\n${JSON.stringify(marker, null, 2)}\n${USER_ATTACHMENTS_END}`;
}

export function parseAgentAttachmentMarkerBlock(text: string): AgentAttachmentMarker | null {
  const markerText = extractAgentAttachmentMarker(text);
  if (!markerText) return null;
  try {
    const parsed = JSON.parse(markerText) as Partial<AgentAttachmentMarker>;
    if (parsed.version !== 1 || !Array.isArray(parsed.attachments)) return null;
    const attachments: AgentResourceItem[] = [];
    for (const rawItem of parsed.attachments) {
      if (!rawItem || typeof rawItem !== 'object') continue;
      const item = rawItem as Partial<AgentResourceItem>;
      if (item.kind === 'image' && typeof item.name === 'string' && typeof item.mimeType === 'string') {
        attachments.push({
          kind: 'image',
          ref: typeof item.ref === 'string' && item.ref.trim() ? item.ref : item.name,
          name: item.name,
          mimeType: item.mimeType,
          sizeBytes: typeof item.sizeBytes === 'number' ? item.sizeBytes : 0,
          inline: true,
        });
      } else if (item.kind === 'file' && typeof item.name === 'string' && typeof item.mimeType === 'string' && typeof item.path === 'string') {
        attachments.push({
          kind: 'file',
          ref: typeof item.ref === 'string' && item.ref.trim() ? item.ref : item.name,
          name: item.name,
          mimeType: item.mimeType,
          sizeBytes: typeof item.sizeBytes === 'number' ? item.sizeBytes : 0,
          path: item.path,
          readPath: typeof item.readPath === 'string' && item.readPath ? item.readPath : item.path,
        });
      } else if (item.kind === 'inline_text' && typeof item.name === 'string' && typeof item.mimeType === 'string') {
        attachments.push({
          kind: 'inline_text',
          ref: typeof item.ref === 'string' && item.ref.trim() ? item.ref : item.name,
          name: item.name,
          mimeType: item.mimeType,
          sizeBytes: typeof item.sizeBytes === 'number' ? item.sizeBytes : 0,
          truncated: !!item.truncated,
        });
      }
    }
    return {
      version: 1,
      instructions: typeof parsed.instructions === 'string' ? parsed.instructions : '',
      attachments,
    };
  } catch {
    return null;
  }
}

export function systemReminder(text: string): string {
  return `${SYSTEM_REMINDER_START}\n${text}\n${SYSTEM_REMINDER_END}`;
}

export function isHiddenAgentContextBlock(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.startsWith(SYSTEM_REMINDER_START) || trimmed.startsWith(USER_ATTACHMENTS_START);
}

export function isSystemReminderBlock(text: string): boolean {
  return text.trimStart().startsWith(SYSTEM_REMINDER_START);
}

function extractAgentAttachmentMarker(text: string): string | null {
  const start = text.indexOf(USER_ATTACHMENTS_START);
  if (start < 0) return null;
  const contentStart = start + USER_ATTACHMENTS_START.length;
  const end = text.indexOf(USER_ATTACHMENTS_END, contentStart);
  if (end < 0) return null;
  return text.slice(contentStart, end).trim();
}
