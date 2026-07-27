import { getBundledRipgrepBinDirForPath } from './agentRipgrep';
import { buildAgentToolPathValue } from './agentToolPath';
import { getAgentProcessExecutor } from './agentProcessExecutor';

export interface AgentToolProcessResult {
  stdout: string;
  stdoutItems?: string[];
  stderr: string;
  stdoutChars: number;
  stderrChars: number;
  exitCode: number | null;
  error?: Error;
  timedOut?: boolean;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  stdoutStoppedEarly?: boolean;
}

export interface AgentToolProcessStdoutItemPage {
  separator: string;
  offset: number;
  limit: number;
  omitEmpty?: boolean;
}

export interface AgentToolProcessOptions {
  maxStdoutChars?: number;
  maxStderrChars?: number;
  env?: NodeJS.ProcessEnv;
  privateEnvKeys?: readonly string[];
  stdoutItemPage?: AgentToolProcessStdoutItemPage;
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
  const itemPage = options.stdoutItemPage;
  if (itemPage && (!itemPage.separator || itemPage.offset < 0 || itemPage.limit < 1)) {
    throw new Error('stdoutItemPage requires a non-empty separator, a non-negative offset, and a positive limit.');
  }
  return await new Promise<AgentToolProcessResult>((resolve) => {
    const executor = getAgentProcessExecutor();
    let stdout = '';
    const stdoutItems = itemPage ? [] as string[] : undefined;
    let stdoutItemBuffer = '';
    let stdoutItemCount = 0;
    let stderr = '';
    let timedOut = false;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let stdoutStoppedEarly = false;
    let stdoutChars = 0;
    let stderrChars = 0;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const finish = (exitCode: number | null, error?: Error) => {
      if (settled) return;
      settled = true;
      resolve({
        stdout,
        ...(stdoutItems ? { stdoutItems } : {}),
        stderr,
        stdoutChars,
        stderrChars,
        exitCode,
        ...(error ? { error } : {}),
        timedOut,
        stdoutTruncated,
        stderrTruncated,
        stdoutStoppedEarly,
      });
    };
    void executor.spawn({
      command,
      args,
      cwd,
      env: { ...buildAgentLocalToolProcessEnv(), ...options.env },
      privateEnvKeys: options.privateEnvKeys,
      detached: process.platform !== 'win32',
    }).then((child) => {
      const timer = setTimeout(() => {
        timedOut = true;
        executor.terminate(child, 'SIGTERM');
        killTimer = setTimeout(() => executor.terminate(child, 'SIGKILL'), 2_000);
      }, timeoutMs);
      // Skip completed items without retaining them; only the requested page and
      // the current unterminated item remain in memory.
      const collectStdoutItem = (item: string): boolean => {
        if (itemPage?.omitEmpty && item.length === 0) return false;
        if (stdoutItemCount < (itemPage?.offset ?? 0)) {
          stdoutItemCount += 1;
          return false;
        }
        stdoutItemCount += 1;
        stdoutItems?.push(item);
        return stdoutItems !== undefined && stdoutItems.length >= (itemPage?.limit ?? Number.POSITIVE_INFINITY);
      };
      const consumeStdoutItems = (chunk: string): boolean => {
        if (!itemPage || stdoutStoppedEarly) return false;
        stdoutItemBuffer += chunk;
        let separatorIndex = stdoutItemBuffer.indexOf(itemPage.separator);
        while (separatorIndex >= 0) {
          const item = stdoutItemBuffer.slice(0, separatorIndex);
          stdoutItemBuffer = stdoutItemBuffer.slice(separatorIndex + itemPage.separator.length);
          if (collectStdoutItem(item)) return true;
          separatorIndex = stdoutItemBuffer.indexOf(itemPage.separator);
        }
        return false;
      };
      const stopAfterStdoutPage = () => {
        if (stdoutStoppedEarly) return;
        stdoutStoppedEarly = true;
        stdoutTruncated = true;
        clearTimeout(timer);
        executor.terminate(child, 'SIGTERM');
        killTimer = setTimeout(() => executor.terminate(child, 'SIGKILL'), 2_000);
      };
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        stdoutChars += chunk.length;
        if (itemPage) {
          if (consumeStdoutItems(chunk)) stopAfterStdoutPage();
        } else {
          const next = appendBounded(stdout, chunk, options.maxStdoutChars);
          stdout = next.value;
          stdoutTruncated ||= next.truncated;
        }
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
        finish(null, error);
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        if (itemPage && !stdoutStoppedEarly && stdoutItemBuffer.length > 0) collectStdoutItem(stdoutItemBuffer);
        finish(code);
      });
    }, (error: unknown) => {
      finish(null, error instanceof Error ? error : new Error(String(error)));
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
