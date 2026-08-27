import type { CoreTransactionNodePatch } from '../../core/core';
import type { Node, NodeProjection } from '../../core/types';
import { canonicalSha256 } from '../contract/canonical';

export function semanticNodeDigest(node: Node | NodeProjection | null): string | null {
  return node ? canonicalSha256(semanticNode(node)) : null;
}

export function semanticPatchDigest(nodes: readonly CoreTransactionNodePatch[]): string {
  return canonicalSha256(nodes.map((entry) => ({
    id: entry.id,
    beforeDigest: semanticNodeDigest(entry.before),
    afterDigest: semanticNodeDigest(entry.after),
  })));
}

export function semanticAffectedDigest(entries: readonly {
  readonly id: string;
  readonly beforeDigest: string | null;
  readonly afterDigest: string | null;
}[]): string {
  return canonicalSha256(entries.map(({ id, beforeDigest, afterDigest }) => ({ id, beforeDigest, afterDigest })));
}

function semanticNode(node: Node | NodeProjection): Record<string, unknown> {
  const value = JSON.parse(JSON.stringify(node)) as Record<string, unknown>;
  delete value.createdAt;
  delete value.updatedAt;
  delete value.trashedFromIndex;
  if (typeof value.completedAt === 'number' && value.completedAt > 0) value.completedAt = 1;
  return value;
}
