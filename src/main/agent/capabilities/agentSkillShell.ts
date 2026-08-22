import type { ToolCall } from '../runtime/kernel/types';
import { randomUUID } from 'node:crypto';
import type { ThreadResourceReference } from '../../../core/agent/protocol';
import type { SkillDefinition } from '../../../core/types';
import type { SkillShellArtifactObservation } from './agentSkills';
import type { ToolArtifactSink } from '../runtime/ToolArtifactSink';
import {
  evaluateAgentToolCapability,
  type AgentCapabilityConfig,
} from './agentCapabilities';
import {
  subagentBashExecutionAllowed,
  type SubagentToolPolicy,
} from './subagentToolPolicy';
import {
  runLocalBashCommand,
  type AgentShellOutputRoot,
  type AgentShellProcessEnvironment,
  type AgentShellProcessEnvironmentProvider,
  type AgentWorkspaceWriteBoundary,
  type LocalBashRunResult,
} from './agentLocalTools';
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
  processEnvironment?: AgentShellProcessEnvironmentProvider;
  writeBoundary?: AgentWorkspaceWriteBoundary;
  subagentPolicy?: SubagentToolPolicy;
  skill?: Pick<SkillDefinition, 'name' | 'source'>;
  artifactSink?: ToolArtifactSink;
}

export interface AgentSkillShellCommandResult {
  readonly output: string;
  readonly persistedOutput: string;
  readonly resourceRefs: readonly ThreadResourceReference[];
  readonly artifacts: readonly SkillShellArtifactObservation[];
}

export class AgentSkillShellError extends Error {
  constructor(
    readonly code: 'operation_unavailable' | 'command_failed',
    message: string,
    readonly persistedMessage: string = message,
    readonly resourceRefs: readonly ThreadResourceReference[] = [],
    readonly artifacts: readonly SkillShellArtifactObservation[] = [],
  ) {
    super(message);
    this.name = 'AgentSkillShellError';
  }
}

export async function executeAgentSkillShellCommand(
  input: AgentSkillShellCommandInput,
): Promise<AgentSkillShellCommandResult> {
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
  const specializedBlocked = input.subagentPolicy !== undefined
    && !subagentBashExecutionAllowed(
      input.subagentPolicy,
      decision.descriptors.map((descriptor) => descriptor.actionKind),
    );

  if (specializedBlocked) {
    await append();
    const worktreeOutlineBlocked = input.subagentPolicy?.worktree
      && decision.descriptors.some((descriptor) => (
        descriptor.actionKind === 'outline.edit' || descriptor.actionKind === 'outline.delete'
      ));
    throw new AgentSkillShellError(
      'operation_unavailable',
      worktreeOutlineBlocked
        ? 'Worktree Agents cannot mutate the live outline through embedded Skill shell.'
        : 'Explore and Plan Agents may use embedded Skill shell only for repository inspection.',
    );
  }
  if (decision.behavior === 'unavailable') {
    await append();
    throw new AgentSkillShellError('operation_unavailable', unavailableToolResultMessage({
      toolName: 'bash',
      decision,
    }));
  }

  await append();

  const shellEnvironment = await resolveSkillShellEnvironment(input.processEnvironment, {
    toolCallId: toolCall.id,
    command: input.command,
  });
  const declaredRoots = input.skill?.source === 'managed'
    ? (shellEnvironment?.declaredOutputRoots ?? []).filter((root) => root.skillId === input.skill!.name)
    : [];
  const scopedShellEnvironment = shellEnvironment
    ? { ...shellEnvironment, declaredOutputRoots: declaredRoots }
    : undefined;

  let result: LocalBashRunResult;
  try {
    result = await runLocalBashCommand({
      localRoot: input.localRoot,
      scratchRoot: input.scratchRoot,
      command: input.command,
      signal: input.signal,
      toolCallId: toolCall.id,
      processEnvironment: scopedShellEnvironment ? async () => scopedShellEnvironment : undefined,
      writeBoundary: input.writeBoundary,
      artifactSink: input.artifactSink,
    });
  } catch (error) {
    throw new AgentSkillShellError('command_failed', errorMessage(error));
  }
  const artifacts = uniqueSkillArtifacts([
    ...(result.persistedOutput ? [{
      ref: result.persistedOutput.resourceRef,
      readablePath: result.persistedOutput.filePath ?? null,
      label: 'Shell saved output',
    }] : []),
    ...(result.artifacts ?? []),
  ]);
  const resourceRefs = uniqueResourceRefs([
    ...artifacts.map((artifact) => artifact.ref),
  ]);
  const output = formatSkillShellOutput(result, true, declaredRoots);
  const persistedOutput = formatSkillShellOutput(result, false, declaredRoots);
  if (result.isError) {
    throw new AgentSkillShellError(
      'command_failed',
      output || result.errorMessage || result.returnCodeInterpretation || 'Command failed.',
      persistedOutput || result.errorMessage || result.returnCodeInterpretation || 'Command failed.',
      resourceRefs,
      artifacts,
    );
  }
  return {
    output,
    persistedOutput,
    resourceRefs,
    artifacts,
  };
}

async function loadAgentCapabilityConfig(): Promise<AgentCapabilityConfig> {
  const { readAgentCapabilityConfig } = await import('./agentCapabilityStore');
  return readAgentCapabilityConfig();
}

function formatSkillShellOutput(
  result: Pick<LocalBashRunResult, 'stdout' | 'stderr' | 'persistedOutput' | 'artifacts' | 'artifactWarnings'>,
  includeReadablePaths = true,
  declaredRoots: readonly AgentShellOutputRoot[] = [],
): string {
  const parts: string[] = [];
  const stdout = stableSkillShellText(result.stdout, includeReadablePaths, declaredRoots).trim();
  const stderr = stableSkillShellText(result.stderr, includeReadablePaths, declaredRoots).trim();
  if (stdout) parts.push(stdout);
  if (stderr) parts.push(`[stderr]\n${stderr}`);
  if (result.persistedOutput) {
    parts.push([
      '[output saved]',
      `resource=${result.persistedOutput.resourceRef.id}, bytes=${result.persistedOutput.byteLength}`,
      ...(includeReadablePaths && result.persistedOutput.filePath
        ? [`Current readable path: ${result.persistedOutput.filePath}. Use file_read if more detail is needed.`]
        : includeReadablePaths ? ['No readable path is currently available.'] : []),
    ].join('\n'));
  }
  if (result.artifacts?.length) parts.push([
    '[produced artifacts]',
    ...result.artifacts.flatMap((artifact) => [
      `- ${artifact.label}: resource=${artifact.ref.id}, bytes=${artifact.ref.byteLength}`,
      includeReadablePaths && artifact.readablePath
        ? `  Current readable path: ${artifact.readablePath}`
        : includeReadablePaths ? '  No readable path is currently available.' : '',
    ]),
  ].filter(Boolean).join('\n'));
  const warnings = (result.artifactWarnings ?? []).map((warning) => (
    stableSkillShellText(warning, includeReadablePaths, declaredRoots)
  ));
  if (warnings.length > 0) parts.push(`[artifact warnings]\n${warnings.map((warning) => `- ${warning}`).join('\n')}`);
  return parts.join('\n');
}

async function resolveSkillShellEnvironment(
  provider: AgentShellProcessEnvironmentProvider | undefined,
  context: { readonly toolCallId: string; readonly command: string },
): Promise<AgentShellProcessEnvironment | undefined> {
  if (!provider) return undefined;
  try {
    return await provider(context);
  } catch (error) {
    console.warn('[agent] managed Skill shell environment failed; continuing without it', error);
    return undefined;
  }
}

function stableSkillShellText(
  text: string,
  includeReadablePaths: boolean,
  declaredRoots: readonly AgentShellOutputRoot[],
): string {
  if (includeReadablePaths) return text;
  return declaredRoots.reduce((result, root) => (
    result.replaceAll(root.path, `[managed-output:${root.id}]`)
  ), text);
}

function uniqueResourceRefs(refs: readonly ThreadResourceReference[]): ThreadResourceReference[] {
  return [...new Map(refs.map((ref) => [`${ref.id}\0${ref.fileName}`, ref])).values()];
}

function uniqueSkillArtifacts(
  artifacts: readonly SkillShellArtifactObservation[],
): SkillShellArtifactObservation[] {
  return [...new Map(artifacts.map((artifact) => [
    `${artifact.ref.id}\0${artifact.ref.fileName}\0${artifact.label}`,
    artifact,
  ])).values()];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
