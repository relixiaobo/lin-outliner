import { describe, expect, test } from 'bun:test';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { Value } from 'typebox/value';
import { runOutlineCli } from '../../src/outline/cli';
import {
  ChangeSetSchema,
  NormalizedImportSchema,
  type Diff,
  type ImportPlanResult,
  type ImportVerifyResult,
  type NormalizedImport,
  type Operation,
} from '../../src/outline/contract/schemas';
import { OutlineRuntimeServer } from '../../src/outline/runtime/server';

const execFile = promisify(execFileCallback);
const root = path.resolve(import.meta.dir, '..', '..');
const skillRoot = path.join(root, 'src', 'main', 'builtInSkills', 'outline');
const adapter = path.join(skillRoot, 'scripts', 'source-adapters.ts');
const adapterEnvironment = { TENON_OUTLINE_IMPORT_ADAPTER_ENTRY: adapter };

describe('built-in outline Skill import workflow', () => {
  test('the Tana adapter emits only public normalized data and complete coverage', async () => {
    const directory = await temporaryDirectory('outline-import-tana-adapter-');
    const normalizedPath = path.join(directory, 'normalized.json');
    const coveragePath = path.join(directory, 'coverage.json');

    await runAdapter([
      'tana',
      path.join(skillRoot, 'fixtures', 'tana-fields-and-tags.json'),
      '--out', normalizedPath,
      '--coverage-out', coveragePath,
      '--fidelity', 'full',
    ]);

    const normalized = await json(normalizedPath) as NormalizedImport;
    const coverage = await json(coveragePath) as unknown[];
    expect(Value.Check(NormalizedImportSchema, normalized)).toBe(true);
    expect(normalized).toMatchObject({
      version: 1,
      source: { kind: 'tana' },
      coverage: { unaccounted: 0 },
      stats: { sourceRecords: 18, nodes: 4, fields: 1, tags: 2 },
      sections: [{ kind: 'library' }],
    });
    expect(coverage).toHaveLength(18);
    expect(normalized.sections[0]?.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: 'Home' }),
    ]));
    expect(JSON.stringify(normalized)).not.toContain('outline.changeset');
    expect(JSON.stringify(normalized)).not.toContain('diffHash');
    expect(JSON.stringify(normalized)).not.toContain('operationId');
  });

  test('the Tana adapter preserves valid dates without owning date mutations', async () => {
    const directory = await temporaryDirectory('outline-import-tana-dates-');
    const normalizedPath = path.join(directory, 'normalized.json');
    const coveragePath = path.join(directory, 'coverage.json');

    await runAdapter([
      'tana',
      path.join(skillRoot, 'fixtures', 'tana-daily-notes.json'),
      '--out', normalizedPath,
      '--coverage-out', coveragePath,
      '--fidelity', 'full',
    ]);

    const normalized = await json(normalizedPath) as NormalizedImport;
    expect(Value.Check(NormalizedImportSchema, normalized)).toBe(true);
    expect(normalized.sections
      .filter((section) => section.kind === 'date')
      .map((section) => section.date)).toEqual(['2026-08-21', '2026-08-22']);
    expect(normalized).toMatchObject({
      options: { dateGrouping: 'native_daily' },
      coverage: { unaccounted: 0 },
      warnings: [{ code: 'invalid_journal_date', count: 1 }],
    });
    expect(JSON.stringify(normalized)).not.toContain('"op":"ensure"');
  });

  test('imports representative Tana data through public plan, apply, verify, and exact revert', async () => {
    const directory = await temporaryDirectory('outline-import-public-tana-');
    const artifacts = artifactPaths(directory);
    const source = path.join(skillRoot, 'fixtures', 'tana-real-export-shapes.json');
    const runtime = await OutlineRuntimeServer.start({ root: artifacts.runtime, idleTimeoutMs: 60_000 });
    expect(runtime).not.toBeNull();
    if (!runtime) return;

    try {
      const before = JSON.parse(JSON.stringify(runtime.workspace.documentState())) as unknown;
      const operationsBefore = (await runtime.workspace.store.operations()).length;
      const plan = await runOutlineJson(artifacts.runtime, [
        'import', 'plan', source,
        '--format', 'tana',
        '--fidelity', 'full',
        '--output', artifacts.diff,
        '--evidence-output', artifacts.evidence,
        '--changeset-output', artifacts.changeSet,
        '--coverage-output', artifacts.coverage,
      ], '', adapterEnvironment) as ImportPlanResult;

      expect(plan).toMatchObject({
        kind: 'outline.import-plan',
        sourceFormat: 'tana',
        coverage: { unsupported: 0, unaccounted: 0 },
        warnings: [{ code: 'invalid_journal_date', count: 1 }],
        dates: ['2026-08-23'],
      });
      expect(runtime.workspace.documentState()).toEqual(before);
      expect((await runtime.workspace.store.operations()).length).toBe(operationsBefore);

      const diff = await json(artifacts.diff) as Diff;
      const changeSet = await json(artifacts.changeSet) as { operations: Array<Record<string, unknown>> };
      expect(Value.Check(ChangeSetSchema, changeSet)).toBe(true);
      expect(diff.kind).toBe('outline.diff');
      expect(changeSet.operations).toEqual(expect.arrayContaining([
        expect.objectContaining({ op: 'ensure', resource: 'date', date: '2026-08-23' }),
      ]));

      const operation = await runOutlineJson(
        artifacts.runtime,
        ['apply', '--input', artifacts.diff],
      ) as Operation;
      expect(operation).toMatchObject({
        kind: 'outline.operation',
        affectedNodeCount: diff.affected.length,
        recovery: { state: 'available' },
      });
      expect((await runtime.workspace.store.operations()).length).toBe(operationsBefore + 1);

      const verification = await runOutlineJson(artifacts.runtime, [
        'import', 'verify', operation.operationId,
        '--diff', artifacts.diff,
        '--evidence', artifacts.evidence,
      ]) as ImportVerifyResult;
      expect(verification).toMatchObject({
        kind: 'outline.import-verification',
        operationId: operation.operationId,
        affectedNodeCount: operation.affectedNodeCount,
      });

      const nodes = Object.values(runtime.workspace.documentState().nodes);
      const projectTag = nodes.find((node) => node.type === 'tagDef' && node.content.text === 'Project');
      const project = nodes.find((node) => node.content.text === 'Project row');
      const date = nodes.find((node) => node.content.text === '2026-08-23');
      expect(projectTag).toBeDefined();
      expect(project).toMatchObject({ description: 'Imported from a deterministic source shape.' });
      expect(project?.tags).toContain(projectTag!.id);
      expect((project?.completedAt ?? 0)).toBeGreaterThan(0);
      expect(project?.children.map((id) => runtime.workspace.documentState().nodes[id]?.content.text))
        .toContain('Status: Active');
      expect(date?.children.map((id) => runtime.workspace.documentState().nodes[id]?.content.text))
        .toContain('Daily import row');

      const reverted = await runOutlineJson(artifacts.runtime, ['revert', operation.operationId]) as Operation;
      expect(reverted.revertsOperationId).toBe(operation.operationId);
      expect(runtime.workspace.documentState()).toEqual(before);
    } finally {
      await runtime.stop();
    }
  });

  test('rejects import artifact collisions before overwriting the source', async () => {
    const directory = await temporaryDirectory('outline-import-path-collision-');
    const artifacts = artifactPaths(directory);
    const source = path.join(directory, 'source.json');
    const sourceText = await readFile(
      path.join(skillRoot, 'fixtures', 'tana-minimal.json'),
      'utf8',
    );
    await writeFile(source, sourceText, 'utf8');

    const result = await runOutlineFailure(artifacts.runtime, [
      'import', 'plan', source,
      '--format', 'tana',
      '--output', source,
      '--evidence-output', artifacts.evidence,
    ], adapterEnvironment);
    expect(result).toMatchObject({
      code: 2,
      response: {
        ok: false,
        error: { code: 'invalid_input', message: expect.stringContaining('Import paths must be distinct') },
      },
    });
    expect(await readFile(source, 'utf8')).toBe(sourceText);
  });

  test('plans and applies 100 normalized dates without an adapter or intermediate ID lookup', async () => {
    const directory = await temporaryDirectory('outline-import-100-dates-');
    const artifacts = artifactPaths(directory);
    const normalizedPath = path.join(directory, 'normalized.json');
    const sections = Array.from({ length: 100 }, (_, index) => {
      const date = new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10);
      return { title: date, kind: 'date' as const, date, nodes: [{ title: `Entry ${index + 1}` }] };
    });
    await writeFile(normalizedPath, JSON.stringify(normalizedSource(sections)), 'utf8');
    const runtime = await OutlineRuntimeServer.start({ root: artifacts.runtime, idleTimeoutMs: 60_000 });
    expect(runtime).not.toBeNull();
    if (!runtime) return;

    try {
      const before = JSON.parse(JSON.stringify(runtime.workspace.documentState())) as unknown;
      const operationsBefore = (await runtime.workspace.store.operations()).length;
      const plan = await runOutlineJson(artifacts.runtime, [
        'import', 'plan', normalizedPath,
        '--format', 'normalized',
        '--output', artifacts.diff,
        '--evidence-output', artifacts.evidence,
        '--changeset-output', artifacts.changeSet,
      ]) as ImportPlanResult;
      const changeSet = await json(artifacts.changeSet) as { operations: Array<Record<string, unknown>> };
      expect(plan).toMatchObject({
        kind: 'outline.import-plan',
        sourceFormat: 'normalized',
        coverage: { imported: 100, unaccounted: 0 },
      });
      expect(changeSet.operations.filter((item) => item.op === 'ensure' && item.resource === 'date'))
        .toHaveLength(100);
      expect(changeSet.operations.filter((item) => item.op === 'create')).toHaveLength(100);
      expect((await runtime.workspace.store.operations()).length).toBe(operationsBefore);

      const operation = await runOutlineJson(
        artifacts.runtime,
        ['apply', '--input', artifacts.diff],
      ) as Operation;
      expect(operation).toMatchObject({
        kind: 'outline.operation',
        recovery: { state: 'available' },
      });
      expect((await runtime.workspace.store.operations()).length).toBe(operationsBefore + 1);
      const verification = await runOutlineJson(artifacts.runtime, [
        'import', 'verify', operation.operationId,
        '--diff', artifacts.diff,
        '--evidence', artifacts.evidence,
      ]) as ImportVerifyResult;
      expect(verification.operationId).toBe(operation.operationId);

      const reverted = await runOutlineJson(artifacts.runtime, ['revert', operation.operationId]) as Operation;
      expect(reverted.revertsOperationId).toBe(operation.operationId);
      expect(runtime.workspace.documentState()).toEqual(before);
    } finally {
      await runtime.stop();
    }
  });
});

function normalizedSource(sections: NormalizedImport['sections']): NormalizedImport {
  const nodeCount = sections.reduce((total, section) => total + countNodes(section.nodes), 0);
  return {
    version: 1,
    source: { kind: 'normalized', path: '/source/normalized.json' },
    options: {
      fidelity: 'clean',
      dateGrouping: 'native_daily',
      tags: true,
      fields: 'text_children',
      doneState: true,
    },
    stats: {
      sourceRecords: nodeCount,
      sections: sections.length,
      nodes: nodeCount,
      descriptions: 0,
      tags: 0,
      fields: 0,
      checked: 0,
      dropped: 0,
    },
    coverage: {
      imported: nodeCount,
      merged: 0,
      dropped: 0,
      unsupported: 0,
      empty: 0,
      unaccounted: 0,
    },
    warnings: [],
    sections,
  };
}

function countNodes(nodes: readonly { children?: readonly unknown[] }[]): number {
  return nodes.reduce((total, node) => (
    total + 1 + countNodes((node.children ?? []) as Array<{ children?: readonly unknown[] }>)
  ), 0);
}

function runAdapter(args: readonly string[]) {
  return execFile('bun', [adapter, ...args], { env: process.env });
}

async function temporaryDirectory(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

function artifactPaths(directory: string) {
  return {
    runtime: path.join(directory, 'runtime'),
    diff: path.join(directory, 'import.diff.json'),
    evidence: path.join(directory, 'import.evidence.json'),
    changeSet: path.join(directory, 'import.changeset.json'),
    coverage: path.join(directory, 'import.coverage.json'),
  };
}

async function json(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, 'utf8')) as unknown;
}

async function runOutlineJson(
  runtimeRoot: string,
  args: readonly string[],
  stdin = '',
  env: Readonly<Record<string, string | undefined>> = {},
): Promise<unknown> {
  let stdout = '';
  let stderr = '';
  const code = await runOutlineCli(['--json', '--no-start', ...args], {
    runtimeRoot,
    env: { ...process.env, ...env },
    io: {
      stdout: (value) => { stdout += value; },
      stderr: (value) => { stderr += value; },
      readStdin: async () => stdin,
      stdinBytes: () => (async function* () { yield Buffer.from(stdin); })(),
    },
  });
  const response = JSON.parse(stdout) as { ok: boolean; data?: unknown; error?: unknown };
  expect({ code, response, stderr }).toMatchObject({ code: 0, response: { ok: true }, stderr: '' });
  return response.data;
}

async function runOutlineFailure(
  runtimeRoot: string,
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>> = {},
) {
  let stdout = '';
  const code = await runOutlineCli(['--json', '--no-start', ...args], {
    runtimeRoot,
    env: { ...process.env, ...env },
    io: {
      stdout: (value) => { stdout += value; },
      stderr: () => undefined,
    },
  });
  return {
    code,
    response: JSON.parse(stdout) as { ok: boolean; error?: { code?: string; message?: string } },
  };
}
