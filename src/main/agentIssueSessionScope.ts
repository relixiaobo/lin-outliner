import type { AgentRunScope } from '../core/agentEventLog';
import type { AgentSession, IssueOutputPolicy } from '../core/agentIssue';

export function agentSessionRunScope(session: AgentSession): AgentRunScope {
  const resolvedInputNodeIds = session.inputSnapshot?.nodeIds ?? [];
  const readableInputNodeIds = uniqueStrings([
    ...resolvedInputNodeIds,
    ...(session.issueSnapshot.noteNodeIds ?? []),
  ]);
  const output = session.outputSnapshot ?? session.issueSnapshot.output;
  const nodes = uniqueStrings([
    ...readableInputNodeIds,
    ...issueOutputNodeIds(output, resolvedInputNodeIds),
  ]);
  const writableNodes = uniqueStrings(issueWritableNodeIds(output, resolvedInputNodeIds));
  const creatableNodeParents = uniqueStrings(issueCreatableNodeParentIds(output));
  // Agent Sessions are always resource-scoped. An explicitly empty node list is
  // deny-all, not the absence of a scope, so an input that resolves to zero
  // nodes cannot silently gain unrestricted outline access.
  return { resources: { nodes, writableNodes, creatableNodeParents } };
}

export function issueOutputNodeIds(
  output: IssueOutputPolicy | undefined,
  inputNodeIds: readonly string[],
): string[] {
  if (!output) return [];
  switch (output.type) {
    case 'activity-only':
    case 'daily-note':
      return [];
    case 'append-to-node':
    case 'create-child-under-node':
      return [output.nodeId];
    case 'per-input-child':
      return [output.parentNodeId, ...inputNodeIds];
    case 'replace-input':
      return output.requiresConfirmation ? [...inputNodeIds] : [];
  }
}

export function issueWritableNodeIds(
  output: IssueOutputPolicy | undefined,
  inputNodeIds: readonly string[],
): string[] {
  if (!output) return [];
  switch (output.type) {
    case 'activity-only':
    case 'daily-note':
    case 'append-to-node':
    case 'create-child-under-node':
    case 'per-input-child':
      return [];
    case 'replace-input':
      return output.requiresConfirmation ? [...inputNodeIds] : [];
  }
}

export function issueCreatableNodeParentIds(
  output: IssueOutputPolicy | undefined,
): string[] {
  if (!output) return [];
  switch (output.type) {
    case 'activity-only':
    case 'daily-note':
    case 'replace-input':
      return [];
    case 'append-to-node':
    case 'create-child-under-node':
      return [output.nodeId];
    case 'per-input-child':
      return [output.parentNodeId];
  }
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
