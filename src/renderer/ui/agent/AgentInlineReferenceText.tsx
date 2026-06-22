import { useMemo, type CSSProperties } from 'react';
import { basenameForPath, splitFileReferenceMarkers, splitReferenceMarkers } from '../../../core/referenceMarkup';
import type { NodeId } from '../../api/types';
import type { DocumentIndex } from '../../state/document';
import { requestRevealChatSource, type AgentChatSourceRevealTarget } from '../../agent/agentReveal';
import { InlineFileReference } from '../editor/InlineFileReference';
import {
  INLINE_CHAT_SOURCE_ICON_CLASS,
  INLINE_CHAT_SOURCE_LABEL_CLASS,
} from '../editor/inlineChatSourceIcon';
import { wantsNewPaneFromClick } from '../shared';
import { inlineReferenceTextColor } from '../tags/tagColors';
import { useT } from '../../i18n/I18nProvider';

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
  entryKind?: 'file' | 'directory';
  iconDataUrl?: string;
  kind: 'file' | 'image' | 'inline_text';
  lastModified?: number;
  name: string;
  path?: string;
  ref: string;
  mimeType: string;
  sizeBytes?: number;
  thumbnailDataUrl?: string;
}

export function AgentInlineReferenceText({
  fileAttachments = [],
  index,
  onNodeReferenceOpen,
  text,
}: AgentInlineReferenceTextProps) {
  const t = useT();
  const segments = useMemo(() => splitReferenceMarkers(text), [text]);
  const attachmentsByRef = useMemo(() => attachmentMapByRef(fileAttachments), [fileAttachments]);

  return (
    <>
      {segments.map((segment, segmentIndex) => {
        if (segment.type === 'text') {
          return splitFileReferenceMentions(segment.text, fileAttachments)
            .map((fileSegment, fileSegmentIndex) => {
              if (fileSegment.type === 'text') return fileSegment.text;
              return (
                <InlineFileReference
                  className="agent-message-inline-ref"
                  extraAttrs={{ 'data-agent-message-file-ref': fileSegment.file.ref }}
                  file={fileSegment.file}
                  key={`${segmentIndex}-${fileSegment.file.ref}-${fileSegmentIndex}`}
                />
              );
            });
        }

        if (segment.target.kind === 'local-file') {
          const ref = segment.label || basenameForPath(segment.target.path) || segment.target.path;
          return (
            <InlineFileReference
              className="agent-message-inline-ref"
              extraAttrs={{ 'data-agent-message-file-ref': ref }}
              file={fileWithMarkerFallback(attachmentsByRef.get(ref), {
                entryKind: segment.target.entryKind,
                label: segment.label,
                path: segment.target.path,
                ref,
              })}
              key={`${segment.raw}-${segment.target.path}-${segmentIndex}`}
            />
          );
        }

        if (segment.target.kind === 'chat-source') {
          const target = segment.target;
          const label = segment.label || 'Referenced chat';
          return (
            <a
              className="inline-ref agent-message-inline-ref"
              data-inline-ref-kind="chat-source"
              data-inline-ref-chat-stream={target.stream}
              data-inline-ref-chat-stream-id={target.streamId}
              data-inline-ref-chat-from-seq-exclusive={target.range.fromSeqExclusive}
              data-inline-ref-chat-through-seq={target.range.throughSeq}
              data-inline-ref-chat-through-event-id={target.range.throughEventId ?? undefined}
              href={chatSourceReferenceHref(segment.raw)}
              key={`${segment.raw}-${target.streamId}-${segmentIndex}`}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                void requestRevealChatSource(target);
              }}
            >
              <span aria-hidden="true" className={INLINE_CHAT_SOURCE_ICON_CLASS} />
              <span className={INLINE_CHAT_SOURCE_LABEL_CLASS}>{label}</span>
            </a>
          );
        }

        if (segment.target.kind !== 'node') return segment.raw;
        const target = segment.target;
        const style = nodeReferenceStyle(target.nodeId, index);
        const label = nodeReferenceDisplayLabel(segment.label, target.nodeId, index, t.agent.message.referencedNode);
        const key = `${segment.raw}-${target.nodeId}-${segmentIndex}`;
        if (!onNodeReferenceOpen) {
          return (
            <span
              className="inline-ref agent-message-inline-ref"
              data-inline-ref={target.nodeId}
              key={key}
              style={style}
              title={label}
            >
              {label}
            </span>
          );
        }
        return (
          <a
            className="inline-ref agent-message-inline-ref"
            data-inline-ref={target.nodeId}
            href={nodeReferenceHref(target.nodeId)}
            key={key}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onNodeReferenceOpen(target.nodeId, nodeReferenceOpenOptionsFromClick(event));
            }}
            style={style}
            title={label}
          >
            {label}
          </a>
        );
      })}
    </>
  );
}

type FileReferenceTextSegment =
  | { type: 'text'; text: string }
  | { type: 'file'; file: AgentInlineFileReference };

interface FileReferenceMarkerLike {
  entryKind: 'file' | 'directory';
  label: string;
  path: string;
  ref: string;
}

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
        file: fileWithMarkerFallback(attachmentsByRef.get(segment.ref), segment),
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

function fileWithMarkerFallback(
  attachment: AgentInlineFileReference | undefined,
  marker: FileReferenceMarkerLike,
): AgentInlineFileReference {
  if (!attachment) return fallbackInlineFile(marker);
  return {
    ...attachment,
    entryKind: attachment.entryKind ?? marker.entryKind,
    path: attachment.path ?? marker.path,
  };
}

function fallbackInlineFile(
  marker: FileReferenceMarkerLike,
): AgentInlineFileReference {
  return {
    entryKind: marker.entryKind,
    kind: 'file',
    name: marker.ref || 'file',
    path: marker.path,
    ref: marker.ref || 'file',
    mimeType: marker.entryKind === 'directory' ? 'inode/directory' : 'application/octet-stream',
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

// Synthetic href scheme for node-reference anchors. The value is never navigated
// (clicks are intercepted); it exists so the reference can be a real `<a>` —
// inline, breakable across lines, and natively focusable/clickable — instead of
// an atomic `<button>` that orphans onto its own line. The markdown link
// transform in AgentMarkdown emits the same scheme.
export const NODE_REFERENCE_LINK_PREFIX = 'lin-node:';
export const CHAT_SOURCE_REFERENCE_LINK_PREFIX = 'lin-chat-source:';

export function nodeReferenceHref(nodeId: NodeId): string {
  return `#${NODE_REFERENCE_LINK_PREFIX}${encodeURIComponent(nodeId)}`;
}

export function chatSourceReferenceHref(rawMarker: string): string {
  return `#${CHAT_SOURCE_REFERENCE_LINK_PREFIX}${encodeURIComponent(rawMarker)}`;
}

export function chatSourceFromReferenceHref(href: string | undefined): AgentChatSourceRevealTarget | null {
  const normalizedHref = href?.startsWith('#') ? href.slice(1) : href;
  if (!normalizedHref?.startsWith(CHAT_SOURCE_REFERENCE_LINK_PREFIX)) return null;
  const encodedMarker = normalizedHref.slice(CHAT_SOURCE_REFERENCE_LINK_PREFIX.length);
  let marker = '';
  try {
    marker = decodeURIComponent(encodedMarker);
  } catch {
    return null;
  }
  const segment = splitReferenceMarkers(marker).find((item) =>
    item.type === 'reference' && item.target.kind === 'chat-source');
  return segment?.type === 'reference' && segment.target.kind === 'chat-source' ? segment.target : null;
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
  fallback: string,
): string {
  const explicit = label.trim();
  if (explicit) return explicit;
  const title = index?.byId.get(nodeId)?.content.text.trim();
  if (title) return title;
  return fallback;
}
