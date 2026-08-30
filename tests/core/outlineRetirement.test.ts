import { describe, expect, test } from 'bun:test';
import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dir, '..', '..');
const implementationPlan = path.join(repoRoot, 'docs', 'plans', 'outliner-runtime-cli.md');
const contentRoot = path.join(repoRoot, 'src', 'content');
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

  test('keeps shared content physical state private, neutral, and single-rooted', async () => {
    const contentFiles = await textFiles([contentRoot]);
    const dependencyFailures: string[] = [];
    for (const file of contentFiles) {
      const source = await readFile(file, 'utf8');
      for (const match of source.matchAll(/from\s+['"]([^'"]+)['"]/gu)) {
        const specifier = match[1]!;
        if (!specifier.startsWith('./') && !specifier.startsWith('node:')) {
          dependencyFailures.push(`${path.relative(repoRoot, file)}: ${specifier}`);
        }
      }
    }
    expect(dependencyFailures).toEqual([]);

    const contentSource = (await Promise.all(contentFiles.map((file) => readFile(file, 'utf8')))).join('\n');
    expect(contentSource).not.toContain(['content', 'sqlite'].join('.'));
    expect(contentSource).not.toContain("path.join(root, '" + ['revi', 'sions'].join('') + "')");
    expect(contentSource).not.toMatch(/(?:outline|agent|electron|renderer|core)\//u);

    const outlineHostSource = await readFile(
      path.join(repoRoot, 'src', 'main', 'hostDomain', 'outlineDesktopHost.ts'),
      'utf8',
    );
    expect(outlineHostSource).toContain("join(options.userDataDir, 'outline-runtime')");
    expect(outlineHostSource).toContain("join(options.userDataDir, 'content')");
    expect(outlineHostSource).not.toMatch(/dirname\(runtimeRoot\)/u);

    const assetStoreSource = await readFile(
      path.join(repoRoot, 'src', 'outline', 'runtime', 'storage', 'assetStore.ts'),
      'utf8',
    );
    const assetTypesSource = await readFile(
      path.join(repoRoot, 'src', 'outline', 'runtime', 'storage', 'assetTypes.ts'),
      'utf8',
    );
    expect(assetStoreSource).toContain("mkdtemp(path.join(tmpdir(), 'tenon-outline-pdf-thumbnail-'))");
    expect(assetStoreSource).not.toContain('mkdtemp(path.join(path.dirname(pdfPath)');
    expect(assetStoreSource).not.toContain('digest');
    expect(assetTypesSource).not.toContain('digest');
  });

  test('keeps retired asset paths, public deletion, and reference grammars absent', async () => {
    const files = await textFiles([
      path.join(repoRoot, 'src'),
      path.join(repoRoot, 'scripts'),
      path.join(repoRoot, 'docs', 'spec'),
    ]);
    const forbidden = [
      ['workspace', 'assets', 'blobs'].join('/'),
      ['delete', 'asset'].join('_'),
      ['file:', '^path'].join(''),
      ['kind:label', '^value'].join(''),
    ];
    const failures: string[] = [];
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      for (const token of forbidden) {
        if (source.includes(token)) failures.push(`${path.relative(repoRoot, file)}: ${token}`);
      }
    }
    expect(failures.sort()).toEqual([]);
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
