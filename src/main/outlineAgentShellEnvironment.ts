import type { AgentMutationCausation } from '../core/agent/protocol';
import { issueOutlineAgentAttestation, OUTLINE_AGENT_ATTESTATION_ENV } from '../outline/contract/agentAttestation';
import type { OutlineClientSupervisor } from '../outline/client';
import type { AgentShellProcessEnvironmentProvider } from './agent/capabilities/agentLocalTools';

export interface OutlineAgentShellEnvironmentOptions {
  readonly threadId: AgentMutationCausation['threadId'];
  readonly turnId: AgentMutationCausation['turnId'];
  readonly runtimeRoot: string;
  readonly supervisor: OutlineClientSupervisor;
  readonly baseEnvironment: AgentShellProcessEnvironmentProvider;
  readonly leadingToolPathSegments?: readonly string[];
}

export function createOutlineAgentShellEnvironmentProvider(
  options: OutlineAgentShellEnvironmentOptions,
): AgentShellProcessEnvironmentProvider {
  return async (shell) => {
    const base = await options.baseEnvironment(shell);
    const leadingToolPathSegments = [
      ...(options.leadingToolPathSegments ?? []),
      ...(base.leadingToolPathSegments ?? []),
    ];
    if (!shell.toolCallId) {
      return {
        ...base,
        ...(leadingToolPathSegments.length > 0 ? { leadingToolPathSegments } : {}),
      };
    }
    const client = await options.supervisor.connect();
    try {
      return {
        ...base,
        env: {
          ...base.env,
          TENON_OUTLINE_RUNTIME_ROOT: options.runtimeRoot,
          [OUTLINE_AGENT_ATTESTATION_ENV]: issueOutlineAgentAttestation({
            descriptor: client.descriptor,
            runtimeRoot: options.runtimeRoot,
            causation: {
              threadId: options.threadId,
              turnId: options.turnId,
              itemId: shell.toolCallId,
            },
          }),
        },
        ...(leadingToolPathSegments.length > 0 ? { leadingToolPathSegments } : {}),
      };
    } finally {
      client.close();
    }
  };
}
