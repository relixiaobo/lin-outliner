#!/usr/bin/env node
import { runOutlineCli } from './runner';

const controller = new AbortController();
const interrupt = () => controller.abort();
process.once('SIGINT', interrupt);
try {
  process.exitCode = await runOutlineCli(process.argv.slice(2), { signal: controller.signal });
} finally {
  process.off('SIGINT', interrupt);
}
