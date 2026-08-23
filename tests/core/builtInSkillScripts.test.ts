import { describe, expect, test } from 'bun:test';
import { execFile as execFileCallback } from 'node:child_process';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { Value } from 'typebox/value';
import { canonicalSha256 } from '../../src/outline/contract/canonical';
import { ChangeSetSchema } from '../../src/outline/contract/schemas';

const execFile = promisify(execFileCallback);
const root = path.resolve(import.meta.dir, '..', '..');
const skillRoot = path.join(root, 'src', 'main', 'builtInSkills', 'outline-import');
const helper = path.join(skillRoot, 'scripts', 'outline-import.ts');

describe('built-in import Skill helper scripts', () => {
  test('maps Tana source into a generic ChangeSet with bound coverage evidence', async () => {
    const directory = await temporaryDirectory('outline-import-tana-');
    const output = artifactPaths(directory);
    await runHelper([
      'tana',
      path.join(skillRoot, 'fixtures', 'tana-fields-and-tags.json'),
      '--out', output.changeSet,
      '--evidence-out', output.evidence,
      '--coverage-out', output.coverage,
      '--fidelity', 'full',
    ]);
    await runHelper(['check-coverage', output.evidence, '--changeset', output.changeSet]);

    const changeSet = await json(output.changeSet);
    const evidence = await json(output.evidence) as Evidence;
    const coverage = await json(output.coverage) as unknown[];
    expect(Value.Check(ChangeSetSchema, changeSet)).toBe(true);
    expect(changeSet).toMatchObject({
      protocolVersion: 1,
      kind: 'outline.changeset',
      source: { kind: 'import' },
    });
    expect(evidence).toMatchObject({
      coverage: { unaccounted: 0 },
      stats: { sourceRecords: 14, nodes: 4, fields: 1, tags: 1 },
      mode: 'stage',
      expectedCreatedNodes: 7,
      verification: [{ kind: 'created-tree', expectedNodeCount: 7 }],
    });
    expect(coverage).toHaveLength(14);
    expect(JSON.stringify(changeSet)).not.toContain('previewId');
    expect(changeSet.return).toHaveLength(1);
  });

  test('emits one ChangeSet that ensures every valid Tana date in the same batch', async () => {
    const directory = await temporaryDirectory('outline-import-daily-');
    const output = artifactPaths(directory);
    await runHelper([
      'tana',
      path.join(skillRoot, 'fixtures', 'tana-daily-notes.json'),
      '--out', output.changeSet,
      '--evidence-out', output.evidence,
      '--coverage-out', output.coverage,
      '--fidelity', 'full',
    ]);

    const changeSet = await json(output.changeSet) as ChangeSetView;
    const evidence = await json(output.evidence) as Evidence;
    const dates = changeSet.operations
      .filter((operation) => operation.op === 'ensure' && operation.resource === 'date')
      .map((operation) => operation.date);
    expect(Value.Check(ChangeSetSchema, changeSet)).toBe(true);
    expect(dates).toEqual(['2026-08-21', '2026-08-22']);
    expect(evidence).toMatchObject({
      mode: 'native_daily',
      dates: ['2026-08-21', '2026-08-22'],
      coverage: { unaccounted: 0 },
      warnings: [{ code: 'invalid_journal_date', count: 1 }],
    });
  });

  test('accepts an already-normalized source without a cleanup or adapter pass', async () => {
    const directory = await temporaryDirectory('outline-import-normalized-');
    const output = artifactPaths(directory);
    const normalized = path.join(directory, 'normalized.json');
    await writeFile(normalized, JSON.stringify(normalizedSource([
      { title: 'Already normalized', children: [{ title: 'Child' }] },
    ])), 'utf8');

    await runHelper([
      'normalized', normalized,
      '--out', output.changeSet,
      '--evidence-out', output.evidence,
    ]);
    await runHelper(['check-coverage', output.evidence, '--changeset', output.changeSet]);

    const changeSet = await json(output.changeSet) as ChangeSetView;
    expect(Value.Check(ChangeSetSchema, changeSet)).toBe(true);
    expect(changeSet.operations.filter((operation) => operation.op === 'create')).toHaveLength(4);
    expect(JSON.stringify(changeSet.operations)).toContain('Import: normalized.json');
  });

  test('keeps 100 dates inside one ChangeSet and rejects evidence after artifact tampering', async () => {
    const directory = await temporaryDirectory('outline-import-100-dates-');
    const output = artifactPaths(directory);
    const normalized = path.join(directory, 'normalized.json');
    const sections = Array.from({ length: 100 }, (_, index) => {
      const date = new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10);
      return { title: date, kind: 'date', date, nodes: [{ title: `Entry ${index + 1}` }] };
    });
    await writeFile(normalized, JSON.stringify(normalizedSource([], sections)), 'utf8');
    await runHelper([
      'normalized', normalized,
      '--out', output.changeSet,
      '--evidence-out', output.evidence,
    ]);

    const changeSet = await json(output.changeSet) as ChangeSetView;
    expect(Value.Check(ChangeSetSchema, changeSet)).toBe(true);
    expect(changeSet.operations.filter((operation) => operation.op === 'ensure' && operation.resource === 'date'))
      .toHaveLength(100);
    expect(changeSet.operations.filter((operation) => operation.op === 'create')).toHaveLength(100);

    changeSet.operations.push({ op: 'create' });
    await writeFile(output.changeSet, JSON.stringify(changeSet), 'utf8');
    const failed = await runHelper(['check-coverage', output.evidence, '--changeset', output.changeSet])
      .then(() => null, (error: { stderr?: string }) => error.stderr ?? '');
    expect(failed).toContain('fingerprint does not match');
  });

  test('verifies settlement against the reviewed Diff and performs an independent read', async () => {
    const directory = await temporaryDirectory('outline-import-verify-');
    const output = artifactPaths(directory);
    const normalized = path.join(directory, 'normalized.json');
    await writeFile(normalized, JSON.stringify(normalizedSource([
      { title: 'Verified root', children: [{ title: 'Verified child' }] },
    ])), 'utf8');
    await runHelper([
      'normalized', normalized,
      '--out', output.changeSet,
      '--evidence-out', output.evidence,
    ]);

    const changeSet = await json(output.changeSet) as ChangeSetView;
    const evidence = await json(output.evidence) as Evidence;
    const verification = evidence.verification[0]!;
    const rootId = 'node:verified-root';
    const affectedIds = Array.from(
      { length: verification.expectedNodeCount },
      (_, index) => index === 0 ? rootId : `node:verified-child-${index}`,
    );
    const diff = {
      kind: 'outline.diff',
      diffHash: 'd'.repeat(64),
      changeSetHash: 'c'.repeat(64),
      normalizedChangeSet: changeSet,
      bindings: { [verification.binding]: [rootId] },
      affected: affectedIds.map((id) => ({ id })),
    };
    const operation = {
      kind: 'outline.operation',
      operationId: 'operation:verified-import',
      changeSetHash: diff.changeSetHash,
      diffHash: diff.diffHash,
      affectedNodeIds: affectedIds,
      affectedNodeCount: affectedIds.length,
      affectedNodeIdsHash: canonicalSha256(affectedIds),
      revisionAfter: 1,
      result: [{
        projection: changeSet.return?.[0],
        revision: 1,
        nodes: affectedIds.map((id) => ({ id })),
      }],
    };
    const diffFile = path.join(directory, 'diff.json');
    const operationFile = path.join(directory, 'operation.json');
    const launcher = path.join(directory, 'outline');
    const calls = path.join(directory, 'outline-calls.txt');
    await writeFile(diffFile, JSON.stringify(diff), 'utf8');
    await writeFile(operationFile, JSON.stringify({ data: operation }), 'utf8');
    await writeFile(launcher, [
      '#!/bin/sh',
      'set -eu',
      'printf "%s\\n" "$3" >> "$OUTLINE_TEST_CALL_LOG"',
      'printf \'{"ok":true,"data":{"nodes":[{"id":"%s"}]}}\\n\' "$3"',
      '',
    ].join('\n'), 'utf8');
    await chmod(launcher, 0o755);

    const result = await runHelper([
      'verify-result', operationFile,
      '--evidence', output.evidence,
      '--diff', diffFile,
      '--outline-bin', launcher,
    ], { OUTLINE_TEST_CALL_LOG: calls });
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      operationId: operation.operationId,
      affectedNodeCount: affectedIds.length,
      verificationReads: [{ selector: rootId, nodeId: rootId }],
    });
    expect((await readFile(calls, 'utf8')).trim()).toBe(rootId);
  });
});

interface Evidence {
  coverage: { unaccounted: number };
  stats: { sourceRecords: number; nodes: number; fields: number; tags: number };
  mode: string;
  dates: string[];
  warnings: Array<{ code: string; count?: number }>;
  expectedCreatedNodes: number;
  verification: Array<{ binding: string; kind: string; expectedNodeCount: number }>;
}

interface ChangeSetView {
  operations: Array<Record<string, unknown>>;
  return?: Array<Record<string, unknown>>;
}

function normalizedSource(
  nodes: Array<Record<string, unknown>>,
  sections: Array<Record<string, unknown>> = [{ title: 'Imported', kind: 'library', nodes }],
) {
  const nodeCount = sections.reduce((total, section) => total + countNodes(section.nodes), 0);
  return {
    version: 1,
    source: { kind: 'normalized', path: '/source/normalized.json' },
    options: { fidelity: 'clean', dateGrouping: 'native_daily', tags: true, fields: 'text_children', doneState: true },
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
    coverage: { imported: nodeCount, merged: 0, dropped: 0, unsupported: 0, empty: 0, unaccounted: 0 },
    warnings: [],
    sections,
  };
}

function countNodes(value: unknown): number {
  if (!Array.isArray(value)) return 0;
  return value.reduce((total, item) => {
    const node = item && typeof item === 'object' ? item as { children?: unknown } : {};
    return total + 1 + countNodes(node.children);
  }, 0);
}

function runHelper(args: string[], env?: Readonly<Record<string, string>>) {
  return execFile('bun', [helper, ...args], {
    env: { ...process.env, ...env },
  });
}

async function temporaryDirectory(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

function artifactPaths(directory: string) {
  return {
    changeSet: path.join(directory, 'changeset.json'),
    evidence: path.join(directory, 'evidence.json'),
    coverage: path.join(directory, 'coverage.json'),
  };
}

async function json(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, 'utf8')) as unknown;
}
