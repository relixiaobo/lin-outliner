import { execFile as execFileCallback } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, open, readFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Value } from 'typebox/value';
import {
  DiffSchema,
  ImportEvidenceSchema,
  ImportPlanResultSchema,
  ImportSourceProfileSchema,
  ImportVerifyResultSchema,
  NormalizedImportSchema,
  OperationSchema,
  OutlineContractError,
  TargetRefSchema,
  TargetSpecSchema,
  SelectorSchema,
  outlineCapability,
  outlineError,
  type Diff,
  type ImportEvidence,
  type ImportPlanResult,
  type ImportSourceProfile,
  type ImportVerifyResult,
  type NormalizedImport,
  type Operation,
  type TargetRef,
} from '../contract';
import type { OutlineClientSupervisor } from '../client';
import {
  buildImportChangeSet,
  readJson,
  sha256Text,
  validateImportEvidence,
  validateNormalizedImportShape,
  verifyImportSettlement,
} from '../import/normalized';
import { parseSelectorToken } from './arguments';

const execFile = promisify(execFileCallback);
const IMPORT_ADAPTER_ENTRY_ENV = 'TENON_OUTLINE_IMPORT_ADAPTER_ENTRY';
const CLI_RUNTIME_ENV = 'TENON_OUTLINE_CLI_RUNTIME';
const RUN_AS_NODE_ENV = 'TENON_OUTLINE_RUN_AS_NODE';

export interface ImportCliIo {
  readonly readStdin: (signal?: AbortSignal) => Promise<string>;
}

export async function executeImportInvocation(
  command: string,
  args: readonly string[],
  options: {
    io: ImportCliIo;
    supervisor: OutlineClientSupervisor;
    env?: Readonly<Record<string, string | undefined>>;
    signal?: AbortSignal;
  },
): Promise<ImportSourceProfile | ImportPlanResult | ImportVerifyResult> {
  if (command === 'import inspect') {
    const input = parseInspectInput(args);
    assertRequest(command, input);
    const result = await inspectSource(input.source, options.env, options.signal);
    assertResult(command, result);
    return result;
  }
  if (command === 'import plan') {
    const input = await parsePlanInput(args, options.io, options.signal);
    assertRequest(command, input);
    const result = await planImport(input, options.supervisor, options.env, options.signal);
    assertResult(command, result);
    return result;
  }
  if (command === 'import verify') {
    const input = parseVerifyInput(args);
    assertRequest(command, input);
    const result = await verifyImport(input, options.supervisor, options.signal);
    assertResult(command, result);
    return result;
  }
  throw usageError(`Unsupported import command: ${command}`);
}

function parseInspectInput(args: readonly string[]): { source: string } {
  if (args.length !== 1) throw usageError('import inspect requires exactly one SOURCE.');
  return { source: args[0]! };
}

async function parsePlanInput(args: readonly string[], io: ImportCliIo, signal?: AbortSignal) {
  let source: string | undefined;
  let sourceFormat: 'auto' | 'normalized' | 'tana' = 'auto';
  let fidelity: 'content' | 'clean' | 'full' = 'clean';
  let mode: 'native_daily' | 'stage' | undefined;
  let parent: TargetRef | undefined;
  let output: string | undefined;
  let evidenceOutput: string | undefined;
  let changeSetOutput: string | undefined;
  let coverageOutput: string | undefined;
  let includeTrash = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '--format') {
      const value = requiredValue(args[++index], '--format');
      if (value !== 'auto' && value !== 'normalized' && value !== 'tana') {
        throw usageError('--format must be auto, normalized, or tana.');
      }
      sourceFormat = value;
    } else if (arg === '--fidelity') {
      const value = requiredValue(args[++index], '--fidelity');
      if (value !== 'content' && value !== 'clean' && value !== 'full') {
        throw usageError('--fidelity must be content, clean, or full.');
      }
      fidelity = value;
    } else if (arg === '--mode') {
      const value = requiredValue(args[++index], '--mode');
      if (value !== 'native_daily' && value !== 'stage') {
        throw usageError('--mode must be native_daily or stage.');
      }
      mode = value;
    } else if (arg === '--parent') {
      parent = await parseParent(requiredValue(args[++index], '--parent'), io, signal);
    } else if (arg === '--output') output = requiredValue(args[++index], '--output');
    else if (arg === '--evidence-output') evidenceOutput = requiredValue(args[++index], '--evidence-output');
    else if (arg === '--changeset-output') changeSetOutput = requiredValue(args[++index], '--changeset-output');
    else if (arg === '--coverage-output') coverageOutput = requiredValue(args[++index], '--coverage-output');
    else if (arg === '--include-trash') includeTrash = true;
    else if (arg.startsWith('--')) throw usageError(`Unknown import plan option: ${arg}`);
    else if (!source) source = arg;
    else throw usageError(`Unexpected import plan argument: ${arg}`);
  }
  if (!source) throw usageError('import plan requires SOURCE.');
  if (!output) throw usageError('import plan requires --output DIFF.');
  if (!evidenceOutput) throw usageError('import plan requires --evidence-output EVIDENCE.');
  assertDistinctImportPaths({ source, output, evidenceOutput, changeSetOutput, coverageOutput });
  return {
    source,
    sourceFormat,
    fidelity,
    ...(mode ? { mode } : {}),
    ...(parent ? { parent } : {}),
    output,
    evidenceOutput,
    ...(changeSetOutput ? { changeSetOutput } : {}),
    ...(coverageOutput ? { coverageOutput } : {}),
    ...(includeTrash ? { includeTrash: true } : {}),
  };
}

function parseVerifyInput(args: readonly string[]) {
  let operationId: string | undefined;
  let evidence: string | undefined;
  let diff: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '--evidence') evidence = requiredValue(args[++index], '--evidence');
    else if (arg === '--diff') diff = requiredValue(args[++index], '--diff');
    else if (arg.startsWith('--')) throw usageError(`Unknown import verify option: ${arg}`);
    else if (!operationId) operationId = arg;
    else throw usageError(`Unexpected import verify argument: ${arg}`);
  }
  if (!operationId) throw usageError('import verify requires OPERATION_ID.');
  if (!evidence) throw usageError('import verify requires --evidence EVIDENCE.');
  if (!diff) throw usageError('import verify requires --diff DIFF.');
  return { operationId, evidence, diff };
}

async function parseParent(value: string, io: ImportCliIo, signal?: AbortSignal): Promise<TargetRef> {
  const trimmed = value.trim();
  if (!trimmed.startsWith('{')) {
    if (trimmed.startsWith('@') || /^[A-Za-z][A-Za-z0-9_-]*:/.test(trimmed)) {
      return { target: { selector: parseSelectorToken(trimmed), cardinality: 'one' } };
    }
    const raw = value === '-' ? await io.readStdin(signal) : await readFile(value, 'utf8');
    return parseStructuredParent(raw);
  }
  return parseStructuredParent(trimmed);
}

function parseStructuredParent(raw: string): TargetRef {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (error) {
    throw usageError(`Parent input is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (Value.Check(TargetRefSchema, value)) return value;
  if (Value.Check(TargetSpecSchema, value)) return { target: value };
  if (Value.Check(SelectorSchema, value)) return { target: { selector: value, cardinality: 'one' } };
  throw usageError('Parent input must be a Selector, TargetSpec, or TargetRef.');
}

async function inspectSource(
  source: string,
  env: Readonly<Record<string, string | undefined>> | undefined,
  signal?: AbortSignal,
): Promise<ImportSourceProfile> {
  const directory = await mkdtemp(path.join(tmpdir(), 'outline-import-inspect-'));
  const output = path.join(directory, 'profile.json');
  try {
    await runSourceAdapter(['inspect', source, '--out', output], env, signal);
    const profile = await readJson(output);
    if (!Value.Check(ImportSourceProfileSchema, profile)) {
      throw protocolError('The source adapter returned an invalid ImportSourceProfile.');
    }
    return profile;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function planImport(
  input: {
    source: string;
    sourceFormat: 'auto' | 'normalized' | 'tana';
    fidelity: 'content' | 'clean' | 'full';
    mode?: 'native_daily' | 'stage';
    parent?: TargetRef;
    output: string;
    evidenceOutput: string;
    changeSetOutput?: string;
    coverageOutput?: string;
    includeTrash?: boolean;
  },
  supervisor: OutlineClientSupervisor,
  env: Readonly<Record<string, string | undefined>> | undefined,
  signal?: AbortSignal,
): Promise<ImportPlanResult> {
  const directory = await mkdtemp(path.join(tmpdir(), 'outline-import-plan-'));
  try {
    const sourceText = await readFile(input.source, 'utf8');
    const sourceFingerprint = sha256Text(sourceText);
    const sourceFormat = await resolveSourceFormat(input.sourceFormat, input.source, sourceText, env, signal);
    if (sourceFormat === 'normalized' && (input.includeTrash || input.fidelity !== 'clean')) {
      throw usageError('--include-trash and non-default --fidelity apply only to bundled source adapters.');
    }

    let normalized: NormalizedImport;
    let coverageOutput: string | undefined;
    if (sourceFormat === 'tana') {
      const normalizedPath = path.join(directory, 'normalized.json');
      const temporaryCoverage = path.join(directory, 'coverage.json');
      await runSourceAdapter([
        'tana', input.source,
        '--out', normalizedPath,
        '--coverage-out', temporaryCoverage,
        '--fidelity', input.fidelity,
        ...(input.includeTrash ? ['--include-trash'] : []),
      ], env, signal);
      normalized = await readNormalizedSource(normalizedPath);
      coverageOutput = input.coverageOutput
        ?? `${input.evidenceOutput.replace(/\.json$/u, '')}.coverage.json`;
      assertDistinctImportPaths({
        source: input.source,
        output: input.output,
        evidenceOutput: input.evidenceOutput,
        changeSetOutput: input.changeSetOutput,
        coverageOutput,
      });
      await writeAtomicJson(coverageOutput, await readJson(temporaryCoverage));
      normalized = {
        ...normalized,
        coverage: { ...normalized.coverage, entriesFile: path.resolve(coverageOutput) },
      };
    } else {
      normalized = await readNormalizedValue(JSON.parse(sourceText) as unknown);
      if (input.coverageOutput) {
        throw usageError('--coverage-output is only valid when a bundled adapter produces coverage entries.');
      }
    }

    const built = buildImportChangeSet(normalized, {
      sourceFingerprint,
      ...(input.mode ? { mode: input.mode } : {}),
      ...(input.parent ? { parent: input.parent } : {}),
    });
    const evidenceErrors = validateImportEvidence(built.evidence, built.changeSet);
    if (evidenceErrors.length > 0) throw usageError(evidenceErrors.join('; '));

    const changeSetPath = input.changeSetOutput ?? path.join(directory, 'changeset.json');
    await writeAtomicJson(changeSetPath, built.changeSet);

    const client = await supervisor.connect(signal);
    try {
      const artifact = await client.diffArtifact(createReadStream(changeSetPath), {
        inputFormat: 'json',
        idempotencyKey: `cli:${crypto.randomUUID()}`,
        idempotencyKeyMode: 'if-missing',
        signal,
      });
      await writeAtomicArtifact(input.output, artifact.chunks);
    } finally {
      client.close();
    }

    const diff = await readJson(input.output);
    if (!Value.Check(DiffSchema, diff)) throw protocolError('Outline Runtime returned an invalid import Diff.');
    const reviewedEvidence = {
      ...built.evidence,
      changeSetFingerprint: sha256Text(JSON.stringify(diff.normalizedChangeSet)),
    };
    const diffEvidenceErrors = validateImportEvidence(reviewedEvidence, diff.normalizedChangeSet);
    if (diffEvidenceErrors.length > 0) throw protocolError(diffEvidenceErrors.join('; '));
    await writeAtomicJson(input.evidenceOutput, reviewedEvidence);
    return {
      kind: 'outline.import-plan',
      sourceFormat,
      sourceFingerprint,
      changeSetFingerprint: reviewedEvidence.changeSetFingerprint,
      changeSetHash: diff.changeSetHash,
      diffHash: diff.diffHash,
      affectedNodeCount: diff.affected.length,
      destructive: diff.destructive.length > 0,
      output: input.output,
      evidenceOutput: input.evidenceOutput,
      ...(input.changeSetOutput ? { changeSetOutput: input.changeSetOutput } : {}),
      ...(coverageOutput ? { coverageOutput } : {}),
      coverage: reviewedEvidence.coverage,
      warnings: reviewedEvidence.warnings,
      dates: reviewedEvidence.dates,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function resolveSourceFormat(
  requested: 'auto' | 'normalized' | 'tana',
  source: string,
  sourceText: string,
  env: Readonly<Record<string, string | undefined>> | undefined,
  signal?: AbortSignal,
): Promise<'normalized' | 'tana'> {
  if (requested !== 'auto') return requested;
  try {
    const value = JSON.parse(sourceText) as unknown;
    if (Value.Check(NormalizedImportSchema, value) && validateNormalizedImportShape(value).ok) return 'normalized';
  } catch {
    // The bounded source profile below owns the public unsupported-format error.
  }
  const profile = await inspectSource(source, env, signal);
  if (profile.kind === 'tana') return 'tana';
  throw usageError(`No bundled adapter supports source kind ${profile.kind}; write a cleanup script that emits NormalizedImport v1, then use --format normalized.`);
}

async function readNormalizedSource(source: string): Promise<NormalizedImport> {
  return readNormalizedValue(await readJson(source));
}

async function readNormalizedValue(value: unknown): Promise<NormalizedImport> {
  if (!Value.Check(NormalizedImportSchema, value)) {
    throw usageError('Source does not match outline schema NormalizedImport.');
  }
  const validation = validateNormalizedImportShape(value);
  if (!validation.ok) throw usageError(validation.errors.join('; '));
  return validation.pack;
}

async function verifyImport(
  input: { operationId: string; evidence: string; diff: string },
  supervisor: OutlineClientSupervisor,
  signal?: AbortSignal,
): Promise<ImportVerifyResult> {
  const evidence = await readJson(input.evidence);
  const diff = await readJson(input.diff);
  if (!Value.Check(ImportEvidenceSchema, evidence)) throw usageError('Evidence does not match outline schema ImportEvidence.');
  if (!Value.Check(DiffSchema, diff)) throw usageError('Diff does not match outline schema Diff.');

  const client = await supervisor.connect(signal);
  try {
    const page = (await client.request('log', { operationId: input.operationId, limit: 1 }, signal)).data;
    const operation = isRecord(page) && Array.isArray(page.operations) ? page.operations[0] : undefined;
    if (!Value.Check(OperationSchema, operation) || operation.operationId !== input.operationId) {
      throw usageError(`Operation was not found: ${input.operationId}`);
    }
    let verifiedRoots;
    try {
      verifiedRoots = verifyImportSettlement(evidence as ImportEvidence, diff as Diff, operation as Operation);
    } catch (error) {
      throw verificationError(error instanceof Error ? error.message : String(error));
    }
    const verificationReads = [];
    for (const root of sampleEvenly(verifiedRoots, 8)) {
      const selector = root.kind === 'date'
        ? { by: 'date' as const, date: root.date! }
        : { by: 'id' as const, id: root.nodeId };
      const projection = (await client.request('show', { selector }, signal)).data;
      const shownId = isRecord(projection) && Array.isArray(projection.nodes)
        ? (projection.nodes[0] as { id?: unknown } | undefined)?.id
        : undefined;
      if (shownId !== root.nodeId) {
        throw verificationError(`Independent show verification failed for ${root.kind === 'date' ? `@date:${root.date}` : root.nodeId}.`);
      }
      verificationReads.push({
        selector: root.kind === 'date' ? `@date:${root.date}` : root.nodeId,
        nodeId: root.nodeId,
      });
    }
    return {
      kind: 'outline.import-verification',
      operationId: operation.operationId,
      affectedNodeCount: operation.affectedNodeCount,
      expectedCreatedNodes: evidence.expectedCreatedNodes,
      verifiedRoots,
      verificationReads,
    };
  } finally {
    client.close();
  }
}

async function runSourceAdapter(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>> | undefined,
  signal?: AbortSignal,
): Promise<void> {
  const environment = { ...process.env, ...env };
  const entry = environment[IMPORT_ADAPTER_ENTRY_ENV]
    ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../main/builtInSkills/outline/scripts/source-adapters.ts');
  const runtime = environment[CLI_RUNTIME_ENV] ?? process.execPath;
  if (environment[RUN_AS_NODE_ENV] === '1') environment.ELECTRON_RUN_AS_NODE = '1';
  try {
    await execFile(runtime, [entry, ...args], {
      env: environment,
      maxBuffer: 16 * 1024 * 1024,
      signal,
    });
  } catch (error) {
    const details = isRecord(error) && typeof error.stderr === 'string'
      ? error.stderr.trim()
      : error instanceof Error ? error.message : String(error);
    throw usageError(`Source adapter failed: ${details}`);
  }
}

async function writeAtomicJson(target: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(path.resolve(target)), { recursive: true });
  const temporary = `${target}.outline-${crypto.randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    await rename(temporary, target);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function writeAtomicArtifact(target: string, chunks: AsyncIterable<Uint8Array>): Promise<void> {
  await mkdir(path.dirname(path.resolve(target)), { recursive: true });
  const temporary = `${target}.outline-${crypto.randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    for await (const chunk of chunks) await handle.write(chunk);
    await handle.write(Buffer.from('\n'));
    await handle.sync();
    await handle.close();
    await rename(temporary, target);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function assertRequest(command: string, input: unknown): void {
  const capability = outlineCapability(command)!;
  if (!Value.Check(capability.requestSchema, input)) {
    throw usageError(`Input does not match the public schema for command: ${command}`);
  }
}

function assertResult(command: string, result: unknown): void {
  const capability = outlineCapability(command)!;
  if (!Value.Check(capability.resultSchema, result)) {
    throw protocolError(`Result does not match the public schema for command: ${command}`);
  }
}

function sampleEvenly<T>(values: readonly T[], limit: number): T[] {
  if (values.length <= limit) return [...values];
  return Array.from({ length: limit }, (_, index) => (
    values[Math.floor(index * (values.length - 1) / (limit - 1))]!
  ));
}

function requiredValue(value: string | undefined, option: string): string {
  if (!value || value.startsWith('--')) throw usageError(`${option} requires a value.`);
  return value;
}

function assertDistinctImportPaths(paths: {
  source: string;
  output: string;
  evidenceOutput: string;
  changeSetOutput?: string;
  coverageOutput?: string;
}): void {
  const seen = new Map<string, string>();
  for (const [name, value] of Object.entries(paths)) {
    if (!value) continue;
    const resolved = path.resolve(value);
    const previous = seen.get(resolved);
    if (previous) {
      throw usageError(`Import paths must be distinct: ${previous} and ${name} both resolve to ${resolved}.`);
    }
    seen.set(resolved, name);
  }
}

function usageError(message: string): OutlineContractError {
  return new OutlineContractError(outlineError('invalid_input', 'usage', message));
}

function verificationError(message: string): OutlineContractError {
  return new OutlineContractError(outlineError(
    'precondition_failed',
    'conflict',
    `${message} Stop and inspect before an authorized guarded revert; never retry the import.`,
  ));
}

function protocolError(message: string): OutlineContractError {
  return new OutlineContractError(outlineError('protocol_incompatible', 'protocol', message));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
