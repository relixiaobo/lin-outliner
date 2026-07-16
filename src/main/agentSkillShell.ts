import type { ToolCall } from '@earendil-works/pi-ai';
import { randomUUID } from 'node:crypto';
import {
  evaluateAgentToolCapability,
  type AgentCapabilityRequiredDecision,
  type AgentCapabilityConfig,
} from './agentCapabilities';
import { createFolderCapabilitySnapshot } from './agentFolderCapabilities';
import { runLocalBashCommand, type LocalBashRunResult } from './agentLocalTools';
import {
  capabilityEventSourceForReason,
  capabilityResolutionReasonForDecision,
  capabilityResolvedByForAllowDecision,
  capabilityResolvedByForReason,
  capabilityStatusForReason,
  folderCapabilityRequiredToolResultMessage,
  unavailableToolResultMessage,
  type AgentCapabilityResolutionReason,
  type AgentToolCapabilityLogInput,
} from './agentCapabilityEvents';

export interface AgentSkillShellCapabilityInput {
  requestId: string;
  toolCall: ToolCall;
  args: { command: string };
  decision: AgentCapabilityRequiredDecision;
}

export interface AgentSkillShellCapabilityResolution {
  status: 'granted' | 'cancelled';
  reason?: AgentCapabilityResolutionReason;
  folders?: string[];
}

export interface AgentSkillShellCommandInput {
  capabilityHandler?: (input: AgentSkillShellCapabilityInput, signal?: AbortSignal) => Promise<AgentSkillShellCapabilityResolution>;
  command: string;
  localRoot?: string;
  scratchRoot?: string;
  protectedStoreRoot?: string;
  trustedReadRoots?: readonly string[];
  capabilityConfig?: AgentCapabilityConfig;
  capabilityEventHandler?: (input: AgentToolCapabilityLogInput) => Promise<void> | void;
  signal?: AbortSignal;
  toolCallId?: string;
}

export class AgentSkillShellError extends Error {
  constructor(
    readonly code: 'operation_unavailable' | 'capability_cancelled' | 'folder_access_required' | 'command_failed',
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
  let capabilityConfig = input.capabilityConfig ?? await loadAgentCapabilityConfig();
  const evaluate = () => evaluateAgentToolCapability({
    toolName: 'bash',
    args: { command: input.command },
    policy: {
      workspaceRoot: input.localRoot,
      scratchRoot: input.scratchRoot,
      protectedStoreRoot: input.protectedStoreRoot,
      trustedReadRoots: input.trustedReadRoots,
      capabilityConfig,
    },
  });
  let decision = evaluate();
  const append = (event: Omit<AgentToolCapabilityLogInput, 'requestId' | 'toolCall' | 'decision'>) => (
    input.capabilityEventHandler?.({ requestId, toolCall, decision, ...event })
  );

  if (decision.behavior === 'unavailable') {
    const reason = capabilityResolutionReasonForDecision(decision);
    await append({
      outcome: 'unavailable',
      source: capabilityEventSourceForReason(reason),
      resolved: {
        status: capabilityStatusForReason(reason),
        resolvedBy: capabilityResolvedByForReason(reason),
        reason,
      },
    });
    throw new AgentSkillShellError('operation_unavailable', unavailableToolResultMessage({
      toolName: 'bash',
      reason,
      message: decision.reason,
    }));
  }

  if (decision.behavior === 'capability_required') {
    await append({ outcome: 'capability_required', unattended: !input.capabilityHandler });
    if (!input.capabilityHandler) {
      throw new AgentSkillShellError('folder_access_required', folderCapabilityRequiredToolResultMessage({
        toolName: 'bash',
        folders: decision.request.folders,
        unattended: true,
      }));
    }
    const resolution = await input.capabilityHandler({
      requestId,
      toolCall,
      args: { command: input.command },
      decision,
    }, input.signal);
    const reason = resolution.reason ?? (resolution.status === 'cancelled' ? 'user_cancelled' : undefined);
    await append({
      outcome: resolution.status === 'granted' ? 'allow' : 'unavailable',
      includeChecked: false,
      source: resolution.status === 'granted' ? 'user' : capabilityEventSourceForReason(reason ?? 'runtime'),
      resolved: {
        status: resolution.status === 'granted' ? 'available' : capabilityStatusForReason(reason ?? 'runtime'),
        resolvedBy: resolution.status === 'granted' ? 'folder_grant' : capabilityResolvedByForReason(reason ?? 'runtime'),
        updatedFolders: resolution.folders,
        reason,
      },
    });
    if (resolution.status !== 'granted') {
      throw new AgentSkillShellError('capability_cancelled', unavailableToolResultMessage({
        toolName: 'bash',
        reason: reason ?? 'runtime',
        message: reason === 'user_cancelled'
          ? 'The folder request was cancelled.'
          : 'Folder access was not granted.',
      }));
    }
    capabilityConfig = await loadAgentCapabilityConfig();
    decision = evaluate();
    if (decision.behavior !== 'allow') {
      throw new AgentSkillShellError('folder_access_required', folderCapabilityRequiredToolResultMessage({
        toolName: 'bash',
        folders: decision.behavior === 'capability_required' ? decision.request.folders : resolution.folders ?? [],
      }));
    }
  } else {
    await append({
      outcome: 'allow',
      resolved: { status: 'available', resolvedBy: capabilityResolvedByForAllowDecision(decision) },
    });
  }

  const capabilities = createFolderCapabilitySnapshot({
    workspaceRoot: input.localRoot ?? process.cwd(),
    scratchRoot: input.scratchRoot,
    activeSkillReadRoots: input.trustedReadRoots,
    includeSystemRoots: true,
    protectedRoots: input.protectedStoreRoot ? [input.protectedStoreRoot] : [],
    revocationGeneration: capabilityConfig.revocationGeneration ?? 0,
  }, capabilityConfig.folders);
  let result: LocalBashRunResult;
  try {
    result = await runLocalBashCommand({
      localRoot: input.localRoot,
      scratchRoot: input.scratchRoot,
      command: input.command,
      signal: input.signal,
      capabilities,
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
