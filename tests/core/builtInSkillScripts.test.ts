import { describe, expect, test } from 'bun:test';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const root = path.resolve(import.meta.dir, '..', '..');
const dataCleanupSkillRoot = path.join(root, 'src', 'main', 'builtInSkills', 'data-cleanup');
const tenonImportTool = path.join(dataCleanupSkillRoot, 'scripts', 'tenon-import.ts');

describe('built-in skill helper scripts', () => {
  test('data-cleanup Tana adapter emits a validated Import Pack preview', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lin-data-cleanup-tana-'));
    const fixture = path.join(dataCleanupSkillRoot, 'fixtures', 'tana-fields-and-tags.json');
    const packFile = path.join(dir, 'pack.json');
    const coverageFile = path.join(dir, 'coverage.json');
    const validationFile = path.join(dir, 'validation.json');
    const previewFile = path.join(dir, 'preview.md');

    await execFile('bun', [tenonImportTool, 'tana', fixture, '--out', packFile, '--coverage-out', coverageFile, '--fidelity', 'full']);
    await execFile('bun', [tenonImportTool, 'validate', packFile, '--out', validationFile]);
    await execFile('bun', [tenonImportTool, 'preview', packFile, '--out', previewFile, '--offline-preview']);

    const pack = JSON.parse(await readFile(packFile, 'utf8'));
    const coverage = JSON.parse(await readFile(coverageFile, 'utf8'));
    const validation = JSON.parse(await readFile(validationFile, 'utf8'));
    const preview = await readFile(previewFile, 'utf8');

    expect(pack).toMatchObject({
      version: 1,
      source: { kind: 'tana' },
      stats: {
        sourceRecords: 14,
        sections: 1,
        nodes: 4,
        descriptions: 1,
        tags: 1,
        fields: 1,
        checked: 1,
        dropped: 4,
      },
      coverage: { unaccounted: 0 },
    });
    expect(pack.sections[0].nodes[0].children[0].fields).toEqual([{
      name: 'Status',
      values: ['Active', 'Review'],
    }]);
    expect(Array.isArray(coverage)).toBe(true);
    expect(coverage).toHaveLength(pack.stats.sourceRecords);
    expect(coverage.every((entry: { status?: string }) => entry.status !== 'unaccounted')).toBe(true);
    expect(validation).toMatchObject({ ok: true, stats: pack.stats, warnings: pack.warnings });
    expect(preview).toContain('# Import Preview: tana');
    expect(preview).toContain('Unaccounted: 0');
    expect(preview).toContain('Fields: 1');
    expect(preview).toContain('Home');
    expect(preview).toContain('trash_node');
  });

  test('data-cleanup preview requires the running app import API by default', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lin-data-cleanup-api-required-'));
    const fixture = path.join(dataCleanupSkillRoot, 'fixtures', 'tana-minimal.json');
    const packFile = path.join(dir, 'pack.json');
    const previewFile = path.join(dir, 'preview.md');

    await execFile('bun', [tenonImportTool, 'tana', fixture, '--out', packFile]);
    const failed = await execFile('bun', [tenonImportTool, 'preview', packFile, '--out', previewFile])
      .then(
        () => null,
        (error: { stdout?: string }) => JSON.parse(error.stdout ?? '{}') as { ok?: boolean; error?: { code?: string } },
      );

    expect(failed).toMatchObject({
      ok: false,
      error: { code: 'app_unavailable' },
    });
  });
});
