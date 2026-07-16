import type { ToolCall } from '@earendil-works/pi-ai';
import { randomUUID } from 'node:crypto';
import type { AgentPermissionMode } from '../core/types';
import {
  evaluateAgentToolPermission,
  type AgentPermissionFolderRequiredDecision,
  type GlobalToolPermissionConfig,
} from './agentPermissions';
import { createFolderCapabilitySnapshot } from './agentFolderCapabilities';
import { runLocalBashCommand, type LocalBashRunResult } from './agentLocalTools';
import {
  folderAccessRequiredToolResultMessage,
  permissionDeniedReasonForDecision,
  permissionDeniedToolResultMessage,
  permissionEventSourceForDeniedReason,
  permissionResolutionStatusForDeniedReason,
  permissionResolvedByForAllowDecision,
  permissionResolvedByForDeniedReason,
  type AgentPermissionDeniedReason,
  type AgentToolPermissionLogInput,
} from './agentPermissionEvents';

export interface AgentSkillShellApprovalInput {
  requestId: string;
  toolCall: ToolCall;
  args: { command: string };
  decision: AgentPermissionFolderRequiredDecision;
}

export interface AgentSkillShellApprovalResolution {
  approved: boolean;
  deniedReason?: AgentPermissionDeniedReason;
  folders?: string[];
}

export interface AgentSkillShellCommandInput {
  approvalHandler?: (input: AgentSkillShellApprovalInput, signal?: AbortSignal) => Promise<AgentSkillShellApprovalResolution>;
  command: string;
  localRoot?: string;
  scratchRoot?: string;
  protectedStoreRoot?: string;
  trustedReadRoots?: readonly string[];
  permissionMode?: AgentPermissionMode;
  allowedTools?: readonly string[];
  globalPermissions?: GlobalToolPermissionConfig;
  permissionEventHandler?: (input: AgentToolPermissionLogInput) => Promise<void> | void;
  signal?: AbortSignal;
  toolCallId?: string;
}

export class AgentSkillShellError extends Error {
  constructor(
    readonly code: 'permission_denied' | 'folder_access_required' | 'command_failed',
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
  const requestId = `permission-${randomUUID()}`;
  let globalPermissions = input.globalPermissions ?? await loadAgentToolPermissionConfig();
  const evaluate = () => evaluateAgentToolPermission({
    toolName: 'bash',
    args: { command: input.command },
    policy: {
      mode: input.permissionMode,
      workspaceRoot: input.localRoot,
      scratchRoot: input.scratchRoot,
      protectedStoreRoot: input.protectedStoreRoot,
      trustedReadRoots: input.trustedReadRoots,
      preapprovedToolRules: input.allowedTools ?? [],
      globalPermissions,
    },
  });
  let decision = evaluate();
  const append = (event: Omit<AgentToolPermissionLogInput, 'requestId' | 'toolCall' | 'decision'>) => (
    input.permissionEventHandler?.({ requestId, toolCall, decision, ...event })
  );

  if (decision.behavior === 'blocked') {
    const reason = permissionDeniedReasonForDecision(decision);
    await append({
      outcome: 'blocked',
      source: permissionEventSourceForDeniedReason(reason),
      resolved: {
        status: permissionResolutionStatusForDeniedReason(reason),
        resolvedBy: permissionResolvedByForDeniedReason(reason),
        deniedReason: reason,
      },
    });
    throw new AgentSkillShellError('permission_denied', permissionDeniedToolResultMessage({
      toolName: 'bash',
      reason,
      message: decision.reason,
    }));
  }

  if (decision.behavior === 'folder_required') {
    await append({ outcome: 'folder_required', unattended: !input.approvalHandler });
    if (!input.approvalHandler) {
      throw new AgentSkillShellError('folder_access_required', folderAccessRequiredToolResultMessage({
        toolName: 'bash',
        folders: decision.request.folders,
        unattended: true,
      }));
    }
    const approval = await input.approvalHandler({
      requestId,
      toolCall,
      args: { command: input.command },
      decision,
    }, input.signal);
    const deniedReason = approval.deniedReason ?? 'runtime';
    await append({
      outcome: approval.approved ? 'allow' : 'blocked',
      includeChecked: false,
      source: approval.approved ? 'user' : permissionEventSourceForDeniedReason(deniedReason),
      resolved: {
        status: approval.approved ? 'approved' : permissionResolutionStatusForDeniedReason(deniedReason),
        resolvedBy: approval.approved ? 'folder_grant' : permissionResolvedByForDeniedReason(deniedReason),
        updatedFolders: approval.folders,
        deniedReason: approval.approved ? undefined : deniedReason,
      },
    });
    if (!approval.approved) {
      throw new AgentSkillShellError('permission_denied', permissionDeniedToolResultMessage({
        toolName: 'bash',
        reason: deniedReason,
        message: deniedReason === 'user_cancelled'
          ? 'The folder request was cancelled.'
          : 'Folder access was not granted.',
      }));
    }
    globalPermissions = await loadAgentToolPermissionConfig();
    decision = evaluate();
    if (decision.behavior !== 'allow') {
      throw new AgentSkillShellError('folder_access_required', folderAccessRequiredToolResultMessage({
        toolName: 'bash',
        folders: decision.behavior === 'folder_required' ? decision.request.folders : approval.folders ?? [],
      }));
    }
  } else {
    await append({
      outcome: 'allow',
      resolved: { status: 'approved', resolvedBy: permissionResolvedByForAllowDecision(decision) },
    });
  }

  const capabilities = createFolderCapabilitySnapshot({
    workspaceRoot: input.localRoot ?? process.cwd(),
    scratchRoot: input.scratchRoot,
    activeSkillReadRoots: input.trustedReadRoots,
    includeSystemRoots: true,
    protectedRoots: input.protectedStoreRoot ? [input.protectedStoreRoot] : [],
  }, globalPermissions.folders);
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

async function loadAgentToolPermissionConfig(): Promise<GlobalToolPermissionConfig> {
  const { readAgentToolPermissionConfig } = await import('./agentToolPermissionStore');
  return readAgentToolPermissionConfig();
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
