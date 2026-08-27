import type { ProjectionResult } from '../contract/schemas';

export function formatOutlineExport(result: ProjectionResult): readonly unknown[] {
  const format = result.projection.format ?? 'json';
  if (format === 'json') return [result];
  if (format === 'jsonl') return result.nodes;
  if (format === 'markdown') return [formatMarkdown(result)];
  return [formatOpml(result)];
}

function formatMarkdown(result: ProjectionResult): string {
  const nodes = projectedNodes(result);
  const depths = nodeDepths(nodes);
  return `${nodes.map((node) => {
    const text = nodeText(node).replaceAll('\n', ' ');
    const description = typeof node.description === 'string' && node.description
      ? `\n${'  '.repeat((depths.get(node.id) ?? 0) + 1)}${node.description}`
      : '';
    return `${'  '.repeat(depths.get(node.id) ?? 0)}- ${text}${description}`;
  }).join('\n')}\n`;
}

function formatOpml(result: ProjectionResult): string {
  const nodes = projectedNodes(result);
  const byParent = new Map<string | null, Array<Record<string, unknown>>>();
  const included = new Set(nodes.map((node) => node.id));
  for (const node of nodes) {
    const parentId = typeof node.parentId === 'string' && included.has(node.parentId) ? node.parentId : null;
    const siblings = byParent.get(parentId) ?? [];
    siblings.push(node);
    byParent.set(parentId, siblings);
  }
  const render = (node: Record<string, unknown>, depth: number): string => {
    const children = byParent.get(String(node.id)) ?? [];
    const attributes = [
      `text="${escapeXml(nodeText(node))}"`,
      ...(typeof node.description === 'string' && node.description
        ? [`_note="${escapeXml(node.description)}"`]
        : []),
    ].join(' ');
    const indent = '  '.repeat(depth);
    if (children.length === 0) return `${indent}<outline ${attributes}/>`;
    return `${indent}<outline ${attributes}>\n${children.map((child) => render(child, depth + 1)).join('\n')}\n${indent}</outline>`;
  };
  const body = (byParent.get(null) ?? []).map((node) => render(node, 2)).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0">\n  <head><title>Tenon Outline Export</title></head>\n  <body>\n${body}\n  </body>\n</opml>\n`;
}

function projectedNodes(result: ProjectionResult): Array<Record<string, unknown> & { id: string }> {
  return result.nodes.filter((node): node is Record<string, unknown> & { id: string } => (
    isRecord(node) && typeof node.id === 'string'
  ));
}

function nodeDepths(nodes: readonly (Record<string, unknown> & { id: string })[]): Map<string, number> {
  const included = new Set(nodes.map((node) => node.id));
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const depths = new Map<string, number>();
  const depthOf = (node: Record<string, unknown> & { id: string }, seen = new Set<string>()): number => {
    const cached = depths.get(node.id);
    if (cached !== undefined) return cached;
    if (seen.has(node.id)) return 0;
    seen.add(node.id);
    const parentId = typeof node.parentId === 'string' ? node.parentId : undefined;
    const depth = parentId && included.has(parentId) ? depthOf(byId.get(parentId)!, seen) + 1 : 0;
    depths.set(node.id, depth);
    return depth;
  };
  for (const node of nodes) depthOf(node);
  return depths;
}

function nodeText(node: Record<string, unknown>): string {
  return isRecord(node.content) && typeof node.content.text === 'string'
    ? node.content.text
    : typeof node.text === 'string'
      ? node.text
      : '';
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
