import { execFile } from 'node:child_process';

// Audited osascript wrapper for context capture. Rules (see
// docs/plans/lazy-like-global-launcher.md):
//   - Always timeout-bounded; the child is killed on timeout.
//   - Scripts are static/allowlisted (built in-process from provider modules);
//     NEVER interpolate untrusted user input into a script.
//   - Prefer JSON output from scripts.
//   - Never throws — returns a result so providers degrade gracefully and the
//     launcher can show a partial/permission warning instead of crashing.

export interface OsascriptInput {
  language: 'AppleScript' | 'JavaScript';
  script: string;
  timeoutMs: number;
}

export interface OsascriptResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export function runOsascript(input: OsascriptInput): Promise<OsascriptResult> {
  const args = input.language === 'JavaScript'
    ? ['-l', 'JavaScript', '-e', input.script]
    : ['-e', input.script];
  return new Promise((resolve) => {
    execFile(
      'osascript',
      args,
      { timeout: input.timeoutMs, maxBuffer: 8 * 1024 * 1024, killSignal: 'SIGKILL' },
      (error, stdout, stderr) => {
        const killed = Boolean(error && (error as NodeJS.ErrnoException & { killed?: boolean }).killed);
        resolve({
          ok: !error,
          stdout: (stdout ?? '').trim(),
          stderr: (stderr ?? '').trim(),
          timedOut: killed,
        });
      },
    );
  });
}
