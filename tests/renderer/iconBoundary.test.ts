import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

const renderer = join(import.meta.dir, '../../src/renderer');
function sourceFiles(path: string): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap(entry => {
    const child = join(path, entry.name);
    return entry.isDirectory() ? sourceFiles(child) : /\.tsx?$/.test(child) ? [child] : [];
  });
}

test('functional icon imports and geometry stay behind the semantic boundary', () => {
  const violations: string[] = [];
  // These are speaker identity artwork, not functional controls.
  const identitySvgOwners = new Set(['agent/components/AgentMark.tsx', 'agent/components/ThreadView.tsx']);
  for (const path of sourceFiles(renderer)) {
    const name = relative(renderer, path);
    const source = readFileSync(path, 'utf8');
    const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
    const report = (node: ts.Node, reason: string) => violations.push(`${name}:${ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1}: ${reason}`);
    const importedIcons = new Set<string>();
    for (const statement of ast.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const module = statement.moduleSpecifier.text;
      if (/lucide|iconoir/.test(module) && name !== 'ui/icons.ts') report(statement, 'Vendor import outside icons.ts');
      if (/\/icons$/.test(module)) {
        const bindings = statement.importClause?.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings)) report(statement, 'Runtime icon catalog import');
        if (bindings && ts.isNamedImports(bindings)) for (const specifier of bindings.elements) {
          if (!specifier.isTypeOnly && specifier.name.text.endsWith('Icon')) importedIcons.add(specifier.name.text);
        }
      }
    }
    const visit = (node: ts.Node) => {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tag = node.tagName.getText(ast);
        if (tag === 'svg' && !identitySvgOwners.has(name)) report(node, 'Inline functional SVG');
        if (importedIcons.has(tag) || tag === 'Icon' || tag === 'IconButton') {
          for (const attribute of node.attributes.properties) {
            if (!ts.isJsxAttribute(attribute)) continue;
            const prop = attribute.name.getText(ast);
            if (['width', 'height', 'strokeWidth', 'stroke', 'fill', 'transform', 'style'].includes(prop)) report(attribute, 'Consumer geometry override');
            if (['size', 'iconSize'].includes(prop) && attribute.initializer && ts.isJsxExpression(attribute.initializer)
              && attribute.initializer.expression && ts.isNumericLiteral(attribute.initializer.expression)) report(attribute, 'Numeric icon size');
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
  }
  expect(violations).toEqual([]);
  for (const name of ['types.ts', 'registry.ts', 'objects.ts']) {
    expect(readFileSync(join(renderer, '../core/actions', name), 'utf8')).not.toMatch(/\bIconId\b|\biconId\b|iconoir|lucide/);
  }
});
