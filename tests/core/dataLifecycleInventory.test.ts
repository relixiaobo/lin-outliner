import { describe, expect, test } from 'bun:test';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import ts from 'typescript';

async function sourceFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(path));
    else if (entry.name.endsWith('.ts')) files.push(path);
  }
  return files;
}

describe('executable data owner inventory', () => {
  test('every Agent or ContentStore schema is shared with compatibility inspection', async () => {
    const registryPath = resolve('src/main/dataLifecycle/storeRegistry.ts');
    const source = ts.createSourceFile(registryPath, await readFile(registryPath, 'utf8'), ts.ScriptTarget.Latest, true);
    const registered = new Set(source.statements.flatMap((statement) => ts.isImportDeclaration(statement)
      && ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text.endsWith('.schema')
      ? [resolve(dirname(registryPath), `${statement.moduleSpecifier.text}.ts`)] : []));
    const violations: string[] = [];
    for (const path of [...await sourceFiles('src/main/agent'), ...await sourceFiles('src/content')]) {
      const content = await readFile(path, 'utf8');
      if (!/\bCREATE\s+TABLE\b/i.test(content)) continue;
      if (!path.endsWith('.schema.ts')) violations.push(`${path}: schema must be declared independently of normal construction`);
      else if (!registered.has(resolve(path))) violations.push(`${path}: missing physical compatibility owner`);
    }
    expect(violations).toEqual([]);
  });
});
