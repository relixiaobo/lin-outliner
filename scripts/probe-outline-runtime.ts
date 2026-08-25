import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import type { ChangeSet, NodeDraft, Operation, RuntimeStatus } from '../src/outline/contract';
import { runOutlineCli } from '../src/outline/cli/runner';
import { OutlineRuntimeServer } from '../src/outline/runtime/server/runtimeServer';

const LARGE_TREE_NODE_COUNT = 10_000;
const LARGE_TREE_ROOT_COUNT = 100;
const DATE_COUNT = 100;
const WARM_READ_SAMPLES = 20;
const LARGE_TREE_TEXT = 'Runtime probe large node';

const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'outline-runtime-probe-'));
const runtimeRoot = path.join(temporaryRoot, 'runtime');
const artifactsRoot = path.join(temporaryRoot, 'artifacts');
const largeChangeSetPath = path.join(artifactsRoot, 'large-tree.changeset.json');
const largeDiffPath = path.join(artifactsRoot, 'large-tree.diff.json');
const dateChangeSetPath = path.join(artifactsRoot, 'hundred-dates.changeset.json');
const dateDiffPath = path.join(artifactsRoot, 'hundred-dates.diff.json');
const exportPath = path.join(artifactsRoot, 'ten-thousand-results.jsonl');

await mkdir(artifactsRoot, { recursive: true });
await writeFile(largeChangeSetPath, JSON.stringify(largeTreeChangeSet()), 'utf8');
await writeFile(dateChangeSetPath, JSON.stringify(hundredDateChangeSet()), 'utf8');

const eventLoopDelay = monitorEventLoopDelay({ resolution: 10 });
let rssHighWaterBytes = process.memoryUsage().rss;
const rssStartBytes = rssHighWaterBytes;
const sampleMemory = () => {
  rssHighWaterBytes = Math.max(rssHighWaterBytes, process.memoryUsage().rss);
};
const memoryTimer = setInterval(sampleMemory, 10);
eventLoopDelay.enable();

let runtime: OutlineRuntimeServer | null = null;
let report: Record<string, unknown> | null = null;
try {
  const coldStart = await measure(async () => {
    runtime = await OutlineRuntimeServer.start({
      root: runtimeRoot,
      idleTimeoutMs: 60 * 60 * 1_000,
    });
    if (!runtime) throw new Error('The probe could not acquire the Runtime writer lock.');
  });

  await cli(['show', '@today', '--kind', 'summary']);
  const warmReadDurations: number[] = [];
  for (let index = 0; index < WARM_READ_SAMPLES; index += 1) {
    warmReadDurations.push((await measure(() => cli(['show', '@today', '--kind', 'summary']))).durationMs);
  }

  const porcelain = await measure(() => cli([
    'add', '--parent', '@today', 'Runtime probe porcelain mutation',
  ]));
  const porcelainOperation = responseData<Operation>(porcelain.value.stdout, 'add');
  assertOperation(porcelainOperation, 'porcelain mutation');

  const datesBefore = await runtimeStatus();
  const dateDiff = await measure(() => cli([
    'diff', '--input', dateChangeSetPath, '--output', dateDiffPath,
  ]));
  const dateApply = await measure(() => cli(['apply', '--input', dateDiffPath]));
  const dateOperation = responseData<Operation>(dateApply.value.stdout, 'apply');
  assertOperation(dateOperation, '100-date apply');
  const datesAfter = await runtimeStatus();
  assertSingleSettlement('100-date apply', datesBefore, datesAfter, dateOperation);

  const largeBefore = await runtimeStatus();
  const largeDiff = await measure(() => cli([
    'diff', '--input', largeChangeSetPath, '--output', largeDiffPath,
  ]));
  const largeApply = await measure(() => cli(['apply', '--input', largeDiffPath]));
  const largeOperation = responseData<Operation>(largeApply.value.stdout, 'apply');
  assertOperation(largeOperation, 'large-tree apply');
  const largeAfter = await runtimeStatus();
  assertSingleSettlement('large-tree apply', largeBefore, largeAfter, largeOperation);

  const exportSelector = JSON.stringify({
    by: 'query',
    query: { kind: 'rule', op: 'STRING_MATCH', text: LARGE_TREE_TEXT },
    order: 'document',
    limit: LARGE_TREE_NODE_COUNT,
  });
  const exported = await measure(() => cli([
    'export', '--selector', exportSelector, '--limit', String(LARGE_TREE_NODE_COUNT),
    '--format', 'jsonl', '--output', exportPath,
  ]));
  const exportedLines = await countLines(exportPath);
  if (exportedLines !== LARGE_TREE_NODE_COUNT) {
    throw new Error(`10,000-result export produced ${exportedLines} records.`);
  }

  await delay(25);
  eventLoopDelay.disable();
  clearInterval(memoryTimer);
  sampleMemory();

  const [largeChangeSetStat, largeDiffStat, dateChangeSetStat, dateDiffStat, exportStat] = await Promise.all([
    stat(largeChangeSetPath),
    stat(largeDiffPath),
    stat(dateChangeSetPath),
    stat(dateDiffPath),
    stat(exportPath),
  ]);
  report = {
    probe: 'outline-runtime',
    generatedAt: new Date().toISOString(),
    environment: {
      platform: process.platform,
      architecture: process.arch,
      bunVersion: Bun.version,
      nodeCompatibilityVersion: process.version,
    },
    corpus: {
      largeTreeNodes: LARGE_TREE_NODE_COUNT,
      largeTreeRoots: LARGE_TREE_ROOT_COUNT,
      dates: DATE_COUNT,
      warmReadSamples: WARM_READ_SAMPLES,
    },
    timingsMs: {
      coldRuntimeStart: coldStart.durationMs,
      warmReads: distribution(warmReadDurations),
      porcelainMutation: porcelain.durationMs,
      hundredDate: {
        diff: dateDiff.durationMs,
        apply: dateApply.durationMs,
        total: roundMs(dateDiff.durationMs + dateApply.durationMs),
      },
      largeTree: {
        diff: largeDiff.durationMs,
        apply: largeApply.durationMs,
        total: roundMs(largeDiff.durationMs + largeApply.durationMs),
      },
      tenThousandResultExport: exported.durationMs,
    },
    artifacts: {
      hundredDateChangeSetBytes: dateChangeSetStat.size,
      hundredDateDiffBytes: dateDiffStat.size,
      largeTreeChangeSetBytes: largeChangeSetStat.size,
      largeTreeDiffBytes: largeDiffStat.size,
      exportBytes: exportStat.size,
      exportRecords: exportedLines,
    },
    settlements: {
      porcelainOperationId: porcelainOperation.operationId,
      hundredDateOperationId: dateOperation.operationId,
      largeTreeOperationId: largeOperation.operationId,
      finalRevision: statusRevision(largeAfter),
      finalTransactionSequence: statusSequence(largeAfter),
    },
    eventLoopDelayMs: {
      mean: nanosecondsToMilliseconds(eventLoopDelay.mean),
      p50: nanosecondsToMilliseconds(eventLoopDelay.percentile(50)),
      p95: nanosecondsToMilliseconds(eventLoopDelay.percentile(95)),
      p99: nanosecondsToMilliseconds(eventLoopDelay.percentile(99)),
      max: nanosecondsToMilliseconds(eventLoopDelay.max),
    },
    memoryMiB: {
      rssStart: bytesToMiB(rssStartBytes),
      rssHighWater: bytesToMiB(rssHighWaterBytes),
      rssEnd: bytesToMiB(process.memoryUsage().rss),
    },
  };
} finally {
  eventLoopDelay.disable();
  clearInterval(memoryTimer);
  await runtime?.stop().catch(() => undefined);
  await rm(temporaryRoot, { recursive: true, force: true });
}

if (!report) throw new Error('Outline Runtime probe did not produce a report.');
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

async function cli(args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const exitCode = await runOutlineCli(['--json', '--no-start', ...args], {
    runtimeRoot,
    io: {
      stdout: (value) => { stdout += value; },
      stdoutBytes: (value) => { stdout += Buffer.from(value).toString('utf8'); },
      stderr: (value) => { stderr += value; },
      readStdin: async () => '',
      stdinBytes: async function* () { return; },
      interactive: false,
      confirm: async () => false,
    },
  });
  sampleMemory();
  if (exitCode !== 0) {
    throw new Error(`outline ${args.join(' ')} failed with exit ${exitCode}: ${stderr || stdout}`);
  }
  return { stdout, stderr };
}

async function runtimeStatus(): Promise<RuntimeStatus> {
  const status = responseData<RuntimeStatus>((await cli(['status'])).stdout, 'status');
  if (!status.running) throw new Error('Outline Runtime stopped during the performance probe.');
  return status;
}

function largeTreeChangeSet(): ChangeSet {
  const childrenPerRoot = (LARGE_TREE_NODE_COUNT / LARGE_TREE_ROOT_COUNT) - 1;
  if (!Number.isInteger(childrenPerRoot)) throw new Error('Large-tree corpus is not evenly divisible.');
  const roots: NodeDraft[] = [];
  let nodeIndex = 0;
  for (let rootIndex = 0; rootIndex < LARGE_TREE_ROOT_COUNT; rootIndex += 1) {
    const children = Array.from({ length: childrenPerRoot }, () => draft(`${LARGE_TREE_TEXT} ${nodeIndex++}`));
    roots.push(draft(`${LARGE_TREE_TEXT} ${nodeIndex++}`, children));
  }
  if (nodeIndex !== LARGE_TREE_NODE_COUNT) throw new Error(`Large-tree corpus contains ${nodeIndex} nodes.`);
  return {
    protocolVersion: 1,
    kind: 'outline.changeset',
    source: { kind: 'automation', label: 'repeatable Runtime performance probe' },
    operations: [{
      op: 'create',
      placement: { kind: 'last', parent: oneAlias('inbox') },
      nodes: roots,
      bind: 'largeTree',
    }],
  };
}

function hundredDateChangeSet(): ChangeSet {
  const operations: ChangeSet['operations'][number][] = [];
  const start = new Date(Date.UTC(2030, 0, 1));
  for (let index = 0; index < DATE_COUNT; index += 1) {
    const date = new Date(start);
    date.setUTCDate(start.getUTCDate() + index);
    const localDate = date.toISOString().slice(0, 10);
    operations.push({ op: 'ensure', resource: 'date', date: localDate, bind: `date${index}` });
    operations.push({
      op: 'create',
      placement: { kind: 'last', parent: { binding: `date${index}` } },
      nodes: [draft(`Runtime probe date ${localDate}`)],
    });
  }
  return {
    protocolVersion: 1,
    kind: 'outline.changeset',
    source: { kind: 'automation', label: 'repeatable Runtime 100-date probe' },
    operations,
  };
}

function draft(text: string, children: NodeDraft[] = []): NodeDraft {
  return {
    content: { text, marks: [], inlineRefs: [] },
    children,
  };
}

function oneAlias(alias: 'inbox') {
  return { target: { selector: { by: 'alias' as const, alias }, cardinality: 'one' as const } };
}

async function measure<T>(work: () => T | Promise<T>): Promise<{ value: T; durationMs: number }> {
  sampleMemory();
  const started = performance.now();
  const value = await work();
  const durationMs = roundMs(performance.now() - started);
  sampleMemory();
  return { value, durationMs };
}

function responseData<T>(stdout: string, command: string): T {
  const trimmed = stdout.trim();
  if (!trimmed) throw new Error(`outline ${command} produced no JSON response.`);
  const value = JSON.parse(trimmed) as { ok?: unknown; command?: unknown; data?: unknown; error?: unknown };
  if (value.ok !== true || value.command !== command) {
    throw new Error(`outline ${command} returned an unexpected envelope: ${trimmed}`);
  }
  return value.data as T;
}

function assertOperation(operation: Operation, label: string): void {
  if (operation.kind !== 'outline.operation' || !operation.operationId) {
    throw new Error(`${label} did not return a public Operation.`);
  }
}

function assertSingleSettlement(
  label: string,
  before: RuntimeStatus,
  after: RuntimeStatus,
  operation: Operation,
): void {
  const revisionBefore = statusRevision(before);
  const revisionAfter = statusRevision(after);
  const sequenceBefore = statusSequence(before);
  const sequenceAfter = statusSequence(after);
  if (revisionAfter !== revisionBefore + 1
    || sequenceAfter !== sequenceBefore + 1
    || operation.revisionBefore !== revisionBefore
    || operation.revisionAfter !== revisionAfter) {
    throw new Error(
      `${label} was not one Diff/one apply/one settlement: revision ${revisionBefore}->${revisionAfter}, `
      + `sequence ${sequenceBefore}->${sequenceAfter}.`,
    );
  }
}

function statusRevision(status: RuntimeStatus): number {
  if (!status.running) throw new Error('Runtime status is not live.');
  return status.runtime.revision;
}

function statusSequence(status: RuntimeStatus): number {
  if (!status.running) throw new Error('Runtime status is not live.');
  return status.runtime.transactionLog.sequence;
}

async function countLines(file: string): Promise<number> {
  let count = 0;
  for await (const chunk of createReadStream(file)) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    for (const byte of bytes) if (byte === 0x0a) count += 1;
  }
  return count;
}

function distribution(values: readonly number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    samples: sorted.length,
    min: sorted[0],
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: sorted.at(-1),
  };
}

function percentile(sorted: readonly number[], value: number): number | undefined {
  if (sorted.length === 0) return undefined;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((value / 100) * sorted.length) - 1));
  return sorted[index];
}

function nanosecondsToMilliseconds(value: number): number {
  return Number.isFinite(value) ? roundMs(value / 1_000_000) : 0;
}

function roundMs(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function bytesToMiB(value: number): number {
  return Math.round((value / 1024 / 1024) * 10) / 10;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
