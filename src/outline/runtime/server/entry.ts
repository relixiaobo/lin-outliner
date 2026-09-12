#!/usr/bin/env node
import { OutlineRuntimeServer } from './runtimeServer';
import { closeSync, writeFileSync, writeSync } from 'node:fs';
import { describeOutlineStartupFailure } from '../../contract/startupFailure';
import { inspectOutlineData } from './dataInspection';

const root = argumentValue(process.argv.slice(2), '--root') ?? process.env.TENON_OUTLINE_RUNTIME_ROOT;
const contentRoot = argumentValue(process.argv.slice(2), '--content-root') ?? process.env.TENON_CONTENT_ROOT;
try {
  if (!root || !contentRoot) {
    process.stderr.write('outline-runtime: explicit Runtime and ContentStore roots are required\n');
    process.exitCode = 2;
  } else if (process.argv.includes('--inspect-data')) {
    process.stdout.write(`${JSON.stringify(await inspectOutlineData(root))}\n`);
  } else {
    const runtime = await OutlineRuntimeServer.start({
      root,
      contentRoot,
      idleTimeoutMs: positiveInteger(process.env.TENON_OUTLINE_RUNTIME_IDLE_MS),
      developmentSessionId: process.env.TENON_OUTLINE_RUNTIME_DEVELOPMENT_SESSION_ID,
      dataLifecycleToken: process.env.TENON_DATA_LIFECYCLE_TOKEN,
      onIdle: () => { process.exitCode = 0; },
    });
    if (!runtime) {
      process.exitCode = 0;
    } else {
      const stop = () => {
        void runtime.stop().finally(() => process.exit(0));
      };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    }
  }
} catch (error) {
  if (process.env.TENON_OUTLINE_STARTUP_REPORT_FD === '3') {
    try { writeSync(3, JSON.stringify(describeOutlineStartupFailure(error))); } catch { /* Parent may have closed. */ }
  } else if (process.env.TENON_OUTLINE_STARTUP_REPORT_PATH) {
    try {
      writeFileSync(process.env.TENON_OUTLINE_STARTUP_REPORT_PATH, JSON.stringify(describeOutlineStartupFailure(error)), { flag: 'wx', mode: 0o600 });
    } catch { /* The parent owns this temporary observation directory and may have closed. */ }
  }
  console.error('Outline Runtime startup failed:', error);
  process.exitCode = 1;
} finally {
  if (process.env.TENON_OUTLINE_STARTUP_REPORT_FD === '3') {
    try { closeSync(3); } catch { /* Only this optional observation descriptor is owned here. */ }
  }
}

function argumentValue(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function positiveInteger(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}
