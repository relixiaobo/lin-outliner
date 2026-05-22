import type { AgentPermissionMode } from '../core/types';
import { evaluateAgentToolPermission } from './agentPermissions';
import { runLocalBashCommand, type LocalBashRunResult } from './agentLocalTools';

export interface AgentSkillShellCommandInput {
  command: string;
  localRoot?: string;
  permissionMode?: AgentPermissionMode;
  allowedTools?: readonly string[];
  signal?: AbortSignal;
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
    },
  });
  if (!decision.allow) {
    throw new AgentSkillShellError(
      'permission_denied',
      `Shell command permission check failed: ${decision.reason ?? 'Permission denied.'}`,
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
