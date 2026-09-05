import { spawnSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import type { AgentReasoningLevel } from '../../../core/types';
import type { DelegateExecutionResult, DelegateUsage } from '../../../delegate/contract';
import type { DelegationModelSelection, DelegationRunnerAdapter } from './DelegationPolicyResolver';

export const CODEX_SUPPORTED_VERSION = 'codex-cli 0.153.4';
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_CONFIG_BYTES = 512 * 1024;
const REASONING_LEVELS: readonly AgentReasoningLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const CONTROLLED_FEATURES: readonly [string, boolean | string][] = [
  ['features.multi_agent', false],
  ['features.multi_agent_v2', false],
  ['features.collaboration_modes', false],
  ['features.hooks', false],
  ['features.apps', false],
  ['features.browser_use', false],
  ['features.browser_use_external', false],
  ['features.browser_use_full_cdp_access', false],
  ['features.computer_use', false],
  ['features.code_mode', false],
  ['features.code_mode_host', false],
  ['features.goals', false],
  ['features.tool_search', false],
  ['features.shell_tool', true],
  ['features.unified_exec', false],
  ['web_search', 'disabled'],
  ['history.persistence', 'none'],
  ['shell_environment_policy.inherit', 'none'],
  ['approval_policy', 'never'],
];

export interface CodexConfigSnapshot {
  readonly providerId: string;
  readonly provider: Record<string, unknown>;
  readonly mcpIds: readonly string[];
  readonly skillFiles: readonly string[];
  readonly diagnostic: string | null;
}

export interface CodexCliRunnerOptions {
  readonly executable?: string;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => number;
}

export function createCodexCliRunnerAdapter(options: CodexCliRunnerOptions = {}): DelegationRunnerAdapter {
  const executable = options.executable
    ? (existsSync(options.executable) ? options.executable : null)
    : findExecutable(options.env ?? process.env);
  const version = executable ? probeVersion(executable, options.env ?? process.env) : null;
  const config = readCodexConfig(options.env ?? process.env, options.cwd ?? process.cwd());
  const usageBaselines = new Map<string, { input: number; output: number }>();
  const ready = Boolean(executable && version === CODEX_SUPPORTED_VERSION && config && !config.diagnostic);
  const diagnostic = !executable
    ? 'Codex CLI executable was not found.'
    : version === null
      ? 'Codex CLI version probe failed.'
      : version !== CODEX_SUPPORTED_VERSION
        ? `Unsupported Codex CLI version: ${version}`
        : config?.diagnostic ?? null;
  return {
    id: 'codex',
    version,
    detected: executable !== null,
    ready,
    diagnostic,
    resolveExplicitModel: async (model, effort) => ready ? resolveCodexModel(model, effort, config) : null,
    resolveInheritedModel: async (parent, effort) => ready && config
      ? { providerId: config.providerId, modelId: parent.modelId, effort, supportedEfforts: REASONING_LEVELS }
      : null,
    run: ready && executable && config
      ? (input) => runCodexTurn(executable, config, input, options.env ?? process.env, options.now ?? Date.now, usageBaselines)
      : undefined,
  };
}

export function buildCodexArgs(input: {
  readonly executable: string;
  readonly config: CodexConfigSnapshot;
  readonly model: string;
  readonly effort: AgentReasoningLevel;
  readonly access: 'read-only' | 'workspace-write';
  readonly cwd: string;
  readonly resumeId: string | null;
}): readonly string[] {
  const args = input.resumeId === null ? ['exec'] : ['exec', 'resume'];
  args.push('--json', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check', '--cd', resolve(input.cwd));
  args.push('--model', input.model, '--config', `model_reasoning_effort=${JSON.stringify(input.effort)}`);
  args.push('--config', `sandbox_mode=${JSON.stringify(input.access)}`);
  if (input.resumeId === null) args.push('--sandbox', input.access);
  for (const [key, value] of CONTROLLED_FEATURES) {
    args.push('--config', `${key}=${typeof value === 'string' ? JSON.stringify(value) : String(value)}`);
  }
  args.push('--config', `model_provider=${JSON.stringify(input.config.providerId)}`);
  for (const [key, value] of Object.entries(input.config.provider)) {
    if (key === 'name' || key === 'base_url' || key === 'wire_api' || key === 'requires_openai_auth'
      || key === 'env_key') {
      args.push('--config', `model_providers.${input.config.providerId}.${key}=${tomlValue(value)}`);
    }
  }
  for (const id of input.config.mcpIds) {
    args.push('--config', `mcp_servers.${id}.enabled=false`);
  }
  if (input.config.skillFiles.length > 0) {
    const entries = input.config.skillFiles
      .map((file) => `{path=${tomlValue(file)},enabled=false}`)
      .join(',');
    args.push('--config', `skills.config=[${entries}]`);
  }
  if (input.resumeId !== null) args.push(input.resumeId);
  args.push('-');
  return Object.freeze(args);
}

async function runCodexTurn(
  executable: string,
  config: CodexConfigSnapshot,
  input: Parameters<NonNullable<DelegationRunnerAdapter['run']>>[0],
  env: NodeJS.ProcessEnv,
  now: () => number,
  usageBaselines: Map<string, { input: number; output: number }>,
): Promise<DelegateExecutionResult> {
  const startedAt = now();
  const resumeId = input.session.adapterSessionId;
  const args = buildCodexArgs({
    executable,
    config,
    model: input.session.policy.modelId ?? 'default',
    effort: input.session.policy.effort ?? 'medium',
    access: input.session.policy.access,
    cwd: input.session.policy.cwd,
    resumeId,
  });
  const childEnv = codexEnvironment(env, config);
  const child = spawn(executable, args, {
    cwd: input.session.policy.cwd,
    env: childEnv,
    shell: false,
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '';
  let diagnostics = '';
  let bytes = 0;
  const events: Record<string, unknown>[] = [];
  const append = (target: 'output' | 'diagnostics', chunk: Buffer | string) => {
    const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
    bytes += Buffer.byteLength(text, 'utf8');
    if (bytes > MAX_OUTPUT_BYTES) {
      terminate(child);
      return;
    }
    if (target === 'output') output += text;
    else diagnostics += text;
  };
  child.stdout.on('data', (chunk) => append('output', chunk));
  child.stderr.on('data', (chunk) => append('diagnostics', chunk));
  const abort = () => terminate(child);
  input.signal.addEventListener('abort', abort, { once: true });
  child.stdin.end([...input.messages.map((message) => message.text), input.prompt].filter(Boolean).join('\n\n'));
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolveExit({ code, signal }));
  }).catch((error: unknown) => ({ code: null, signal: null, error }));
  input.signal.removeEventListener('abort', abort);
  for (const line of output.split('\n').map((value) => value.trim()).filter(Boolean)) {
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      events.push(event);
    } catch {
      return result(input, startedAt, now(), 'failed', null, `Codex emitted malformed JSONL.`, diagnostics);
    }
  }
  const started = events.find((event) => event.type === 'thread.started');
  const adapterSessionId = typeof started?.thread_id === 'string' ? started.thread_id : null;
  const completed = events.find((event) => event.type === 'turn.completed');
  const failed = events.find((event) => event.type === 'turn.failed');
  const text = events
    .filter((event) => event.type === 'item.completed' && isRecord(event.item) && event.item.type === 'agent_message')
    .map((event) => isRecord(event.item) && typeof event.item.text === 'string' ? event.item.text : '')
    .filter(Boolean).join('\n') || null;
  const aborted = input.signal.aborted;
  const outcome = aborted ? 'cancelled' : failed || exit.code !== 0 ? 'failed' : completed ? 'succeeded' : 'lost';
  const error = failed && isRecord(failed.error) && typeof failed.error.message === 'string'
    ? failed.error.message
    : exit.code !== 0 ? diagnostics.trim().slice(0, 64_000) || `Codex exited with code ${String(exit.code)}.`
      : completed ? null : 'Codex did not emit a terminal event.';
  const cumulativeUsage = usageFromEvents(events);
  const usage = usageForTurn(cumulativeUsage, resumeId, adapterSessionId, usageBaselines);
  return {
    ...result(input, startedAt, now(), outcome, text, error, diagnostics),
    ...(adapterSessionId === null ? {} : { adapterSessionId }),
    usage,
  };
}

function result(
  input: Parameters<NonNullable<DelegationRunnerAdapter['run']>>[0],
  startedAt: number,
  endedAt: number,
  outcome: DelegateExecutionResult['outcome'],
  text: string | null,
  error: string | null,
  diagnostics: string,
): DelegateExecutionResult {
  return {
    version: 1,
    kind: 'delegate.execution-result',
    sessionId: input.session.sessionId,
    turnId: input.turnId,
    outcome,
    runner: { id: 'codex', version: CODEX_SUPPORTED_VERSION },
    model: input.session.policy.modelProvider && input.session.policy.modelId
      ? `${input.session.policy.modelProvider}/${input.session.policy.modelId}` : null,
    durationMs: Math.max(0, endedAt - startedAt),
    text,
    error: error ?? (outcome === 'succeeded' ? null : diagnostics.trim() || null),
    partialEvidence: outcome !== 'succeeded' && text !== null,
    committedMessageSequence: input.messages.at(-1)?.sequence ?? input.session.messageSequence,
    continuation: outcome === 'succeeded' ? 'available' : 'blocked',
    usage: { state: 'unknown' },
    artifacts: [],
    worktree: { disposition: 'none' },
  };
}

function usageFromEvents(events: readonly Record<string, unknown>[]): DelegateUsage {
  const completed = events.find((event) => event.type === 'turn.completed');
  const usage = isRecord(completed?.usage) ? completed.usage : null;
  if (!usage || typeof usage.input_tokens !== 'number' || typeof usage.output_tokens !== 'number') {
    return { state: 'unknown' };
  }
  return { state: 'known', inputTokens: usage.input_tokens, outputTokens: usage.output_tokens };
}

function usageForTurn(
  cumulative: DelegateUsage,
  resumeId: string | null,
  adapterSessionId: string | null,
  baselines: Map<string, { input: number; output: number }>,
): DelegateUsage {
  if (cumulative.state !== 'known' || adapterSessionId === null) return { state: 'unknown' };
  if (resumeId === null) {
    baselines.set(adapterSessionId, { input: cumulative.inputTokens, output: cumulative.outputTokens });
    return cumulative;
  }
  const baseline = baselines.get(resumeId);
  if (!baseline || cumulative.inputTokens < baseline.input || cumulative.outputTokens < baseline.output) {
    return { state: 'unknown' };
  }
  const usage = {
    state: 'known' as const,
    inputTokens: cumulative.inputTokens - baseline.input,
    outputTokens: cumulative.outputTokens - baseline.output,
  };
  baselines.set(resumeId, { input: cumulative.inputTokens, output: cumulative.outputTokens });
  return usage;
}

function resolveCodexModel(
  model: string,
  effort: AgentReasoningLevel,
  config: CodexConfigSnapshot | null,
): DelegationModelSelection | null {
  if (!config || !REASONING_LEVELS.includes(effort)) return null;
  const slash = model.indexOf('/');
  const providerId = slash < 1 ? config.providerId : model.slice(0, slash);
  const modelId = slash < 1 ? model : model.slice(slash + 1);
  if (providerId !== config.providerId || !modelId || modelId === 'default') return null;
  return { providerId, modelId, effort, supportedEfforts: REASONING_LEVELS };
}

function readCodexConfig(env: NodeJS.ProcessEnv, cwd: string): CodexConfigSnapshot | null {
  const home = env.CODEX_HOME ?? join(env.HOME ?? homedir(), '.codex');
  const path = join(home, 'config.toml');
  try {
    const bytes = readFileSync(path);
    if (bytes.byteLength > MAX_CONFIG_BYTES) return { providerId: '', provider: {}, mcpIds: [], skillFiles: [], diagnostic: 'Codex config exceeds the supported size.' };
    const raw = parseToml(bytes.toString('utf8')) as Record<string, unknown>;
    const providerId = typeof raw.model_provider === 'string' ? raw.model_provider : '';
    const providers = isRecord(raw.model_providers) ? raw.model_providers : {};
    const provider = isRecord(providers[providerId]) ? providers[providerId] : {};
    if (!providerId || Object.keys(provider).length === 0) return { providerId, provider, mcpIds: [], skillFiles: [], diagnostic: 'Codex custom provider configuration is unavailable.' };
    if (typeof provider.experimental_bearer_token === 'string') {
      return { providerId, provider, mcpIds: [], skillFiles: [], diagnostic: 'Embedded provider credentials are not accepted by the Codex Runner.' };
    }
    if (isRecord(provider.auth) && provider.requires_openai_auth !== true && typeof provider.env_key !== 'string') {
      return { providerId, provider, mcpIds: [], skillFiles: [], diagnostic: 'Command-backed provider authentication cannot be reconstructed safely.' };
    }
    const mcp = isRecord(raw.mcp_servers) ? raw.mcp_servers : isRecord(raw.mcp) ? raw.mcp : {};
    const mcpIds = Object.keys(mcp);
    const configuredSkills = isRecord(raw.skills) && Array.isArray(raw.skills.config)
      ? raw.skills.config
        .filter(isRecord)
        .map((entry) => typeof entry.path === 'string' ? resolve(home, entry.path) : null)
        .filter((path): path is string => path !== null)
      : [];
    const skillFiles = [...new Set([...discoverSkillFiles(env, cwd), ...configuredSkills])].sort();
    return { providerId, provider, mcpIds, skillFiles, diagnostic: null };
  } catch (error) {
    return { providerId: '', provider: {}, mcpIds: [], skillFiles: [], diagnostic: `Codex config is unavailable: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function discoverSkillFiles(env: NodeJS.ProcessEnv, cwd: string): readonly string[] {
  const roots = [
    join(env.HOME ?? homedir(), '.agents', 'skills'),
    join(env.CODEX_HOME ?? join(env.HOME ?? homedir(), '.codex'), 'skills'),
    join(cwd, '.agents', 'skills'),
    join(cwd, '.codex', 'skills'),
  ];
  const found = new Set<string>();
  const walk = (root: string, depth: number) => {
    if (depth > 5 || found.size >= 512 || !existsSync(root)) return;
    let entries: string[];
    try { entries = readdirSync(root); } catch { return; }
    for (const name of entries) {
      const path = join(root, name);
      let stat;
      try { stat = statSync(path); } catch { continue; }
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) walk(path, depth + 1);
      else if (name === 'SKILL.md') found.add(resolve(path));
    }
  };
  roots.forEach((root) => walk(root, 0));
  return [...found].sort();
}

function probeVersion(executable: string, env: NodeJS.ProcessEnv): string | null {
  const result = spawnSync(executable, ['--version'], { env, stdio: ['ignore', 'pipe', 'ignore'], timeout: 3_000, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

function findExecutable(env: NodeJS.ProcessEnv): string | null {
  for (const directory of (env.PATH ?? '').split(':')) {
    const candidate = join(directory, 'codex');
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function codexEnvironment(env: NodeJS.ProcessEnv, config: CodexConfigSnapshot): NodeJS.ProcessEnv {
  const pathEntries = (env.PATH ?? '').split(':').filter((directory) => (
    !['codex', 'claude', 'openclaw'].some((name) => existsSync(join(directory, name)))
  ));
  const result: NodeJS.ProcessEnv = {
    PATH: pathEntries.join(':'),
    HOME: env.HOME,
    CODEX_HOME: env.CODEX_HOME,
    TMPDIR: env.TMPDIR,
    LANG: env.LANG,
  };
  const envKey = config.provider.env_key;
  if (typeof envKey === 'string' && typeof env[envKey] === 'string') result[envKey] = env[envKey];
  return result;
}

function tomlValue(value: unknown): string {
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  if (typeof value === 'string') return JSON.stringify(value);
  throw new Error('Codex provider configuration contains an unsupported value.');
}

function terminate(child: ReturnType<typeof spawn>): void {
  if (!child.pid) return;
  if (process.platform !== 'win32') {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
  } else child.kill('SIGTERM');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
