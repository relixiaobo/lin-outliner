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

const NODE_REFERENCE_PATTERN = /\[\[([^\]\^\n\r]*?)\^([^\]\^\s]+?)\]\]/gu;

export function formatNodeReferenceMarker(label: string, nodeId: string): string {
  const safeNodeId = nodeId.trim();
  const safeLabel = label
    .replace(/[\[\]\^\r\n]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  return `[[${safeLabel || safeNodeId}^${safeNodeId}]]`;
}

export function formatNodeReferenceIdMarker(nodeId: string): string {
  return `[[^${nodeId.trim()}]]`;
}

export function parseNodeReferenceMarkers(text: string): ParsedNodeReferenceMarker[] {
  const markers: ParsedNodeReferenceMarker[] = [];
  for (const match of text.matchAll(NODE_REFERENCE_PATTERN)) {
    const raw = match[0] ?? '';
    const label = match[1]?.trim() ?? '';
    const nodeId = match[2]?.trim() ?? '';
    const start = match.index ?? 0;
    if (!raw || !nodeId) continue;
    markers.push({
      end: start + raw.length,
      label,
      nodeId,
      raw,
      start,
    });
  }
  return markers;
}

export function splitNodeReferenceMarkers(text: string): NodeReferenceTextSegment[] {
  const markers = parseNodeReferenceMarkers(text);
  if (markers.length === 0) return [{ text, type: 'text' }];

  const segments: NodeReferenceTextSegment[] = [];
  let cursor = 0;
  for (const marker of markers) {
    if (marker.start > cursor) {
      segments.push({ text: text.slice(cursor, marker.start), type: 'text' });
    }
    segments.push({
      label: marker.label,
      nodeId: marker.nodeId,
      raw: marker.raw,
      type: 'nodeReference',
    });
    cursor = marker.end;
  }
  if (cursor < text.length) {
    segments.push({ text: text.slice(cursor), type: 'text' });
  }
  return segments;
}

export function nodeReferenceMarkersToText(text: string): string {
  return splitNodeReferenceMarkers(text)
    .map((segment) => (segment.type === 'text' ? segment.text : segment.label))
    .join('');
}
