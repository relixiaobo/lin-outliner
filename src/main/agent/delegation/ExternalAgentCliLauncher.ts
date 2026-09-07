import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, resolve } from 'node:path';
import type { AgentReasoningLevel } from '../../../core/types';
import type { DelegateExecutionResult, DelegateUsage } from '../../../delegate/contract';
import type { DelegationRunnerAdapter } from './DelegationPolicyResolver';

const MAX_RESULT_TEXT_BYTES = 1024 * 1024;
const REASONING_LEVELS: readonly AgentReasoningLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const COMMON_EXTERNAL_CLI_ENV_KEYS = new Set([
  'COLORTERM',
  'HOME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'NO_COLOR',
  'PATH',
  'SHELL',
  'TEMP',
  'TERM',
  'TMP',
  'TMPDIR',
  'TZ',
  'USER',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
]);

export interface ExternalAgentCliDefinition {
  readonly id: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly environmentKeys?: readonly string[];
}

export const EXTERNAL_AGENT_CLI_DEFINITIONS: readonly ExternalAgentCliDefinition[] = Object.freeze([
  {
    id: 'codex',
    executable: 'codex',
    args: ['exec', '--json', '-'],
    environmentKeys: ['CODEX_HOME', 'OPENAI_API_KEY', 'OPENAI_BASE_URL'],
  },
  {
    id: 'claude',
    executable: 'claude',
    args: ['-p', '-'],
    environmentKeys: ['CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL'],
  },
  {
    id: 'openclaw',
    executable: 'openclaw',
    args: ['agent', '--local', '--json', '--message-file', '/dev/stdin'],
    environmentKeys: ['OPENCLAW_HOME', 'OPENCLAW_API_KEY'],
  },
]);

export function createExternalAgentCliLaunchers(
  env: NodeJS.ProcessEnv = process.env,
): readonly DelegationRunnerAdapter[] {
  return EXTERNAL_AGENT_CLI_DEFINITIONS.map((definition) => createExternalAgentCliLauncher(definition, env));
}

export function createExternalAgentCliLauncher(
  definition: ExternalAgentCliDefinition,
  env: NodeJS.ProcessEnv = process.env,
): DelegationRunnerAdapter {
  const childEnvironment = sanitizeExternalCliEnvironment(env, definition.environmentKeys);
  const executable = findExecutable(definition.executable, childEnvironment);
  const detected = executable !== null;
  return {
    id: definition.id,
    version: null,
    detected,
    ready: detected,
    diagnostic: detected ? null : `${definition.executable} CLI was not found on PATH.`,
    resolveExplicitModel: async () => null,
    resolveInheritedModel: async (parent, effort) => ({
      providerId: parent.providerId,
      modelId: parent.modelId,
      effort,
      supportedEfforts: REASONING_LEVELS,
    }),
    run: executable
      ? (input) => runExternalAgentCli(executable, definition, childEnvironment, input)
      : undefined,
  };
}

async function runExternalAgentCli(
  executable: string,
  definition: ExternalAgentCliDefinition,
  env: NodeJS.ProcessEnv,
  input: Parameters<NonNullable<DelegationRunnerAdapter['run']>>[0],
): Promise<DelegateExecutionResult> {
  const startedAt = Date.now();
  if (input.signal.aborted) return executionResult(input, startedAt, Date.now(), 'cancelled', null, 'Agent CLI execution was cancelled before start.', definition.id, null);
  const prompt = input.messages.length === 0
    ? input.prompt
    : input.messages.map((message) => message.text).filter((text): text is string => text !== null).join('\n\n');
  const processResult = await input.executeProcess({ executable, args: definition.args, env, stdin: prompt });
  const { truncated } = processResult;
  const boundedText = truncateUtf8WithMarker(processResult.stdout, MAX_RESULT_TEXT_BYTES);
  const text = boundedText.value;
  const errorText = truncateUtf8(processResult.stderr.trim(), 64 * 1024);
  const outcome = input.signal.aborted
    ? 'cancelled'
    : truncated
      ? 'failed'
      : processResult.outcome;
  return executionResult(
    input,
    startedAt,
    Date.now(),
    outcome,
    text || null,
    errorText || (truncated ? 'Agent CLI output exceeded the supported limit.' : processResult.error),
    definition.id,
    null,
    truncated || boundedText.truncated,
  );
}

function executionResult(
  input: Parameters<NonNullable<DelegationRunnerAdapter['run']>>[0],
  startedAt: number,
  endedAt: number,
  outcome: DelegateExecutionResult['outcome'],
  text: string | null,
  error: string | null,
  launcherId: string,
  version: string | null,
  partialEvidence = false,
): DelegateExecutionResult {
  return {
    version: 1,
    kind: 'delegate.execution-result',
    sessionId: input.session.sessionId,
    turnId: input.turnId,
    outcome,
    runner: { id: launcherId, version },
    model: input.session.policy.modelProvider && input.session.policy.modelId
      ? `${input.session.policy.modelProvider}/${input.session.policy.modelId}`
      : null,
    durationMs: Math.max(0, endedAt - startedAt),
    text,
    error: outcome === 'succeeded' ? null : error,
    partialEvidence: partialEvidence || (outcome !== 'succeeded' && text !== null),
    committedMessageSequence: input.messages.at(-1)?.sequence ?? input.session.messageSequence,
    continuation: 'available',
    usage: unknownUsage(),
    artifacts: [],
    worktree: { disposition: 'none' },
  };
}

function findExecutable(name: string, env: NodeJS.ProcessEnv): string | null {
  for (const directory of (env.PATH ?? '').split(delimiter)) {
    const candidate = resolve(directory || process.cwd(), name);
    try {
      if (statSync(candidate).isFile()) {
        accessSync(candidate, constants.X_OK);
        return candidate;
      }
    } catch {
      // Continue searching the remaining PATH entries.
    }
  }
  return null;
}

function sanitizeExternalCliEnvironment(source: NodeJS.ProcessEnv, providerKeys: readonly string[] = []): NodeJS.ProcessEnv {
  const allowed = new Set([...COMMON_EXTERNAL_CLI_ENV_KEYS, ...providerKeys.map((key) => key.toUpperCase())]);
  return Object.fromEntries(
    Object.entries(source).filter(([key, value]) => (
      value !== undefined && allowed.has(key.toUpperCase())
    )),
  );
}

function truncateUtf8WithMarker(value: string, maxBytes: number): { value: string; truncated: boolean } {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return { value, truncated: false };
  const marker = '\n[output truncated]';
  const markerBytes = Buffer.byteLength(marker, 'utf8');
  let end = Math.min(value.length, Math.max(0, maxBytes - markerBytes));
  while (end > 0 && Buffer.byteLength(value.slice(0, end), 'utf8') + markerBytes > maxBytes) end -= 1;
  return { value: `${value.slice(0, end)}${marker}`, truncated: true };
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  let end = Math.min(value.length, maxBytes);
  while (end > 0 && Buffer.byteLength(value.slice(0, end), 'utf8') > maxBytes) end -= 1;
  return value.slice(0, end);
}

function unknownUsage(): DelegateUsage {
  return { state: 'unknown' };
}
