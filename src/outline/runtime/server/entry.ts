#!/usr/bin/env node
import { OutlineRuntimeServer } from './runtimeServer';

const root = argumentValue(process.argv.slice(2), '--root') ?? process.env.TENON_OUTLINE_RUNTIME_ROOT;
const contentRoot = argumentValue(process.argv.slice(2), '--content-root') ?? process.env.TENON_CONTENT_ROOT;
if (!root || !contentRoot) {
  process.stderr.write('outline-runtime: explicit Runtime and ContentStore roots are required\n');
  process.exitCode = 2;
} else {
  const runtime = await OutlineRuntimeServer.start({
    root,
    contentRoot,
    idleTimeoutMs: positiveInteger(process.env.TENON_OUTLINE_RUNTIME_IDLE_MS),
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

function argumentValue(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function positiveInteger(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}
