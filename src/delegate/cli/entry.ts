#!/usr/bin/env node
import { runDelegateCli } from './runner';

const controller = new AbortController();
const onSigint = () => controller.abort('SIGINT');
const onSigterm = () => controller.abort('SIGTERM');
process.once('SIGINT', onSigint);
process.once('SIGTERM', onSigterm);
try {
  process.exitCode = await runDelegateCli(process.argv.slice(2), { signal: controller.signal });
} finally {
  process.off('SIGINT', onSigint);
  process.off('SIGTERM', onSigterm);
}
