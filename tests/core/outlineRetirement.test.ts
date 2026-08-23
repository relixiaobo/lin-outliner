import { describe, expect, test } from 'bun:test';
import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dir, '..', '..');
const implementationPlan = path.join(repoRoot, 'docs', 'plans', 'outliner-runtime-cli.md');
const retiredTokens = [
  ...[
    ['node', 'search'],
    ['node', 'read'],
    ['node', 'create'],
    ['node', 'edit'],
    ['node', 'delete'],
    ['outline', 'undo', 'stack'],
  ].map((parts) => parts.join('_')),
  ['tenon', 'import'].join('-'),
  ['Agent', 'Import', 'Service'].join(''),
  ['Agent', 'Import', 'Api', 'Server'].join(''),
  ['Import', 'Pack'].join(''),
  ['TENON', 'IMPORT'].join('_'),
  ['tenon', 'Import'].join(''),
];

describe('Outline legacy surface retirement', () => {
  test('keeps the live source, test, package, and specification queue empty', async () => {
    const files = await textFiles([
      path.join(repoRoot, 'src'),
      path.join(repoRoot, 'tests'),
      path.join(repoRoot, 'scripts'),
      path.join(repoRoot, 'package.json'),
      path.join(repoRoot, 'docs', 'spec'),
      path.join(repoRoot, 'docs', 'plans', 'reference'),
    ]);
    const failures: string[] = [];
    for (const file of files) {
      if (file === implementationPlan) continue;
      const content = await readFile(file, 'utf8');
      for (const token of retiredTokens) {
        if (content.includes(token)) failures.push(`${path.relative(repoRoot, file)}: ${token}`);
      }
    }
    expect(failures.sort()).toEqual([]);
  });

  test('does not restore deleted document authorities or import resources', async () => {
    const retiredPaths = [
      ['src', 'core', 'documentSystem.ts'],
      ['src', 'main', 'documentService.ts'],
      ['src', 'main', 'workspacePersistenceStore.ts'],
      ['src', 'main', 'workspaceSaver.ts'],
      ['src', 'main', 'assetService.ts'],
      ['src', 'main', ['tenon', 'Import', 'Protocol.ts'].join('')],
      ['src', 'main', ['tenon', 'Import', 'Runtime.ts'].join('')],
      ['src', 'main', ['tenon', 'Import', 'ShellEnvironment.ts'].join('')],
      ['src', 'main', ['tenon', 'Import', 'ResourceNames.json'].join('')],
      ['src', 'main', 'agent', 'capabilities', 'agentNodeToolTypes.ts'],
      ['src', 'main', 'agent', 'capabilities', 'agentNodeTools.ts'],
      ['src', 'main', 'agent', 'capabilities', 'agentImportService.ts'],
      ['src', 'main', 'agent', 'capabilities', 'agentImportApi.ts'],
      ['src', 'main', 'agent', 'capabilities', ['agentData', 'Import', 'Pack.ts'].join('')],
      ['src', 'main', 'builtInSkills', ['tenon', 'import'].join('-')],
    ].map((segments) => path.join(repoRoot, ...segments));

    expect((await Promise.all(retiredPaths.map(async (target) => (
      await lstat(target).then(() => path.relative(repoRoot, target)).catch((error: unknown) => (
        isNotFound(error) ? null : Promise.reject(error)
      ))
    )))).filter((value) => value !== null)).toEqual([]);
  });
});

const TEXT_EXTENSIONS = new Set(['.cjs', '.js', '.json', '.md', '.mjs', '.sh', '.ts', '.tsx']);

async function textFiles(roots: readonly string[]): Promise<string[]> {
  const result: string[] = [];
  const visit = async (target: string): Promise<void> => {
    const value = await lstat(target);
    if (value.isFile()) {
      if (TEXT_EXTENSIONS.has(path.extname(target))) result.push(target);
      return;
    }
    if (!value.isDirectory()) return;
    for (const entry of await readdir(target, { withFileTypes: true })) {
      if (entry.name === 'archive' || entry.name === '.out') continue;
      await visit(path.join(target, entry.name));
    }
  };
  for (const root of roots) await visit(root);
  return result.sort();
}

function isNotFound(error: unknown): boolean {
  return Boolean(error) && typeof error === 'object' && (error as { code?: unknown }).code === 'ENOENT';
}
