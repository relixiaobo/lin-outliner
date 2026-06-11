import type { ToolCall } from '@earendil-works/pi-ai';
import { randomUUID } from 'node:crypto';
import type { AgentPermissionMode, AgentSafetyMode } from '../core/types';
import type { AgentApprovalResolutionScope } from '../core/agentTypes';
import {
  evaluateAgentToolPermission,
  type AgentPermissionAskDecision,
  type AgentPermissionDenyDecision,
  type GlobalToolPermissionConfig,
} from './agentPermissions';
import { resolveAgentPermissionAsk, type PermissionDeniedReason } from './agentPermissionAskResolver';
import { runLocalBashCommand, type LocalBashRunResult } from './agentLocalTools';
import {
  permissionDeniedReasonForDecision,
  permissionDeniedToolResultMessage,
  permissionEventSourceForDeniedReason,
  permissionResolutionStatusForDeniedReason,
  permissionResolvedByForAllowDecision,
  permissionResolvedByForDeniedReason,
  type AgentToolPermissionLogInput,
} from './agentPermissionEvents';

export interface AgentSkillShellApprovalInput {
  requestId: string;
  toolCall: ToolCall;
  args: { command: string };
  decision: AgentPermissionAskDecision;
}

export interface AgentSkillShellPermissionNoticeInput {
  requestId: string;
  toolCall: ToolCall;
  args: { command: string };
  decision: AgentPermissionDenyDecision;
}

export interface AgentSkillShellApprovalResolution {
  approved: boolean;
  deniedReason?: PermissionDeniedReason;
  scope?: AgentApprovalResolutionScope;
  alwaysAllowRule?: string;
}

export interface AgentSkillShellCommandInput {
  approvalHandler?: (input: AgentSkillShellApprovalInput, signal?: AbortSignal) => Promise<AgentSkillShellApprovalResolution>;
  command: string;
  localRoot?: string;
  permissionMode?: AgentPermissionMode;
  safetyMode?: AgentSafetyMode;
  allowedTools?: readonly string[];
  globalPermissions?: GlobalToolPermissionConfig;
  permissionEventHandler?: (input: AgentToolPermissionLogInput) => Promise<void> | void;
  permissionNoticeHandler?: (input: AgentSkillShellPermissionNoticeInput, signal?: AbortSignal) => Promise<void> | void;
  signal?: AbortSignal;
  toolCallId?: string;
}

export class AgentSkillShellError extends Error {
  constructor(
    readonly code: 'permission_denied' | 'command_failed',
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
  const permissionRequestId = `permission-${randomUUID()}`;
  const decision = evaluateAgentToolPermission({
    toolName: 'bash',
    args: { command: input.command },
    policy: {
      mode: input.permissionMode,
      safetyMode: input.safetyMode,
      workspaceRoot: input.localRoot,
      preapprovedToolRules: input.allowedTools ?? [],
      globalPermissions: input.globalPermissions,
    },
  });
  const appendPermissionEvent = (event: Omit<AgentToolPermissionLogInput, 'requestId' | 'toolCall' | 'decision'>) => (
    input.permissionEventHandler?.({
      requestId: permissionRequestId,
      toolCall,
      decision,
      ...event,
    })
  );
  const appendDeniedPermissionEvent = (reason: PermissionDeniedReason, includeChecked?: false) => appendPermissionEvent({
    outcome: 'blocked',
    includeChecked,
    source: permissionEventSourceForDeniedReason(reason),
    resolved: {
      status: permissionResolutionStatusForDeniedReason(reason),
      resolvedBy: permissionResolvedByForDeniedReason(reason),
      deniedReason: reason,
    },
  });
  if (decision.behavior === 'allow') {
    await appendPermissionEvent({
      outcome: 'allow',
      resolved: {
        status: 'approved',
        resolvedBy: permissionResolvedByForAllowDecision(decision),
      },
    });
  }
  if (decision.behavior === 'ask') {
    await appendPermissionEvent({ outcome: 'ask' });
    // Route through the same ask resolver as the main runtime so the
    // safe-allowlist, classifier-eligibility veto, and — critically — the
    // unattended fail-safe (no approval channel ⇒ deny) apply consistently here.
    const resolution = await resolveAgentPermissionAsk({
      decision,
      interactionAvailable: Boolean(input.approvalHandler),
      signal: input.signal,
    });
    if (resolution.outcome === 'block') {
      await appendDeniedPermissionEvent(resolution.reason, false);
      throw new AgentSkillShellError('permission_denied', permissionDeniedToolResultMessage({
        toolName: 'bash',
        reason: resolution.reason,
        message: resolution.message,
      }));
    }
    if (resolution.outcome === 'allow') {
      await appendPermissionEvent({
        outcome: 'allow',
        includeChecked: false,
        source: resolution.source,
        resolved: {
          status: 'approved',
          resolvedBy: resolution.source,
        },
      });
    }
    if (resolution.outcome === 'needs_user') {
      if (!input.approvalHandler) {
        await appendDeniedPermissionEvent('runtime', false);
        throw new AgentSkillShellError(
          'permission_denied',
          permissionDeniedToolResultMessage({
            toolName: 'bash',
            reason: 'runtime',
            message: 'Shell command was not run because no approval channel is available.',
          }),
        );
      }
      const approval = await input.approvalHandler({
        requestId: permissionRequestId,
        toolCall,
        args: { command: input.command },
        decision,
      }, input.signal);
      const deniedReason = approval.deniedReason ?? 'runtime';
      await appendPermissionEvent({
        outcome: approval.approved ? 'allow' : 'blocked',
        includeChecked: false,
        source: approval.approved ? 'user' : permissionEventSourceForDeniedReason(deniedReason),
        resolved: {
          status: approval.approved ? 'approved' : permissionResolutionStatusForDeniedReason(deniedReason),
          resolvedBy: approval.approved
            ? approval.scope === 'always' ? 'allow_rule_update' : 'user_once'
            : permissionResolvedByForDeniedReason(deniedReason),
          updatedRule: approval.alwaysAllowRule,
          deniedReason: approval.approved ? undefined : deniedReason,
        },
      });
      if (!approval.approved) {
        throw new AgentSkillShellError('permission_denied', permissionDeniedToolResultMessage({
          toolName: 'bash',
          reason: deniedReason,
          message: skillShellApprovalDeniedMessage(deniedReason),
        }));
      }
    }
    // resolution.outcome === 'allow' ⇒ safe-allowlist/classifier cleared it; run.
  } else if (decision.behavior !== 'allow') {
    const reason = permissionDeniedReasonForDecision(decision);
    await appendDeniedPermissionEvent(reason);
    await input.permissionNoticeHandler?.({
      requestId: permissionRequestId,
      toolCall,
      args: { command: input.command },
      decision,
    }, input.signal);
    throw new AgentSkillShellError(
      'permission_denied',
      permissionDeniedToolResultMessage({
        toolName: 'bash',
        reason,
        message: decision.reason ?? 'permission was denied.',
      }),
    );
  }

  let result: LocalBashRunResult;
  try {
    result = await runLocalBashCommand({
      localRoot: input.localRoot,
      command: input.command,
      signal: input.signal,
    });
  } catch (error) {
    throw new AgentSkillShellError('command_failed', errorMessage(error));
  }

  if (result.isError) {
    const output = formatSkillShellOutput(result);
    const reason = output || result.errorMessage || result.returnCodeInterpretation || 'Command failed.';
    throw new AgentSkillShellError('command_failed', reason);
  }

  return formatSkillShellOutput(result);
}

function skillShellApprovalDeniedMessage(reason: PermissionDeniedReason): string {
  if (reason === 'run_aborted') return 'Shell command was not run because the request was cancelled.';
  if (reason === 'runtime') return 'Shell command was not run because the runtime stopped before approval.';
  if (reason === 'user_denied') return 'Shell command was not run because the user denied permission.';
  return 'Shell command was not run because permission was denied.';
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
