import type { AgentMutationCausation } from '../core/agent/protocol';
import type {
  AgentShellProcessEnvironmentProvider,
} from './agent/capabilities/agentLocalTools';
import {
  isTenonImportCommitCommand,
  TENON_IMPORT_CAUSATION_TOKEN_ENV,
} from './tenonImportProtocol';

export interface TenonImportShellEnvironmentOptions {
  readonly threadId: AgentMutationCausation['threadId'];
  readonly turnId: AgentMutationCausation['turnId'];
  readonly baseEnvironment: AgentShellProcessEnvironmentProvider;
  readonly issueCausationToken: (causation: AgentMutationCausation) => string;
}

export function createTenonImportShellEnvironmentProvider(
  options: TenonImportShellEnvironmentOptions,
): AgentShellProcessEnvironmentProvider {
  return async (shell) => {
    const base = await options.baseEnvironment(shell);
    if (!shell.toolCallId || !isTenonImportCommitCommand(shell.command)) return base;
    const causationToken = options.issueCausationToken({
      threadId: options.threadId,
      turnId: options.turnId,
      itemId: shell.toolCallId,
    });
    return {
      ...base,
      env: {
        ...base.env,
        [TENON_IMPORT_CAUSATION_TOKEN_ENV]: causationToken,
      },
    };
  };
}
