import type { ReferenceTarget, RichText } from './types';

export interface ParsedReferenceMarker {
  end: number;
  label: string;
  raw: string;
  start: number;
  target: ReferenceTarget;
}

export type ReferenceTextSegment =
  | { text: string; type: 'text' }
  | {
    label: string;
    raw: string;
    target: ReferenceTarget;
    type: 'reference';
  };

export interface ParsedNodeReferenceMarker {
  end: number;
  label: string;
  nodeId: string;
  raw: string;
  start: number;
}

export type NodeReferenceTextSegment =
  | { text: string; type: 'text' }
  | {
    label: string;
    nodeId: string;
    raw: string;
    type: 'nodeReference';
  };

export interface FileReferenceSegment {
  type: 'file';
  raw: string;
  ref: string;
  label: string;
  path: string;
  entryKind: 'file' | 'directory';
}

export interface ChatSourceReferenceSegment {
  type: 'chat';
  raw: string;
  ref: string;
  label: string;
  target: Extract<ReferenceTarget, { kind: 'chat-source' }>;
}

export type FileReferenceTextSegment =
  | { type: 'text'; text: string }
  | FileReferenceSegment;

export type ChatSourceReferenceTextSegment =
  | { type: 'text'; text: string }
  | ChatSourceReferenceSegment;

const REFERENCE_PATTERN = /\[\[([^\[\]\r\n]*?)\]\]/gu;

export function formatNodeReferenceMarker(label: string, nodeId: string): string {
  const safeNodeId = nodeId.trim();
  return formatReferenceMarker(sanitizeReferenceLabel(label) || safeNodeId, { kind: 'node', nodeId: safeNodeId });
}

export function formatNodeReferenceIdMarker(nodeId: string): string {
  const safeNodeId = nodeId.trim();
  return formatReferenceMarker('', { kind: 'node', nodeId: safeNodeId });
}

export function formatFileReferenceMarker(label: string, path = label, entryKind: 'file' | 'directory' = 'file'): string {
  const safePath = path || 'attachment';
  return formatReferenceMarker(sanitizeReferenceLabel(label) || basenameForPath(safePath) || safePath, {
    kind: 'local-file',
    path: safePath,
    entryKind,
  });
}

export function sanitizeFileReferenceRef(ref: string): string {
  return sanitizeReferenceLabel(ref) || 'attachment';
}

export function formatChatSourceReferenceMarker(
  label: string,
  target: Extract<ReferenceTarget, { kind: 'chat-source' }>,
): string {
  return formatReferenceMarker(sanitizeReferenceLabel(label) || chatSourceFallbackLabel(target), target);
}

export function formatReferenceMarker(label: string, target: ReferenceTarget): string {
  const safeLabel = sanitizeReferenceLabel(label);
  if (target.kind === 'node') {
    const nodeId = target.nodeId.trim();
    return `[[node:${safeLabel}^${encodeReferenceValue(nodeId)}]]`;
  }
  if (target.kind === 'chat-source') {
    const streamId = encodeReferenceValue(target.streamId.trim());
    const eventId = target.range.throughEventId ? `:${encodeReferenceValue(target.range.throughEventId)}` : '';
    return `[[chat:${safeLabel}^${target.stream}:${streamId}@${target.range.fromSeqExclusive}-${target.range.throughSeq}${eventId}]]`;
  }
  const path = target.path;
  const encodedPath = encodeReferenceValue(path);
  const kindSuffix = target.entryKind === 'directory' ? '^directory' : '';
  return `[[file:${safeLabel}^${encodedPath}${kindSuffix}]]`;
}

export function parseReferenceMarkers(text: string): ParsedReferenceMarker[] {
  const markers: ParsedReferenceMarker[] = [];
  for (const match of text.matchAll(REFERENCE_PATTERN)) {
    const raw = match[0] ?? '';
    const inner = match[1] ?? '';
    const start = match.index ?? 0;
    const parsed = parseReferenceInner(inner);
    if (!raw || !parsed) continue;
    markers.push({
      end: start + raw.length,
      label: parsed.label,
      raw,
      start,
      target: parsed.target,
    });
  }
  return markers;
}

export function splitReferenceMarkers(text: string): ReferenceTextSegment[] {
  const markers = parseReferenceMarkers(text);
  if (markers.length === 0) return [{ text, type: 'text' }];

  const segments: ReferenceTextSegment[] = [];
  let cursor = 0;
  for (const marker of markers) {
    if (marker.start > cursor) {
      segments.push({ text: text.slice(cursor, marker.start), type: 'text' });
    }
    segments.push({
      label: marker.label,
      raw: marker.raw,
      target: marker.target,
      type: 'reference',
    });
    cursor = marker.end;
  }
  if (cursor < text.length) {
    segments.push({ text: text.slice(cursor), type: 'text' });
  }
  return segments;
}

export function parseNodeReferenceMarkers(text: string): ParsedNodeReferenceMarker[] {
  return parseReferenceMarkers(text)
    .filter((marker): marker is ParsedReferenceMarker & { target: Extract<ReferenceTarget, { kind: 'node' }> } =>
      marker.target.kind === 'node')
    .map((marker) => ({
      end: marker.end,
      label: marker.label,
      nodeId: marker.target.nodeId,
      raw: marker.raw,
      start: marker.start,
    }));
}

export function splitNodeReferenceMarkers(text: string): NodeReferenceTextSegment[] {
  return splitReferenceMarkers(text).map((segment): NodeReferenceTextSegment => {
    if (segment.type === 'text') return segment;
    if (segment.target.kind !== 'node') return { text: segment.raw, type: 'text' };
    return {
      label: segment.label,
      nodeId: segment.target.nodeId,
      raw: segment.raw,
      type: 'nodeReference',
    };
  });
}

export function splitFileReferenceMarkers(text: string): FileReferenceTextSegment[] {
  return splitReferenceMarkers(text).map((segment): FileReferenceTextSegment => {
    if (segment.type === 'text') return segment;
    if (segment.target.kind !== 'local-file') return { text: segment.raw, type: 'text' };
    return {
      type: 'file',
      raw: segment.raw,
      ref: segment.label || basenameForPath(segment.target.path) || segment.target.path,
      label: segment.label,
      path: segment.target.path,
      entryKind: segment.target.entryKind,
    };
  });
}

export function splitChatSourceReferenceMarkers(text: string): ChatSourceReferenceTextSegment[] {
  return splitReferenceMarkers(text).map((segment): ChatSourceReferenceTextSegment => {
    if (segment.type === 'text') return segment;
    if (segment.target.kind !== 'chat-source') return { text: segment.raw, type: 'text' };
    const label = segment.label || chatSourceFallbackLabel(segment.target);
    return {
      type: 'chat',
      raw: segment.raw,
      ref: label,
      label: segment.label,
      target: segment.target,
    };
  });
}

export function rewriteFileReferenceMarkerPaths(text: string, paths: ReadonlyMap<string, string>): string {
  if (paths.size === 0) return text;
  return splitFileReferenceMarkers(text)
    .map((segment) => {
      if (segment.type === 'text') return segment.text;
      const nextPath = paths.get(segment.path);
      if (!nextPath || nextPath === segment.path) return segment.raw;
      return formatFileReferenceMarker(segment.label || segment.ref, nextPath, segment.entryKind);
    })
    .join('');
}

export function referenceMarkupToRichText(text: string): RichText {
  const markers = parseReferenceMarkers(text);
  if (markers.length === 0) return { text, marks: [], inlineRefs: [] };
  const inlineRefs: RichText['inlineRefs'] = [];
  let cursor = 0;
  let out = '';
  for (const marker of markers) {
    out += text.slice(cursor, marker.start);
    const displayName = marker.label || referenceDisplayFallback(marker.target);
    inlineRefs.push({
      offset: out.length,
      target: marker.target,
      ...(displayName ? { displayName } : {}),
    });
    cursor = marker.end;
  }
  out += text.slice(cursor);
  return { text: out, marks: [], inlineRefs };
}

export function richTextToReferenceMarkup(content: Pick<RichText, 'text' | 'inlineRefs'>): string {
  if (!content.inlineRefs.length) return content.text;
  const text = content.text;
  const refs = [...content.inlineRefs].sort((left, right) => left.offset - right.offset);
  let cursor = 0;
  let out = '';
  for (const ref of refs) {
    const offset = clampReferenceOffset(ref.offset, text.length);
    if (offset < cursor) continue;
    out += text.slice(cursor, offset);
    out += inlineRefMarker(ref);
    cursor = offset;
  }
  return out + text.slice(cursor);
}

export function nodeReferenceMarkersToText(text: string): string {
  return splitReferenceMarkers(text)
    .map((segment) => {
      if (segment.type === 'text') return segment.text;
      return segment.label;
    })
    .join('');
}

function inlineRefMarker(ref: RichText['inlineRefs'][number]): string {
  const displayName = ref.displayName?.trim();
  if (ref.target.kind === 'node') {
    return formatNodeReferenceMarker(displayName || ref.target.nodeId, ref.target.nodeId);
  }
  if (ref.target.kind === 'chat-source') {
    return formatChatSourceReferenceMarker(displayName || chatSourceFallbackLabel(ref.target), ref.target);
  }
  const path = ref.target.path;
  return formatFileReferenceMarker(displayName || basenameForPath(path) || path, path, ref.target.entryKind);
}

function clampReferenceOffset(offset: number, length: number): number {
  if (!Number.isFinite(offset)) return length;
  return Math.min(Math.max(0, Math.trunc(offset)), length);
}

function parseReferenceInner(inner: string): { label: string; target: ReferenceTarget } | null {
  const prefixEnd = inner.indexOf(':');
  if (prefixEnd <= 0) return null;
  const prefix = inner.slice(0, prefixEnd);
  if (prefix !== 'node' && prefix !== 'file' && prefix !== 'chat') return null;

  const body = inner.slice(prefixEnd + 1);
  const caret = body.indexOf('^');
  if (caret < 0) return null;
  const label = sanitizeReferenceLabel(body.slice(0, caret));
  let rawValue = body.slice(caret + 1);
  let entryKind: 'file' | 'directory' = 'file';
  if (prefix === 'chat') {
    const target = parseChatSourceReferenceValue(rawValue);
    return target ? { label, target } : null;
  }
  if (prefix === 'file') {
    const kindCaret = rawValue.lastIndexOf('^');
    if (kindCaret >= 0) {
      const rawEntryKind = rawValue.slice(kindCaret + 1);
      if (rawEntryKind === 'file' || rawEntryKind === 'directory') {
        entryKind = rawEntryKind;
        rawValue = rawValue.slice(0, kindCaret);
      }
    }
  }
  if (!rawValue) return null;
  const value = decodeReferenceValue(rawValue);
  if (!value) return null;
  if (prefix === 'node') return { label, target: { kind: 'node', nodeId: value } };
  return { label, target: { kind: 'local-file', path: value, entryKind } };
}

function parseChatSourceReferenceValue(rawValue: string): Extract<ReferenceTarget, { kind: 'chat-source' }> | null {
  const streamEnd = rawValue.indexOf(':');
  if (streamEnd <= 0) return null;
  const stream = rawValue.slice(0, streamEnd);
  if (stream !== 'conversation' && stream !== 'run') return null;
  const afterStream = rawValue.slice(streamEnd + 1);
  const at = afterStream.indexOf('@');
  if (at <= 0) return null;
  const rawStreamId = afterStream.slice(0, at);
  const rawRange = afterStream.slice(at + 1);
  const eventSeparator = rawRange.indexOf(':');
  const rawBounds = eventSeparator >= 0 ? rawRange.slice(0, eventSeparator) : rawRange;
  const rawEventId = eventSeparator >= 0 ? rawRange.slice(eventSeparator + 1) : '';
  const dash = rawBounds.indexOf('-');
  if (dash <= 0) return null;
  const fromSeqExclusive = parseNonNegativeInteger(rawBounds.slice(0, dash));
  const throughSeq = parseNonNegativeInteger(rawBounds.slice(dash + 1));
  if (fromSeqExclusive === null || throughSeq === null || throughSeq <= fromSeqExclusive) return null;
  const streamId = decodeReferenceValue(rawStreamId);
  if (!streamId) return null;
  const throughEventId = rawEventId ? decodeReferenceValue(rawEventId) : undefined;
  return {
    kind: 'chat-source',
    stream,
    streamId,
    range: {
      fromSeqExclusive,
      throughSeq,
      ...(throughEventId ? { throughEventId } : {}),
    },
  };
}

function parseNonNegativeInteger(value: string): number | null {
  if (!/^\d+$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function referenceDisplayFallback(target: ReferenceTarget): string {
  if (target.kind === 'node') return target.nodeId;
  if (target.kind === 'chat-source') return chatSourceFallbackLabel(target);
  return basenameForPath(target.path) || target.path;
}

function chatSourceFallbackLabel(target: Extract<ReferenceTarget, { kind: 'chat-source' }>): string {
  return `${target.stream}:${target.streamId}@${target.range.fromSeqExclusive}-${target.range.throughSeq}`;
}

function sanitizeReferenceLabel(label: string): string {
  return label
    .replace(/[\[\]\^\r\n]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function encodeReferenceValue(value: string): string {
  return encodeURIComponent(value);
}

function decodeReferenceValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function basenameForPath(path: string): string {
  const normalized = path.replace(/[/\\]+$/gu, '');
  return normalized.split(/[/\\]/u).pop() ?? '';
}
