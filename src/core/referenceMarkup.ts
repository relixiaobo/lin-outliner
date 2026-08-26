import {
  nodeIdFromPublicReferenceKey,
  publicReferenceNodeKey,
} from './nodeId';
import type { ReferenceTarget, RichText } from './types';

export type ReferenceUriScheme = 'file' | 'node';

export type ReferenceUri =
  | { readonly scheme: 'node'; readonly nodeId: string }
  | {
    readonly scheme: 'file';
    readonly path: string;
    readonly entryKind: 'file' | 'directory';
  };

export interface ParsedReferenceMarker {
  end: number;
  raw: string;
  start: number;
  target: ReferenceTarget;
  uri: string;
}

export type ReferenceTextSegment =
  | { text: string; type: 'text' }
  | {
    raw: string;
    target: ReferenceTarget;
    type: 'reference';
    uri: string;
  };

export interface ParsedNodeReferenceMarker {
  end: number;
  nodeId: string;
  raw: string;
  start: number;
  uri: string;
}

export interface ParseReferenceMarkerOptions {
  includeEscaped?: boolean;
}

export type NodeReferenceTextSegment =
  | { text: string; type: 'text' }
  | {
    nodeId: string;
    raw: string;
    type: 'nodeReference';
    uri: string;
  };

export interface FileReferenceSegment {
  type: 'file';
  raw: string;
  ref: string;
  path: string;
  entryKind: 'file' | 'directory';
  uri: string;
}

export type FileReferenceTextSegment =
  | { type: 'text'; text: string }
  | FileReferenceSegment;

const REFERENCE_PATTERN = /\[\[([^\[\]\r\n]*?)\]\]/gu;
const ALL_REFERENCE_SCHEMES: readonly ReferenceUriScheme[] = ['node', 'file'];
const ENCODED_PATH_SEPARATOR_PATTERN = /%2f/iu;

export function formatNodeReferenceUri(nodeId: string): string | null {
  const key = publicReferenceNodeKey(nodeId);
  return key ? `node://${key}` : null;
}

export function formatNodeReferenceMarker(nodeId: string): string {
  const uri = formatNodeReferenceUri(nodeId);
  return uri ? `[[${uri}]]` : nodeId.trim();
}

export function formatNamedNodeReference(nodeId: string, displayName?: string): string {
  const marker = formatNodeReferenceMarker(nodeId);
  if (!marker.startsWith('[[')) return marker;
  const display = singleLineDisplayName(displayName);
  return display && display !== nodeId ? `${display}: ${marker}` : marker;
}

export function formatFileReferenceUri(
  path: string,
  entryKind: 'file' | 'directory' = 'file',
): string | null {
  if (!isAbsolutePosixPath(path)) return null;
  const directory = entryKind === 'directory' || path.endsWith('/');
  const normalizedPath = directory && path !== '/' ? `${path.replace(/\/+$/u, '')}/` : path;
  const encodedPath = encodeFilePath(normalizedPath);
  return encodedPath === null ? null : `file://${encodedPath}`;
}

export function formatFileReferenceMarker(
  path: string,
  entryKind: 'file' | 'directory' = 'file',
): string {
  const uri = formatFileReferenceUri(path, entryKind);
  return uri ? `[[${uri}]]` : path;
}

export function formatNamedFileReference(
  path: string,
  entryKind: 'file' | 'directory' = 'file',
  displayName?: string,
): string {
  const marker = formatFileReferenceMarker(path, entryKind);
  if (!marker.startsWith('[[')) return marker;
  const display = singleLineDisplayName(displayName) || basenameForPath(path);
  return display && display !== path ? `${display}: ${marker}` : marker;
}

export function formatReferenceMarker(target: ReferenceTarget): string {
  if (target.kind === 'node') return formatNodeReferenceMarker(target.nodeId);
  return formatFileReferenceMarker(target.path, target.entryKind);
}

export function parseReferenceUri(
  value: string,
  admittedSchemes: readonly ReferenceUriScheme[] = ALL_REFERENCE_SCHEMES,
): ReferenceUri | null {
  const admitted = new Set(admittedSchemes);
  if (/^node:\/\//iu.test(value)) {
    if (!admitted.has('node')) return null;
    return parseNodeReferenceUri(value);
  }
  if (/^file:/iu.test(value)) {
    if (!admitted.has('file')) return null;
    return parseFileReferenceUri(value);
  }
  return null;
}

export function parseFileReferenceUri(
  value: string | undefined,
): Extract<ReferenceUri, { scheme: 'file' }> | null {
  if (!value || !/^file:\/\/\//iu.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.protocol !== 'file:'
    || url.host !== ''
    || url.username !== ''
    || url.password !== ''
    || url.search !== ''
    || url.hash !== ''
    || !url.pathname.startsWith('/')
    || ENCODED_PATH_SEPARATOR_PATTERN.test(url.pathname)
  ) return null;

  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  if (!isAbsolutePosixPath(decodedPath)) return null;
  const entryKind = decodedPath.endsWith('/') ? 'directory' : 'file';
  const path = entryKind === 'directory' && decodedPath !== '/'
    ? decodedPath.replace(/\/+$/u, '')
    : decodedPath;
  return { scheme: 'file', path, entryKind };
}

export function parseReferenceMarkers(
  text: string,
  admittedSchemes: readonly ReferenceUriScheme[] = ALL_REFERENCE_SCHEMES,
  options: ParseReferenceMarkerOptions = {},
): ParsedReferenceMarker[] {
  const markers: ParsedReferenceMarker[] = [];
  for (const match of text.matchAll(REFERENCE_PATTERN)) {
    const raw = match[0] ?? '';
    const inner = match[1] ?? '';
    const start = match.index ?? 0;
    if (!raw || (!options.includeEscaped && isEscapedAt(text, start))) continue;
    const parsed = parseReferenceUri(inner, admittedSchemes);
    if (!parsed) continue;
    const target = referenceTargetFromUri(parsed);
    const uri = formatReferenceUri(parsed);
    if (!uri) continue;
    markers.push({
      end: start + raw.length,
      raw,
      start,
      target,
      uri,
    });
  }
  return markers;
}

export function splitReferenceMarkers(
  text: string,
  admittedSchemes: readonly ReferenceUriScheme[] = ALL_REFERENCE_SCHEMES,
): ReferenceTextSegment[] {
  const markers = parseReferenceMarkers(text, admittedSchemes);
  if (markers.length === 0) return [{ text, type: 'text' }];

  const segments: ReferenceTextSegment[] = [];
  let cursor = 0;
  for (const marker of markers) {
    if (marker.start > cursor) {
      segments.push({ text: text.slice(cursor, marker.start), type: 'text' });
    }
    segments.push({
      raw: marker.raw,
      target: marker.target,
      type: 'reference',
      uri: marker.uri,
    });
    cursor = marker.end;
  }
  if (cursor < text.length) {
    segments.push({ text: text.slice(cursor), type: 'text' });
  }
  return segments;
}

export function parseNodeReferenceMarkers(text: string): ParsedNodeReferenceMarker[] {
  return parseReferenceMarkers(text, ['node'])
    .filter((marker): marker is ParsedReferenceMarker & { target: Extract<ReferenceTarget, { kind: 'node' }> } =>
      marker.target.kind === 'node')
    .map((marker) => ({
      end: marker.end,
      nodeId: marker.target.nodeId,
      raw: marker.raw,
      start: marker.start,
      uri: marker.uri,
    }));
}

export function splitNodeReferenceMarkers(text: string): NodeReferenceTextSegment[] {
  return splitReferenceMarkers(text, ['node']).map((segment): NodeReferenceTextSegment => {
    if (segment.type === 'text') return segment;
    return {
      nodeId: (segment.target as Extract<ReferenceTarget, { kind: 'node' }>).nodeId,
      raw: segment.raw,
      type: 'nodeReference',
      uri: segment.uri,
    };
  });
}

export function splitFileReferenceMarkers(text: string): FileReferenceTextSegment[] {
  return splitReferenceMarkers(text, ['file']).map((segment): FileReferenceTextSegment => {
    if (segment.type === 'text') return segment;
    const target = segment.target as Extract<ReferenceTarget, { kind: 'local-file' }>;
    return {
      type: 'file',
      raw: segment.raw,
      ref: basenameForPath(target.path) || target.path,
      path: target.path,
      entryKind: target.entryKind,
      uri: segment.uri,
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
      return formatFileReferenceMarker(nextPath, segment.entryKind);
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
    inlineRefs.push({
      offset: out.length,
      target: marker.target,
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
    out += formatReferenceMarker(ref.target);
    cursor = offset;
  }
  return out + text.slice(cursor);
}

export function nodeReferenceMarkersToText(text: string): string {
  return splitReferenceMarkers(text)
    .map((segment) => segment.type === 'text' ? segment.text : referenceDisplayFallback(segment.target))
    .join('');
}

export function referenceDisplayFallback(target: ReferenceTarget): string {
  if (target.kind === 'node') {
    const key = publicReferenceNodeKey(target.nodeId);
    return key && key.includes('-') ? key.slice(0, 8) : key ?? 'Referenced node';
  }
  return basenameForPath(target.path) || target.path;
}

function parseNodeReferenceUri(value: string): Extract<ReferenceUri, { scheme: 'node' }> | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.protocol !== 'node:'
    || url.username !== ''
    || url.password !== ''
    || url.port !== ''
    || url.pathname !== ''
    || url.search !== ''
    || url.hash !== ''
  ) return null;
  const nodeId = nodeIdFromPublicReferenceKey(url.host);
  return nodeId ? { scheme: 'node', nodeId } : null;
}

function referenceTargetFromUri(uri: ReferenceUri): ReferenceTarget {
  if (uri.scheme === 'node') return { kind: 'node', nodeId: uri.nodeId };
  return { kind: 'local-file', path: uri.path, entryKind: uri.entryKind };
}

function formatReferenceUri(uri: ReferenceUri): string | null {
  if (uri.scheme === 'node') return formatNodeReferenceUri(uri.nodeId);
  return formatFileReferenceUri(uri.path, uri.entryKind);
}

function clampReferenceOffset(offset: number, length: number): number {
  if (!Number.isFinite(offset)) return length;
  return Math.min(Math.max(0, Math.trunc(offset)), length);
}

function isEscapedAt(text: string, offset: number): boolean {
  let slashes = 0;
  for (let index = offset - 1; index >= 0 && text[index] === '\\'; index -= 1) slashes += 1;
  return slashes % 2 === 1;
}

function isAbsolutePosixPath(path: string): boolean {
  return path.startsWith('/') && !path.includes('\0') && !path.includes('\r') && !path.includes('\n');
}

function encodeFilePath(path: string): string | null {
  try {
    return path.split('/').map((part) => encodeURIComponent(part)).join('/');
  } catch {
    return null;
  }
}

function singleLineDisplayName(value: string | undefined): string {
  return value?.replace(/[\r\n]+/gu, ' ').replace(/\s+/gu, ' ').trim() ?? '';
}

export function basenameForPath(path: string): string {
  const normalized = path.replace(/[/\\]+$/gu, '');
  return normalized.split(/[/\\]/u).pop() ?? '';
}
