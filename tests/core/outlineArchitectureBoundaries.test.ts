import { describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';

const repoRoot = path.resolve(import.meta.dir, '..', '..');
const sourceRoot = path.join(repoRoot, 'src');

describe('Outline process dependency boundaries', () => {
  test('keeps the CLI and shared client independent from document authority', async () => {
    const files = await sourceFiles([
      path.join(sourceRoot, 'outline', 'cli'),
      path.join(sourceRoot, 'outline', 'client'),
    ]);
    const forbidden = [
      path.join(sourceRoot, 'core'),
      path.join(sourceRoot, 'main'),
      path.join(sourceRoot, 'renderer'),
      path.join(sourceRoot, 'preload'),
      path.join(sourceRoot, 'outline', 'runtime'),
    ];

    expect(await forbiddenImports(files, ({ resolved }) => (
      resolved !== null && forbidden.some((root) => within(resolved, root))
    ))).toEqual([]);
  });

  test('keeps Runtime independent from Electron, renderer, Agent, CLI, and Skills', async () => {
    const files = await sourceFiles([path.join(sourceRoot, 'outline', 'runtime')]);
    const forbidden = [
      path.join(sourceRoot, 'main'),
      path.join(sourceRoot, 'renderer'),
      path.join(sourceRoot, 'preload'),
      path.join(sourceRoot, 'outline', 'cli'),
    ];

    expect(await forbiddenImports(files, ({ specifier, resolved }) => (
      specifier === 'electron'
      || (resolved !== null && forbidden.some((root) => within(resolved, root)))
    ))).toEqual([]);
  });

  test('keeps desktop processes outside Core and Runtime storage authority', async () => {
    const files = await sourceFiles([
      path.join(sourceRoot, 'main'),
      path.join(sourceRoot, 'renderer'),
      path.join(sourceRoot, 'preload'),
    ]);
    const forbiddenDirectories = [path.join(sourceRoot, 'outline', 'runtime')];
    const forbiddenModules = [
      path.join(sourceRoot, 'core', 'core'),
      path.join(sourceRoot, 'core', 'loroDocument'),
      path.join(sourceRoot, 'core', 'operationJournal'),
      path.join(sourceRoot, 'main', 'documentService'),
      path.join(sourceRoot, 'main', 'workspacePersistenceStore'),
      path.join(sourceRoot, 'main', 'workspaceSaver'),
      path.join(sourceRoot, 'main', 'assetService'),
    ];

    expect(await forbiddenImports(files, ({ resolved }) => {
      if (resolved === null) return false;
      const withoutExtension = resolved.replace(/\.(?:[cm]?[jt]sx?)$/, '');
      return forbiddenDirectories.some((root) => within(resolved, root))
        || forbiddenModules.includes(withoutExtension);
    })).toEqual([]);
  });
});

interface ImportRecord {
  readonly file: string;
  readonly specifier: string;
  readonly resolved: string | null;
}

async function forbiddenImports(
  files: readonly string[],
  forbidden: (record: ImportRecord) => boolean,
): Promise<string[]> {
  const failures: string[] = [];
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    for (const specifier of moduleSpecifiers(file, source)) {
      const resolved = specifier.startsWith('.') ? path.resolve(path.dirname(file), specifier) : null;
      const record = { file, specifier, resolved };
      if (forbidden(record)) failures.push(`${path.relative(repoRoot, file)} -> ${specifier}`);
    }
  }
  return failures.sort();
}

function moduleSpecifiers(file: string, source: string): string[] {
  const parsed = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    false,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const result: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier
      && ts.isStringLiteral(node.moduleSpecifier)) {
      result.push(node.moduleSpecifier.text);
    } else if (ts.isImportEqualsDeclaration(node)
      && ts.isExternalModuleReference(node.moduleReference)
      && node.moduleReference.expression
      && ts.isStringLiteral(node.moduleReference.expression)) {
      result.push(node.moduleReference.expression.text);
    } else if (ts.isCallExpression(node)
      && node.arguments.length > 0
      && ts.isStringLiteral(node.arguments[0]!)
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      result.push(node.arguments[0]!.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return result;
}

async function sourceFiles(roots: readonly string[]): Promise<string[]> {
  const result: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile() && /\.[cm]?[jt]sx?$/.test(entry.name)) result.push(target);
    }
  };
  for (const root of roots) await visit(root);
  return result.sort();
}

function within(target: string, root: string): boolean {
  return target === root || target.startsWith(`${root}${path.sep}`);
}
