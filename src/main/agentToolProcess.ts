import { spawn } from 'node:child_process';
import path from 'node:path';

export interface AgentToolProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  error?: Error;
  timedOut?: boolean;
}

const EXTRA_TOOL_PATH_ENV = 'LIN_AGENT_EXTRA_TOOL_PATH';
const DEFAULT_AGENT_TOOL_PATH_SEGMENTS = [
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
  '/usr/local/bin',
  '/usr/local/sbin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
];

export function buildAgentLocalToolProcessEnv(): NodeJS.ProcessEnv {
  const segments = [
    ...pathSegments(process.env[EXTRA_TOOL_PATH_ENV]),
    ...pathSegments(process.env.PATH),
    ...DEFAULT_AGENT_TOOL_PATH_SEGMENTS,
  ];
  const seen = new Set<string>();
  const pathValue = segments.filter((segment) => {
    if (seen.has(segment)) return false;
    seen.add(segment);
    return true;
  }).join(path.delimiter);
  return { ...process.env, PATH: pathValue };
}

export async function runAgentToolProcess(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs = 60_000,
): Promise<AgentToolProcessResult> {
  return await new Promise<AgentToolProcessResult>((resolve) => {
    const child = spawn(command, args, { cwd, env: buildAgentLocalToolProcessEnv(), shell: false });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', (error) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: null, error, timedOut });
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code, timedOut });
    });
  });
}

function pathSegments(value: string | undefined): string[] {
  return (value ?? '')
    .split(path.delimiter)
    .map((segment) => segment.trim())
    .filter(Boolean);
}
