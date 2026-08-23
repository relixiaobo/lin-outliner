#!/usr/bin/env node
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import {
  buildImportChangeSet,
  optionFlag,
  optionValue,
  readJson,
  readText,
  requiredArg,
  sha256Text,
  validateImportEvidence,
  validateNormalizedImportShape,
  writeJson,
  type ImportEvidence,
  type NormalizedImport,
} from './import-source-lib';
import { inspectSource } from './inspect-source';
import { lastTanaCoverageEntries, normalizeTanaExport } from './tana-to-changeset';

const USAGE = [
  'Usage:',
  '  outline import-helper inspect <source> --out <profile.json>',
  '  outline import-helper tana <source> --out <changeset.json> --evidence-out <evidence.json> [--coverage-out <coverage.json>] [--fidelity content|clean|full] [--mode native_daily|stage] [--parent-id <node-id>]',
  '  outline import-helper normalized <source.json> --out <changeset.json> --evidence-out <evidence.json> [--mode native_daily|stage] [--parent-id <node-id>]',
  '  outline import-helper check-coverage <evidence.json> --changeset <changeset.json>',
  '  outline import-helper verify-result <operation.json> --evidence <evidence.json> --diff <diff.json> [--outline-bin <path>]',
].join('\n');

const execFile = promisify(execFileCallback);

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args.shift();
  if (!command || command === '--help' || command === '-h') {
    console.log(USAGE);
    return;
  }
  if (command === 'inspect') return runInspect(args);
  if (command === 'tana') return runTana(args);
  if (command === 'normalized') return runNormalized(args);
  if (command === 'check-coverage') return runCoverageCheck(args);
  if (command === 'verify-result') return runVerification(args);
  throw new Error(`Unknown outline-import helper command: ${command}\n${USAGE}`);
}

async function runInspect(args: string[]): Promise<void> {
  const source = requiredArg(args, 0, USAGE);
  const out = requiredOption(args, '--out');
  const profile = await inspectSource(source);
  await writeJson(out, profile);
  print({ ok: true, command: 'inspect', out, profile });
}

async function runTana(args: string[]): Promise<void> {
  assertAllowedOptions(args, [
    '--out', '--evidence-out', '--coverage-out', '--fidelity', '--mode', '--parent-id', '--include-trash',
  ]);
  const source = requiredArg(args, 0, USAGE);
  const out = requiredOption(args, '--out');
  const evidenceOut = requiredOption(args, '--evidence-out');
  const coverageOut = optionValue(args, '--coverage-out') ?? `${out.replace(/\.json$/u, '')}.coverage.json`;
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
  await writeArtifacts(normalized, sha256Text(sourceText), out, evidenceOut, args);
}

async function runNormalized(args: string[]): Promise<void> {
  assertAllowedOptions(args, ['--out', '--evidence-out', '--mode', '--parent-id']);
  const source = requiredArg(args, 0, USAGE);
  const out = requiredOption(args, '--out');
  const evidenceOut = requiredOption(args, '--evidence-out');
  const sourceText = await readText(source);
  const value = JSON.parse(sourceText) as unknown;
  const validation = validateNormalizedImportShape(value);
  if (!validation.ok) throw new Error(validation.errors.join('; '));
  await writeArtifacts(validation.pack, sha256Text(sourceText), out, evidenceOut, args);
}

async function writeArtifacts(
  normalized: NormalizedImport,
  sourceFingerprint: string,
  out: string,
  evidenceOut: string,
  args: string[],
): Promise<void> {
  const mode = optionalMode(args);
  const parentId = optionValue(args, '--parent-id');
  const built = buildImportChangeSet(normalized, {
    sourceFingerprint,
    ...(mode ? { mode } : {}),
    ...(parentId ? { parentId } : {}),
  });
  await writeJson(out, built.changeSet);
  await writeJson(evidenceOut, built.evidence);
  print({
    ok: true,
    command: normalized.source.kind,
    out,
    evidenceOut,
    stats: built.evidence.stats,
    coverage: built.evidence.coverage,
    warnings: built.evidence.warnings,
    dates: built.evidence.dates,
  });
}

async function runCoverageCheck(args: string[]): Promise<void> {
  assertAllowedOptions(args, ['--changeset']);
  const evidenceFile = requiredArg(args, 0, USAGE);
  const changeSetFile = requiredOption(args, '--changeset');
  const evidence = await readJson(evidenceFile) as ImportEvidence;
  const changeSet = await readJson(changeSetFile);
  const errors = validateImportEvidence(evidence, changeSet);
  if (errors.length > 0) throw new Error(errors.join('; '));
  print({ ok: true, command: 'check-coverage', evidenceFile, changeSetFile });
}

async function runVerification(args: string[]): Promise<void> {
  assertAllowedOptions(args, ['--evidence', '--diff', '--outline-bin']);
  const operationFile = requiredArg(args, 0, USAGE);
  const evidence = await readJson(requiredOption(args, '--evidence')) as ImportEvidence;
  const diff = record(await readJson(requiredOption(args, '--diff')));
  const raw = await readJson(operationFile);
  const operation = record(record(raw).data ?? raw);
  const normalizedChangeSet = diff.normalizedChangeSet;
  const evidenceErrors = validateImportEvidence(evidence, normalizedChangeSet);
  if (evidenceErrors.length > 0) throw new Error(evidenceErrors.join('; '));
  const affected = Array.isArray(diff.affected) ? diff.affected.map((entry) => record(entry).id) : [];
  if (!affected.every((entry): entry is string => typeof entry === 'string')) {
    throw verificationError('Diff affected entries are invalid.');
  }
  const affectedSample = Array.isArray(operation.affectedNodeIds) ? operation.affectedNodeIds : [];
  const valid = operation.kind === 'outline.operation'
    && typeof operation.operationId === 'string'
    && operation.changeSetHash === diff.changeSetHash
    && operation.diffHash === diff.diffHash
    && operation.affectedNodeCount === affected.length
    && operation.affectedNodeIdsHash === sha256Text(JSON.stringify(affected))
    && JSON.stringify(affectedSample) === JSON.stringify(affected.slice(0, affectedSample.length));
  if (!valid) throw verificationError('Operation settlement does not match the reviewed Diff.');

  const bindings = record(diff.bindings);
  const results = Array.isArray(operation.result) ? operation.result.map(record) : [];
  const verifiedRoots = evidence.verification.map((expected) => {
    const bindingIds = bindings[expected.binding];
    if (!Array.isArray(bindingIds) || bindingIds.length !== 1 || typeof bindingIds[0] !== 'string') {
      throw verificationError(`Diff binding is missing or ambiguous: ${expected.binding}`);
    }
    const result = results.find((candidate) => {
      const projection = record(candidate.projection);
      return record(projection.targets).binding === expected.binding;
    });
    const nodes = result && Array.isArray(result.nodes) ? result.nodes.map(record) : [];
    if (!result
      || result.revision !== operation.revisionAfter
      || nodes.length !== expected.expectedNodeCount
      || nodes[0]?.id !== bindingIds[0]
      || Boolean(result.truncated) !== Boolean(expected.truncated)) {
      throw verificationError(`Returned Projection does not match evidence binding: ${expected.binding}`);
    }
    return {
      binding: expected.binding,
      kind: expected.kind,
      nodeId: bindingIds[0],
      ...(expected.date ? { date: expected.date } : {}),
      nodeCount: nodes.length,
      truncated: Boolean(result.truncated),
    };
  });

  const outlineBin = optionValue(args, '--outline-bin')
    ?? process.env.TENON_OUTLINE_LAUNCHER
    ?? 'outline';
  const verificationReads = [];
  for (const root of sampleEvenly(verifiedRoots, 8)) {
    const selector = root.kind === 'date' ? `@date:${root.date}` : root.nodeId;
    const { stdout } = await execFile(outlineBin, ['--json', 'show', selector], {
      env: process.env,
      maxBuffer: 16 * 1024 * 1024,
    });
    const response = record(JSON.parse(stdout) as unknown);
    const nodes = Array.isArray(record(response.data).nodes) ? record(response.data).nodes as unknown[] : [];
    const shownId = record(nodes[0]).id;
    if (response.ok !== true || shownId !== root.nodeId) {
      throw verificationError(`Independent show verification failed for ${selector}.`);
    }
    verificationReads.push({ selector, nodeId: root.nodeId });
  }
  print({
    ok: true,
    command: 'verify-result',
    operationId: operation.operationId,
    affectedNodeCount: operation.affectedNodeCount,
    expectedCreatedNodes: evidence.expectedCreatedNodes,
    verifiedRoots,
    verificationReads,
  });
}

function verificationError(message: string): Error {
  return new Error(`${message} Stop and inspect before an authorized guarded revert; never retry the import.`);
}

function sampleEvenly<T>(values: readonly T[], limit: number): T[] {
  if (values.length <= limit) return [...values];
  return Array.from(
    { length: limit },
    (_, index) => values[Math.floor(index * (values.length - 1) / (limit - 1))]!,
  );
}

function requiredOption(args: string[], name: string): string {
  const value = optionValue(args, name);
  if (!value) throw new Error(`${name} is required.\n${USAGE}`);
  return value;
}

function optionalMode(args: string[]): 'native_daily' | 'stage' | undefined {
  const mode = optionValue(args, '--mode');
  if (mode === undefined) return undefined;
  if (mode !== 'native_daily' && mode !== 'stage') throw new Error('--mode must be native_daily or stage');
  return mode;
}

function assertAllowedOptions(args: string[], options: readonly string[]): void {
  const allowed = new Set(options);
  for (let index = 1; index < args.length; index += 1) {
    const value = args[index]!;
    if (!value.startsWith('--')) continue;
    if (!allowed.has(value)) throw new Error(`Unexpected option: ${value}`);
    if (value !== '--include-trash') index += 1;
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

if ((import.meta as ImportMeta & { main?: boolean }).main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
