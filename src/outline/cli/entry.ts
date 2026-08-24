#!/usr/bin/env node
import { runOutlineCli } from './runner';

const controller = new AbortController();
const interrupt = (signal: NodeJS.Signals) => controller.abort(signal);
const onSigint = () => interrupt('SIGINT');
const onSigterm = () => interrupt('SIGTERM');
process.once('SIGINT', onSigint);
process.once('SIGTERM', onSigterm);
try {
  process.exitCode = await runOutlineCli(process.argv.slice(2), { signal: controller.signal });
} finally {
  process.off('SIGINT', onSigint);
  process.off('SIGTERM', onSigterm);
}
