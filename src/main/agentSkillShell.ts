import type { ToolCall } from '@earendil-works/pi-ai';
import type { AgentPermissionMode } from '../core/types';
import type { AgentApprovalResolutionScope } from '../core/agentTypes';
import { evaluateAgentToolPermission, type AgentPermissionAskDecision, type GlobalToolPermissionConfig } from './agentPermissions';
import { resolveAgentPermissionAsk } from './agentPermissionAskResolver';
import { runLocalBashCommand, type LocalBashRunResult } from './agentLocalTools';

export interface AgentSkillShellApprovalInput {
  toolCall: ToolCall;
  args: { command: string };
  decision: AgentPermissionAskDecision;
}

export interface AgentSkillShellApprovalResolution {
  approved: boolean;
  deniedBy?: 'abort' | 'runtime' | 'user';
  scope?: AgentApprovalResolutionScope;
  conversationRule?: string;
}

export interface AgentSkillShellCommandInput {
  approvalHandler?: (input: AgentSkillShellApprovalInput, signal?: AbortSignal) => Promise<AgentSkillShellApprovalResolution>;
  command: string;
  localRoot?: string;
  permissionMode?: AgentPermissionMode;
  allowedTools?: readonly string[];
  conversationAllowRules?: readonly string[];
  globalPermissions?: GlobalToolPermissionConfig;
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
  const decision = evaluateAgentToolPermission({
    toolName: 'bash',
    args: { command: input.command },
    policy: {
      mode: input.permissionMode,
      workspaceRoot: input.localRoot,
      preapprovedToolRules: input.allowedTools ?? [],
      conversationAllowRules: input.conversationAllowRules ?? [],
      globalPermissions: input.globalPermissions,
    },
  });
  if (decision.behavior === 'ask') {
    // Route through the same ask resolver as the main runtime so the
    // safe-allowlist, classifier-eligibility veto, and — critically — the
    // unattended fail-safe (no approval channel ⇒ deny) apply consistently here.
    const resolution = await resolveAgentPermissionAsk({
      decision,
      interactionAvailable: Boolean(input.approvalHandler),
      signal: input.signal,
    });
    if (resolution.outcome === 'block') {
      throw new AgentSkillShellError('permission_denied', `Shell command was not run: ${resolution.message}`);
    }
    if (resolution.outcome === 'needs_user') {
      if (!input.approvalHandler) {
        throw new AgentSkillShellError(
          'permission_denied',
          'Shell command was not run because no approval channel is available.',
        );
      }
      const approval = await input.approvalHandler({
        toolCall: {
          type: 'toolCall',
          id: input.toolCallId ?? 'skill-shell-bash',
          name: 'bash',
          arguments: { command: input.command },
        },
        args: { command: input.command },
        decision,
      }, input.signal);
      if (!approval.approved) {
        throw new AgentSkillShellError('permission_denied', skillShellApprovalDeniedMessage(approval));
      }
    }
    // resolution.outcome === 'allow' ⇒ safe-allowlist/classifier cleared it; run.
  } else if (decision.behavior !== 'allow') {
    throw new AgentSkillShellError(
      'permission_denied',
      `Shell command was not run: ${decision.reason ?? 'permission was denied.'}`,
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

function skillShellApprovalDeniedMessage(approval: AgentSkillShellApprovalResolution): string {
  if (approval.deniedBy === 'abort') return 'Shell command was not run because the request was cancelled.';
  if (approval.deniedBy === 'runtime') return 'Shell command was not run because the runtime stopped before approval.';
  return 'Shell command was not run because the user denied permission.';
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
