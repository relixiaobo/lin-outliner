import type {
  AgentIssue,
  IssueInputScope,
  ResolvedIssueInput,
} from '../core/agentIssue';
import type { DocumentProjection, NodeProjection } from '../core/types';
import {
  indexProjection,
  isSystemNodeId,
  nodeTitle,
  normalChildIds,
  tagLabels,
  isInTrash,
} from './agentNodeToolProjection';

const PREVIEW_LIMIT = 8;

export function resolveIssueInputScopeFromProjection(
  scope: IssueInputScope,
  issue: AgentIssue,
  projection: DocumentProjection,
  now: number,
): ResolvedIssueInput {
  const nodeIds = resolveIssueInputNodeIdsFromProjection(scope, projection);

  return {
    scope,
    resolvedAt: now,
    nodeIds,
    preview: inputPreview(scope, issue, projection, nodeIds),
  };
}

export function resolveIssueInputNodeIdsFromProjection(
  scope: IssueInputScope,
  projection: DocumentProjection,
): string[] {
  const index = indexProjection(projection);
  return (() => {
    switch (scope.type) {
      case 'none':
        return [];
      case 'selected-nodes':
        return unique(scope.nodeIds).filter((nodeId) => activeNodeExists(index, nodeId));
      case 'node-children':
        return collectChildNodeIds(index, scope.nodeId, scope.depth);
      case 'tag-query':
        return collectTaggedNodeIds(index, scope.tag, scope.includeArchived === true);
      case 'saved-query':
        return [];
    }
  })();
}

function collectChildNodeIds(
  index: ReturnType<typeof indexProjection>,
  rootNodeId: string,
  depth: number | undefined,
): string[] {
  if (!activeNodeExists(index, rootNodeId)) return [];
  const maxDepth = depth ?? Number.POSITIVE_INFINITY;
  if (maxDepth <= 0) return [];
  const out: string[] = [];
  const queue = normalChildIds(index, rootNodeId, false).map((nodeId) => ({ nodeId, depth: 1 }));
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth > maxDepth) continue;
    out.push(current.nodeId);
    if (current.depth < maxDepth) {
      queue.push(...normalChildIds(index, current.nodeId, false).map((nodeId) => ({
        nodeId,
        depth: current.depth + 1,
      })));
    }
  }
  return unique(out);
}

function collectTaggedNodeIds(
  index: ReturnType<typeof indexProjection>,
  rawTag: string,
  includeArchived: boolean,
): string[] {
  const tagId = resolveTagId(index, rawTag);
  if (!tagId) return [];
  return index.projection.nodes
    .filter((node) => node.tags.includes(tagId))
    .filter((node) => !isSystemNodeId(node.id))
    .filter((node) => node.type !== 'tagDef')
    .filter((node) => includeArchived || !isInTrash(index, node.id))
    .map((node) => node.id);
}

function resolveTagId(index: ReturnType<typeof indexProjection>, rawTag: string): string | null {
  const tag = normalizeTag(rawTag);
  const direct = index.nodes.get(rawTag);
  if (direct?.type === 'tagDef' && !isInTrash(index, direct.id)) return direct.id;
  const byName = index.projection.nodes.find((node) => (
    node.type === 'tagDef'
    && !isInTrash(index, node.id)
    && normalizeTag(node.content.text) === tag
  ));
  return byName?.id ?? null;
}

function inputPreview(
  scope: IssueInputScope,
  issue: AgentIssue,
  projection: DocumentProjection,
  nodeIds: readonly string[],
): string {
  const index = indexProjection(projection);
  const titles = nodeIds
    .slice(0, PREVIEW_LIMIT)
    .map((nodeId) => index.nodes.get(nodeId))
    .filter((node): node is NodeProjection => Boolean(node))
    .map((node) => `${nodeTitle(index, node)} ${tagLabels(index, node).join(' ')}`.trim())
    .filter((title) => title.length > 0);
  const suffix = nodeIds.length > PREVIEW_LIMIT ? `, +${nodeIds.length - PREVIEW_LIMIT} more` : '';
  const sample = titles.length > 0 ? `: ${titles.join(', ')}${suffix}` : '.';
  if (scope.type === 'saved-query') {
    return `Issue "${issue.title}" uses saved query ${scope.queryId}. Resolve it with node_search before reading or writing nodes.`;
  }
  return `Issue "${issue.title}" resolved ${nodeIds.length} input node${nodeIds.length === 1 ? '' : 's'}${sample}`;
}

function activeNodeExists(index: ReturnType<typeof indexProjection>, nodeId: string): boolean {
  return index.nodes.has(nodeId) && !isInTrash(index, nodeId);
}

function normalizeTag(raw: string): string {
  return raw.trim().replace(/^#+/u, '').toLocaleLowerCase();
}

function unique(values: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}
