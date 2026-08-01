#!/usr/bin/env bun
import { optionValue, readJson, requiredArg, validateImportPackShape, writeJson } from './import-pack-lib';

const USAGE = 'Usage: bun validate-import-pack.ts <pack.json> [--out <report.json>]';

async function main() {
  const args = process.argv.slice(2);
  const packFile = requiredArg(args, 0, USAGE);
  const out = optionValue(args, '--out');
  const pack = await readJson(packFile);
  const validation = validateImportPackShape(pack);
  const report = validation.ok
    ? { ok: true, errors: [], stats: validation.pack.stats, coverage: validation.pack.coverage, warnings: validation.pack.warnings }
    : { ok: false, errors: validation.errors };
  if (out) await writeJson(out, report);
  console.log(JSON.stringify(report, null, 2));
  if (!validation.ok) process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
