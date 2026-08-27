#!/usr/bin/env node
import {
  optionFlag,
  optionValue,
  readText,
  requiredArg,
  writeJson,
} from '../../../../outline/import/normalized';
import { inspectSource } from './inspect-source';
import { lastTanaCoverageEntries, normalizeTanaExport } from './tana-adapter';

const USAGE = [
  'Internal source-adapter worker:',
  '  source-adapters inspect SOURCE --out PROFILE',
  '  source-adapters tana SOURCE --out NORMALIZED --coverage-out COVERAGE [--fidelity content|clean|full] [--include-trash]',
].join('\n');

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args.shift();
  if (command === 'inspect') return runInspect(args);
  if (command === 'tana') return runTana(args);
  throw new Error(`Unknown source-adapter worker command: ${command ?? '(missing)'}\n${USAGE}`);
}

async function runInspect(args: string[]): Promise<void> {
  assertAllowedOptions(args, ['--out']);
  const source = requiredArg(args, 0, USAGE);
  const out = requiredOption(args, '--out');
  await writeJson(out, await inspectSource(source));
}

async function runTana(args: string[]): Promise<void> {
  assertAllowedOptions(args, ['--out', '--coverage-out', '--fidelity', '--include-trash']);
  const source = requiredArg(args, 0, USAGE);
  const out = requiredOption(args, '--out');
  const coverageOut = requiredOption(args, '--coverage-out');
  const fidelity = optionValue(args, '--fidelity') ?? 'clean';
  if (fidelity !== 'content' && fidelity !== 'clean' && fidelity !== 'full') {
    throw new Error('--fidelity must be content, clean, or full');
  }
  const sourceText = await readText(source);
  const normalized = await normalizeTanaExport(JSON.parse(sourceText) as unknown, {
    source,
    coverageOut,
    includeTrash: optionFlag(args, '--include-trash'),
    options: {
      fidelity,
      dateGrouping: 'native_daily',
      tags: fidelity !== 'content',
      fields: fidelity === 'full' ? 'field_rows' : fidelity === 'clean' ? 'text_children' : 'omit',
      doneState: fidelity !== 'content',
    },
  });
  await writeJson(coverageOut, lastTanaCoverageEntries());
  await writeJson(out, normalized);
}

function requiredOption(args: string[], name: string): string {
  const value = optionValue(args, name);
  if (!value) throw new Error(`${name} is required.\n${USAGE}`);
  return value;
}

function assertAllowedOptions(args: string[], options: readonly string[]): void {
  const allowed = new Set(options);
  for (let index = 1; index < args.length; index += 1) {
    const value = args[index]!;
    if (!value.startsWith('--')) continue;
    if (!allowed.has(value)) throw new Error(`Unexpected source-adapter worker option: ${value}`);
    if (value !== '--include-trash') index += 1;
  }
}

if ((import.meta as ImportMeta & { main?: boolean }).main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
