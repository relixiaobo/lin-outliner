import { richTextToReferenceMarkup } from '../core/referenceMarkup';
import type { NodeProjection } from '../core/types';

export function commandBriefText(
  node: NodeProjection,
  byId: ReadonlyMap<string, NodeProjection>,
): string {
  const title = richTextToReferenceMarkup(node.content).trim();
  const body = serializeCommandBody(node, byId, 0);
  return body ? `${title}\n${body}`.trimEnd() : title;
}

function serializeCommandBody(
  node: NodeProjection,
  byId: ReadonlyMap<string, NodeProjection>,
  depth: number,
): string {
  const lines: string[] = [];
  for (const childId of node.children) {
    const child = byId.get(childId);
    if (!child || child.type === 'fieldEntry') continue;
    const text = richTextToReferenceMarkup(child.content).trim();
    if (text) lines.push(`${'  '.repeat(depth)}- ${text}`);
    const nested = serializeCommandBody(child, byId, depth + 1);
    if (nested) lines.push(nested);
  }
  return lines.join('\n');
}
