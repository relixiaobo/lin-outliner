import type {
  AgentSession,
  IssueInputScope,
  IssueOutputPolicy,
  ResolvedIssueInput,
  ValidationMessage,
} from '../core/agentIssue';
import type { DocumentProjection } from '../core/types';
import { indexProjection } from './agentNodeToolProjection';
import { resolveIssueInputNodeIdsFromProjection } from './agentIssueInputResolver';
import { agentSessionRunScope, issueOutputNodeIds, issueWritableNodeIds } from './agentIssueSessionScope';

export interface ChildIssueScopeDefinition {
  input?: IssueInputScope;
  resolvedInput?: ResolvedIssueInput;
  output?: IssueOutputPolicy;
  noteNodeIds?: string[];
}

export function validateChildIssueNodeScope(
  parentSession: AgentSession,
  definition: ChildIssueScopeDefinition,
  projection: DocumentProjection,
): ValidationMessage[] {
  const parentScope = agentSessionRunScope(parentSession).resources;
  const parentReadRoots = parentScope?.nodes ?? [];
  const parentWriteRoots = parentScope?.writableNodes ?? parentReadRoots;
  const resolvedInputNodeIds = definition.resolvedInput?.nodeIds
    ?? (definition.input ? resolveIssueInputNodeIdsFromProjection(definition.input, projection) : []);
  const declaredInputNodeIds = inputScopeAnchorNodeIds(definition.input);
  const requestedReadNodeIds = unique([
    ...(definition.noteNodeIds ?? []),
    ...declaredInputNodeIds,
    ...resolvedInputNodeIds,
    ...issueOutputNodeIds(definition.output, resolvedInputNodeIds),
  ]);
  const requestedWriteNodeIds = unique(issueWritableNodeIds(definition.output, resolvedInputNodeIds));
  const index = indexProjection(projection);
  const outsideRead = requestedReadNodeIds.filter((nodeId) => !nodeIsInsideRoots(index, nodeId, parentReadRoots));
  const outsideWrite = requestedWriteNodeIds.filter((nodeId) => !nodeIsInsideRoots(index, nodeId, parentWriteRoots));
  return [
    ...(outsideRead.length > 0 ? [{
        path: 'input',
        code: 'child_scope_broadened',
        message: `Child Issue readable node scope cannot exceed parent Agent Session resources: ${outsideRead.join(', ')}.`,
      }] : []),
    ...(outsideWrite.length > 0 ? [{
        path: 'output',
        code: 'child_scope_broadened',
        message: `Child Issue writable node scope cannot exceed parent Agent Session output resources: ${outsideWrite.join(', ')}.`,
      }] : []),
  ];
}

function inputScopeAnchorNodeIds(input: IssueInputScope | undefined): string[] {
  if (!input) return [];
  switch (input.type) {
    case 'selected-nodes':
      return input.nodeIds;
    case 'node-children':
      return [input.nodeId];
    case 'none':
    case 'tag-query':
    case 'saved-query':
      return [];
  }
}

function nodeIsInsideRoots(
  index: ReturnType<typeof indexProjection>,
  nodeId: string,
  roots: readonly string[],
): boolean {
  if (roots.includes(nodeId)) return true;
  let current = index.nodes.get(nodeId)?.parentId;
  const visited = new Set<string>();
  while (current && !visited.has(current)) {
    if (roots.includes(current)) return true;
    visited.add(current);
    current = index.nodes.get(current)?.parentId;
  }
  return false;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
