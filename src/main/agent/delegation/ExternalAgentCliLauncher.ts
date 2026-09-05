import { spawnSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import type { AgentReasoningLevel } from '../../../core/types';
import type { DelegateExecutionResult, DelegateUsage } from '../../../delegate/contract';
import type { DelegationRunnerAdapter } from './DelegationPolicyResolver';

const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_RESULT_TEXT_BYTES = 1024 * 1024;
const REASONING_LEVELS: readonly AgentReasoningLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const EXTERNAL_CLI_ENV_KEYS = new Set([
  'COLORTERM',
  'CODEX_HOME',
  'CLAUDE_CONFIG_DIR',
  'HOME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'NO_COLOR',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'OPENCLAW_HOME',
  'OPENCLAW_API_KEY',
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
}

export const EXTERNAL_AGENT_CLI_DEFINITIONS: readonly ExternalAgentCliDefinition[] = Object.freeze([
  { id: 'codex', executable: 'codex', args: ['exec', '--json', '-'] },
  { id: 'claude', executable: 'claude', args: ['-p', '-'] },
  { id: 'openclaw', executable: 'openclaw', args: ['run', '-'] },
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
  const childEnvironment = sanitizeExternalCliEnvironment(env);
  const executable = findExecutable(definition.executable, childEnvironment);
  const version = executable ? probeVersion(executable, childEnvironment) : null;
  const detected = executable !== null;
  return {
    id: definition.id,
    version,
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
      ? (input) => runExternalAgentCli(executable, definition.args, childEnvironment, definition.id, version, input)
      : undefined,
  };
}

async function runExternalAgentCli(
  executable: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  launcherId: string,
  version: string | null,
  input: Parameters<NonNullable<DelegationRunnerAdapter['run']>>[0],
): Promise<DelegateExecutionResult> {
  const startedAt = Date.now();
  if (input.signal.aborted) return executionResult(input, startedAt, Date.now(), 'cancelled', null, 'Agent CLI execution was cancelled before start.', launcherId, version);
  const prompt = input.messages.length === 0
    ? input.prompt
    : input.messages.map((message) => message.text).filter((text): text is string => text !== null).join('\n\n');
  const child = spawn(executable, args, {
    cwd: resolveLauncherCwd(input.session),
    env,
    shell: false,
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const output: Buffer[] = [];
  const diagnostics: Buffer[] = [];
  let bytes = 0;
  let truncated = false;
  const append = (target: Buffer[], chunk: Buffer) => {
    if (bytes >= MAX_OUTPUT_BYTES) {
      truncated = true;
      return;
    }
    const remaining = MAX_OUTPUT_BYTES - bytes;
    const value = chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk;
    target.push(value);
    bytes += value.byteLength;
    if (value.byteLength < chunk.byteLength) truncated = true;
  };
  child.stdout.on('data', (chunk: Buffer) => append(output, chunk));
  child.stderr.on('data', (chunk: Buffer) => append(diagnostics, chunk));
  const terminate = () => terminateProcess(child);
  input.signal.addEventListener('abort', terminate, { once: true });
  child.stdin.on('error', () => undefined);
  child.stdin.end(prompt);
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
    child.once('close', (code, signal) => resolveExit({ code, signal }));
    child.once('error', () => resolveExit({ code: null, signal: null }));
  });
  input.signal.removeEventListener('abort', terminate);
  const text = truncateUtf8(Buffer.concat(output).toString('utf8'), MAX_RESULT_TEXT_BYTES);
  const errorText = truncateUtf8(Buffer.concat(diagnostics).toString('utf8').trim(), 64 * 1024);
  const outcome = input.signal.aborted
    ? 'cancelled'
    : exit.code === 0
      ? 'succeeded'
      : exit.signal === 'SIGTERM' || exit.signal === 'SIGKILL'
        ? 'cancelled'
        : 'failed';
  return executionResult(
    input,
    startedAt,
    Date.now(),
    outcome,
    text || null,
    errorText || (truncated ? 'Agent CLI output exceeded the supported limit.' : `Agent CLI exited with code ${String(exit.code)}.`),
    launcherId,
    version,
    truncated,
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

function resolveLauncherCwd(session: Parameters<NonNullable<DelegationRunnerAdapter['run']>>[0]['session']): string {
  if (session.worktree.kind === 'active' || session.worktree.kind === 'unchanged'
    || session.worktree.kind === 'changed' || session.worktree.kind === 'retained') {
    return resolve(session.worktree.metadata.path);
  }
  return resolve(session.policy.cwd);
}

function findExecutable(name: string, env: NodeJS.ProcessEnv): string | null {
  for (const directory of (env.PATH ?? '').split(delimiter)) {
    const candidate = join(directory, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function sanitizeExternalCliEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(source).filter(([key, value]) => (
      value !== undefined && EXTERNAL_CLI_ENV_KEYS.has(key.toUpperCase())
    )),
  );
}

function probeVersion(executable: string, env: NodeJS.ProcessEnv): string | null {
  const result = spawnSync(executable, ['--version'], { env, stdio: ['ignore', 'pipe', 'ignore'], timeout: 3_000, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim().slice(0, 128) || null : null;
}

function terminateProcess(child: ReturnType<typeof spawn>): void {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    child.kill('SIGTERM');
    return;
  }
  try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
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
