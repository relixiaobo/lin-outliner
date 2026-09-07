import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

describe('execution ownership', () => {
  test('keeps retired directory authorities out of production readers and stable prompt inputs', () => {
    const root = path.resolve(import.meta.dir, '../..');
    const files = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const file = path.join(directory, entry.name);
      return entry.isDirectory() ? files(file) : /\.tsx?$/.test(file) ? [file] : [];
    });
    const forbidden = new Set(['AgentStartupContextStore', 'AgentStartupContextResolver', 'resolveAgentStartupContext',
      'resolveRootWorkspace', 'cleanupRootWorkspace', 'ownsRootWorkspace', 'defaultWorkspaceRef',
      'resolveAgentConversationWorkspace', 'removeAgentConversationWorkspace', 'startupContextBlocks']);
    const failures: string[] = [];
    for (const file of files(path.join(root, 'src'))) {
      const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node) => {
        if (ts.isIdentifier(node) && forbidden.has(node.text)) failures.push(`${path.relative(root, file)}: ${node.text}`);
        if (ts.isInterfaceDeclaration(node) && ['Thread', 'ThreadStartRequest', 'RendererThreadStartRequest'].includes(node.name.text)) {
          for (const member of node.members) {
            if (member.name && ['cwd', 'workdir', 'workspace', 'taskTarget'].includes(member.name.getText(source))) {
              failures.push(`${node.name.text}.${member.name.getText(source)}`);
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(failures).toEqual([]);
    const metadata = readFileSync(path.join(root, 'src/main/agent/persistence/ThreadMetadataStore.ts'), 'utf8');
    expect(metadata).not.toMatch(/\bcwd\b/);
    const prompt = readFileSync(path.join(root, 'src/main/agent/context/stablePrompt.ts'), 'utf8');
    expect(prompt).not.toContain('repository-startup');
    expect(prompt).not.toContain('Thread working directory');
  });
});
