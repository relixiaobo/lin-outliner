import { getBundledRipgrepBinDirForPath } from './agentRipgrep';
import { buildAgentToolPathValue } from './agentToolPath';
import { getAgentProcessExecutor } from './agentProcessExecutor';
import type { FolderCapabilitySnapshot } from './agentFolderCapabilities';

export interface AgentToolProcessResult {
  stdout: string;
  stderr: string;
  stdoutChars: number;
  stderrChars: number;
  exitCode: number | null;
  error?: Error;
  timedOut?: boolean;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
}

export interface AgentToolProcessOptions {
  maxStdoutChars?: number;
  maxStderrChars?: number;
  capabilities?: FolderCapabilitySnapshot;
  env?: NodeJS.ProcessEnv;
}

export interface AgentLocalToolProcessEnvOptions {
  bundledRipgrepBinDir?: string;
  defaultToolPathSegments?: string[];
}

export function buildAgentLocalToolProcessEnv(options: AgentLocalToolProcessEnvOptions = {}): NodeJS.ProcessEnv {
  const bundledRipgrepBinDir = options.bundledRipgrepBinDir ?? getBundledRipgrepBinDirForPath();
  const pathValue = buildAgentToolPathValue({
    defaultToolPathSegments: options.defaultToolPathSegments,
    trailingSegments: bundledRipgrepBinDir ? [bundledRipgrepBinDir] : [],
  });
  return { ...process.env, PATH: pathValue };
}

export async function runAgentToolProcess(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs = 60_000,
  options: AgentToolProcessOptions = {},
): Promise<AgentToolProcessResult> {
  return await new Promise<AgentToolProcessResult>((resolve) => {
    const executor = getAgentProcessExecutor();
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let stdoutChars = 0;
    let stderrChars = 0;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    void executor.spawn({
      command,
      args,
      cwd,
      env: { ...buildAgentLocalToolProcessEnv(), ...options.env },
      capabilities: options.capabilities,
      detached: process.platform !== 'win32',
    }).then((child) => {
      const timer = setTimeout(() => {
        timedOut = true;
        executor.terminate(child, 'SIGTERM');
        killTimer = setTimeout(() => executor.terminate(child, 'SIGKILL'), 2_000);
      }, timeoutMs);
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        stdoutChars += chunk.length;
        const next = appendBounded(stdout, chunk, options.maxStdoutChars);
        stdout = next.value;
        stdoutTruncated ||= next.truncated;
      });
      child.stderr?.on('data', (chunk: string) => {
        stderrChars += chunk.length;
        const next = appendBounded(stderr, chunk, options.maxStderrChars);
        stderr = next.value;
        stderrTruncated ||= next.truncated;
      });
      child.once('error', (error) => {
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        resolve({ stdout, stderr, stdoutChars, stderrChars, exitCode: null, error, timedOut, stdoutTruncated, stderrTruncated });
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        resolve({ stdout, stderr, stdoutChars, stderrChars, exitCode: code, timedOut, stdoutTruncated, stderrTruncated });
      });
    }, (error: unknown) => {
      resolve({
        stdout,
        stderr,
        stdoutChars,
        stderrChars,
        exitCode: null,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    });
  });
}

function appendBounded(current: string, chunk: string, maxChars: number | undefined): { value: string; truncated: boolean } {
  if (maxChars === undefined || maxChars < 0) return { value: current + chunk, truncated: false };
  if (current.length >= maxChars) return { value: current, truncated: chunk.length > 0 };
  const remaining = maxChars - current.length;
  if (chunk.length <= remaining) return { value: current + chunk, truncated: false };
  return { value: current + chunk.slice(0, remaining), truncated: true };
}
