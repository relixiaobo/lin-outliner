import type { ToolCall } from '@earendil-works/pi-ai';
import { randomUUID } from 'node:crypto';
import {
  evaluateAgentToolCapability,
  type AgentCapabilityConfig,
} from './agentCapabilities';
import { runLocalBashCommand, type LocalBashRunResult } from './agentLocalTools';
import {
  unavailableToolResultMessage,
  type AgentToolCapabilityLogInput,
} from './agentCapabilityEvents';

export interface AgentSkillShellCommandInput {
  command: string;
  localRoot?: string;
  scratchRoot?: string;
  capabilityConfig?: AgentCapabilityConfig;
  capabilityEventHandler?: (input: AgentToolCapabilityLogInput) => Promise<void> | void;
  signal?: AbortSignal;
  toolCallId?: string;
}

export class AgentSkillShellError extends Error {
  constructor(
    readonly code: 'operation_unavailable' | 'command_failed',
    message: string,
  ) {
    super(message);
    this.name = 'AgentSkillShellError';
  }
}

export async function executeAgentSkillShellCommand(input: AgentSkillShellCommandInput): Promise<string> {
  const toolCall: ToolCall = {
    type: 'toolCall',
    id: input.toolCallId ?? `skill-shell-${randomUUID()}`,
    name: 'bash',
    arguments: { command: input.command },
  };
  const requestId = `capability-${randomUUID()}`;
  const capabilityConfig = input.capabilityConfig ?? await loadAgentCapabilityConfig();
  const decision = evaluateAgentToolCapability({
    toolName: 'bash',
    args: { command: input.command },
    policy: {
      workspaceRoot: input.localRoot,
      capabilityConfig,
    },
  });
  const append = () => input.capabilityEventHandler?.({ requestId, toolCall, decision });

  if (decision.behavior === 'unavailable') {
    await append();
    throw new AgentSkillShellError('operation_unavailable', unavailableToolResultMessage({
      toolName: 'bash',
      decision,
    }));
  }

  await append();

  let result: LocalBashRunResult;
  try {
    result = await runLocalBashCommand({
      localRoot: input.localRoot,
      scratchRoot: input.scratchRoot,
      command: input.command,
      signal: input.signal,
    });
  } catch (error) {
    throw new AgentSkillShellError('command_failed', errorMessage(error));
  }
  if (result.isError) {
    const output = formatSkillShellOutput(result);
    throw new AgentSkillShellError('command_failed', output || result.errorMessage || result.returnCodeInterpretation || 'Command failed.');
  }
  return formatSkillShellOutput(result);
}

async function loadAgentCapabilityConfig(): Promise<AgentCapabilityConfig> {
  const { readAgentCapabilityConfig } = await import('./agentCapabilityStore');
  return readAgentCapabilityConfig();
}

function formatSkillShellOutput(result: Pick<LocalBashRunResult, 'stdout' | 'stderr' | 'persistedOutputPath'>): string {
  const parts: string[] = [];
  if (result.stdout.trim()) parts.push(result.stdout.trim());
  if (result.stderr.trim()) parts.push(`[stderr]\n${result.stderr.trim()}`);
  if (result.persistedOutputPath) {
    parts.push(`[output saved]\nFull output was saved to ${result.persistedOutputPath}. Use file_read if more detail is needed.`);
  }
  return parts.join('\n');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
