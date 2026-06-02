import type { ReferenceTarget } from './types';

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

export type FileReferenceTextSegment =
  | { type: 'text'; text: string }
  | FileReferenceSegment;

const REFERENCE_PATTERN = /\[\[([^\]\r\n]*?)\]\]/gu;

export function formatNodeReferenceMarker(label: string, nodeId: string): string {
  const safeNodeId = nodeId.trim();
  return formatReferenceMarker(sanitizeReferenceLabel(label) || safeNodeId, { kind: 'node', nodeId: safeNodeId });
}

export function formatNodeReferenceIdMarker(nodeId: string): string {
  const safeNodeId = nodeId.trim();
  return formatReferenceMarker('', { kind: 'node', nodeId: safeNodeId });
}

export function formatFileReferenceMarker(label: string, path = label, entryKind: 'file' | 'directory' = 'file'): string {
  const safePath = path.trim() || 'attachment';
  return formatReferenceMarker(sanitizeReferenceLabel(label) || basenameForPath(safePath) || safePath, {
    kind: 'local-file',
    path: safePath,
    entryKind,
  });
}

export function sanitizeFileReferenceRef(ref: string): string {
  return sanitizeReferenceLabel(ref) || 'attachment';
}

export function formatReferenceMarker(label: string, target: ReferenceTarget): string {
  const safeLabel = sanitizeReferenceLabel(label);
  if (target.kind === 'node') {
    const nodeId = target.nodeId.trim();
    return `[[node:${safeLabel}^${encodeReferenceValue(nodeId)}]]`;
  }
  const path = target.path.trim();
  return `[[file:${safeLabel}^${encodeReferenceValue(path)}]]`;
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

export function nodeReferenceMarkersToText(text: string): string {
  return splitReferenceMarkers(text)
    .map((segment) => {
      if (segment.type === 'text') return segment.text;
      return segment.target.kind === 'node' ? segment.label : segment.raw;
    })
    .join('');
}

function parseReferenceInner(inner: string): { label: string; target: ReferenceTarget } | null {
  const prefixEnd = inner.indexOf(':');
  if (prefixEnd <= 0) return null;
  const prefix = inner.slice(0, prefixEnd);
  if (prefix !== 'node' && prefix !== 'file') return null;

  const body = inner.slice(prefixEnd + 1);
  const caret = body.indexOf('^');
  if (caret < 0) return null;
  const label = sanitizeReferenceLabel(body.slice(0, caret));
  const rawValue = body.slice(caret + 1);
  if (!rawValue) return null;
  const value = decodeReferenceValue(rawValue);
  if (!value) return null;
  if (prefix === 'node') return { label, target: { kind: 'node', nodeId: value } };
  return { label, target: { kind: 'local-file', path: value, entryKind: 'file' } };
}

function sanitizeReferenceLabel(label: string): string {
  return label
    .replace(/[\[\]\^\r\n]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function encodeReferenceValue(value: string): string {
  return encodeURIComponent(value.trim());
}

function decodeReferenceValue(value: string): string | null {
  try {
    return decodeURIComponent(value).trim() || null;
  } catch {
    return null;
  }
}

function basenameForPath(path: string): string {
  const normalized = path.replace(/[/\\]+$/gu, '');
  return normalized.split(/[/\\]/u).pop() ?? '';
}
