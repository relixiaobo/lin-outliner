import type { AgentRunScope } from '../core/agentEventLog';
import type { AgentSession, IssueOutputPolicy } from '../core/agentIssue';

export function agentSessionRunScope(session: AgentSession): AgentRunScope | undefined {
  const nodes = uniqueStrings([
    ...(session.inputSnapshot?.nodeIds ?? []),
    ...agentSessionOutputNodeIds(session.outputSnapshot ?? session.issueSnapshot.output, session.inputSnapshot?.nodeIds ?? []),
  ]);
  return nodes.length > 0 ? { resources: { nodes } } : undefined;
}

function agentSessionOutputNodeIds(
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

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
