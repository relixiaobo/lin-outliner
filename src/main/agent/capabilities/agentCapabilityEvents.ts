import type { ToolCall } from '@earendil-works/pi-ai';
import type {
  AgentCapabilityDecision,
  AgentCapabilityUnavailableDecision,
} from './agentCapabilities';

export interface AgentToolCapabilityLogInput {
  requestId: string;
  toolCall: ToolCall;
  decision: AgentCapabilityDecision;
}

export function capabilityActionKinds(decision: AgentCapabilityDecision): string[] {
  return [...new Set(decision.descriptors.map((descriptor) => descriptor.actionKind))];
}

export function capabilityPrimaryActionKind(decision: AgentCapabilityDecision): string | undefined {
  return decision.descriptor?.actionKind ?? capabilityActionKinds(decision)[0];
}

export function unavailableToolResultMessage(input: {
  toolName: string;
  decision: AgentCapabilityUnavailableDecision;
}): string {
  return JSON.stringify({
    ok: false,
    tool: input.toolName,
    status: 'unavailable',
    error: {
      code: 'operation_unavailable',
      message: input.decision.reason,
      recoverable: false,
      details: { reason: input.decision.code },
    },
    instructions: 'This operation is unavailable in the current context. Continue with another available approach.',
  }, null, 2);
}
