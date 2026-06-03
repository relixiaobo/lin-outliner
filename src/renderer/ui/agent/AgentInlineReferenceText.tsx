import { useMemo, type CSSProperties } from 'react';
import { splitFileReferenceMarkers, splitNodeReferenceMarkers } from '../../../core/referenceMarkup';
import type { NodeId } from '../../api/types';
import type { DocumentIndex } from '../../state/document';
import {
  FileImageIcon,
  FileTextIcon,
  FolderIcon,
  ICON_SIZE,
} from '../icons';
import { wantsNewPaneFromClick } from '../shared';
import { inlineReferenceTextColor } from '../tags/tagColors';

export interface AgentNodeReferenceOpenOptions {
  newPane?: boolean;
}

export type AgentNodeReferenceOpenHandler = (
  nodeId: NodeId,
  options?: AgentNodeReferenceOpenOptions,
) => void;

interface NodeReferenceClickEventLike {
  ctrlKey: boolean;
  metaKey: boolean;
}

export function nodeReferenceOpenOptionsFromClick(
  event: NodeReferenceClickEventLike,
): AgentNodeReferenceOpenOptions {
  return { newPane: wantsNewPaneFromClick(event) };
}

interface AgentInlineReferenceTextProps {
  fileAttachments?: readonly AgentInlineFileReference[];
  index?: DocumentIndex;
  onNodeReferenceOpen?: AgentNodeReferenceOpenHandler;
  text: string;
}

export interface AgentInlineFileReference {
  kind: 'file' | 'image' | 'inline_text';
  name: string;
  ref: string;
  mimeType: string;
}

export function AgentInlineReferenceText({
  fileAttachments = [],
  index,
  onNodeReferenceOpen,
  text,
}: AgentInlineReferenceTextProps) {
  const segments = useMemo(() => splitNodeReferenceMarkers(text), [text]);

  return (
    <>
      {segments.map((segment, segmentIndex) => {
        if (segment.type === 'text') {
          return splitFileReferenceMentions(segment.text, fileAttachments)
            .map((fileSegment, fileSegmentIndex) => {
              if (fileSegment.type === 'text') return fileSegment.text;
              return (
                <span
                  aria-label={fileSegment.file.name}
                  className="agent-message-inline-file"
                  data-agent-message-file-ref={fileSegment.file.ref}
                  key={`${segmentIndex}-${fileSegment.file.ref}-${fileSegmentIndex}`}
                  title={fileSegment.file.name}
                >
                  {iconForInlineFile(fileSegment.file)}
                  <span>{fileSegment.file.name}</span>
                </span>
              );
            });
        }
        const style = nodeReferenceStyle(segment.nodeId, index);
        const label = nodeReferenceDisplayLabel(segment.label, segment.nodeId, index);
        const key = `${segment.raw}-${segment.nodeId}-${segmentIndex}`;
        if (!onNodeReferenceOpen) {
          return (
            <span
              className="inline-ref agent-message-inline-ref"
              data-inline-ref={segment.nodeId}
              key={key}
              style={style}
              title={label}
            >
              {label}
            </span>
          );
        }
        return (
          <button
            className="inline-ref agent-message-inline-ref"
            data-inline-ref={segment.nodeId}
            key={key}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onNodeReferenceOpen(segment.nodeId, nodeReferenceOpenOptionsFromClick(event));
            }}
            style={style}
            title={label}
            type="button"
          >
            {label}
          </button>
        );
      })}
    </>
  );
}

type FileReferenceTextSegment =
  | { type: 'text'; text: string }
  | { type: 'file'; file: AgentInlineFileReference };

function splitFileReferenceMentions(
  text: string,
  attachments: readonly AgentInlineFileReference[],
): FileReferenceTextSegment[] {
  const markerSegments = splitFileReferenceMarkers(text);
  if (markerSegments.some((segment) => segment.type === 'file')) {
    const attachmentsByRef = attachmentMapByRef(attachments);
    return mergeAdjacentTextSegments(markerSegments.map((segment): FileReferenceTextSegment => {
      if (segment.type === 'text') return segment;
      return {
        type: 'file',
        file: attachmentsByRef.get(segment.ref) ?? fallbackInlineFile(segment.ref, segment.entryKind),
      };
    }));
  }

  if (attachments.length === 0 || !text.includes('@')) return [{ type: 'text', text }];
  const candidates = dedupeInlineFiles(attachments)
    .filter((file) => file.name.trim().length > 0)
    .sort((left, right) => right.name.length - left.name.length);
  if (candidates.length === 0) return [{ type: 'text', text }];

  const segments: FileReferenceTextSegment[] = [];
  let offset = 0;
  while (offset < text.length) {
    if (text[offset] !== '@') {
      const nextAt = text.indexOf('@', offset + 1);
      const end = nextAt === -1 ? text.length : nextAt;
      segments.push({ type: 'text', text: text.slice(offset, end) });
      offset = end;
      continue;
    }

    const match = candidates.find((file) => {
      const mention = `@${file.name}`;
      if (!text.startsWith(mention, offset)) return false;
      return isFileMentionBoundary(text[offset + mention.length]);
    });
    if (!match) {
      segments.push({ type: 'text', text: text[offset] ?? '' });
      offset += 1;
      continue;
    }
    segments.push({ type: 'file', file: match });
    offset += match.name.length + 1;
  }
  return mergeAdjacentTextSegments(segments);
}

function dedupeInlineFiles(attachments: readonly AgentInlineFileReference[]): AgentInlineFileReference[] {
  const seen = new Set<string>();
  const out: AgentInlineFileReference[] = [];
  for (const attachment of attachments) {
    if (seen.has(attachment.ref)) continue;
    seen.add(attachment.ref);
    out.push(attachment);
  }
  return out;
}

function attachmentMapByRef(
  attachments: readonly AgentInlineFileReference[],
): Map<string, AgentInlineFileReference> {
  const byRef = new Map<string, AgentInlineFileReference>();
  for (const attachment of attachments) {
    if (!byRef.has(attachment.ref)) byRef.set(attachment.ref, attachment);
  }
  return byRef;
}

function fallbackInlineFile(ref: string, entryKind: 'file' | 'directory'): AgentInlineFileReference {
  return {
    kind: 'file',
    name: ref || 'file',
    ref: ref || 'file',
    mimeType: entryKind === 'directory' ? 'inode/directory' : 'application/octet-stream',
  };
}

function isFileMentionBoundary(next: string | undefined): boolean {
  if (!next) return true;
  return !/[A-Za-z0-9._-]/u.test(next);
}

function mergeAdjacentTextSegments(segments: FileReferenceTextSegment[]): FileReferenceTextSegment[] {
  const out: FileReferenceTextSegment[] = [];
  for (const segment of segments) {
    const previous = out.at(-1);
    if (segment.type === 'text' && previous?.type === 'text') {
      previous.text += segment.text;
    } else {
      out.push(segment);
    }
  }
  return out;
}

function iconForInlineFile(file: AgentInlineFileReference) {
  if (file.mimeType === 'inode/directory') return <FolderIcon size={ICON_SIZE.menu} />;
  if (file.kind === 'image' || file.mimeType.startsWith('image/')) return <FileImageIcon size={ICON_SIZE.menu} />;
  return <FileTextIcon size={ICON_SIZE.menu} />;
}

export function nodeReferenceStyle(nodeId: NodeId, index: DocumentIndex | undefined): CSSProperties | undefined {
  if (!index) return undefined;
  const color = inlineReferenceTextColor(nodeId, index);
  if (!color) return undefined;
  return {
    '--inline-ref-accent': color,
    color,
  } as CSSProperties;
}

export function nodeReferenceDisplayLabel(
  label: string,
  nodeId: NodeId,
  index: DocumentIndex | undefined,
): string {
  const explicit = label.trim();
  if (explicit) return explicit;
  const title = index?.byId.get(nodeId)?.content.text.trim();
  if (title) return title;
  return 'Referenced node';
}
