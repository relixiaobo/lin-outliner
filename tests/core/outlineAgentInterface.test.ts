import { describe, expect, test } from 'bun:test';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import {
  OUTLINE_CAPABILITIES,
  OUTLINE_RECIPES,
  compactOutlineSchema,
  outlineCapability,
  outlineRecipe,
} from '../../src/outline/contract';
import { runOutlineCli } from '../../src/outline/cli';
import { buildPorcelainRequest } from '../../src/outline/cli/porcelain';
import { renderFailureSummary, renderSummaryResult } from '../../src/outline/cli/presentation';

const root = path.resolve(import.meta.dir, '..', '..');

describe('Outline Agent interface contract', () => {
  test('serves bounded registry-owned executable recipes without Runtime', async () => {
    for (const recipe of OUTLINE_RECIPES) {
      let stdout = '';
      let stderr = '';
      const code = await runOutlineCli(['example', ...recipe.command.split(' '), recipe.variant], {
        runtimeRoot: path.join(root, 'tmp', 'unused-outline-recipe-runtime'),
        io: {
          stdout: (value) => { stdout += value; },
          stderr: (value) => { stderr += value; },
        },
      });
      expect(code, `${recipe.command} ${recipe.variant}`).toBe(0);
      expect(stderr).toBe('');
      expect(Buffer.byteLength(stdout)).toBeLessThanOrEqual(4 * 1024);
      expect(stdout).toContain(`Command: ${recipe.invocation}`);
      expect(stdout).toContain(`Result: ${recipe.receipt} receipt`);
      if (recipe.stdin !== undefined) expect(stdout).toContain(recipe.stdin);
    }
  });

  test('reports bounded schema sizes and keeps exact authoring schemas free of recursive selectors', () => {
    const schemaReport = OUTLINE_CAPABILITIES.map((capability) => {
      const schema = compactOutlineSchema(capability.porcelain?.inputSchema ?? capability.requestSchema);
      return { command: capability.name, bytes: Buffer.byteLength(JSON.stringify(schema)) };
    });
    expect(new Set(schemaReport.map((entry) => entry.command)).size).toBe(OUTLINE_CAPABILITIES.length);
    expect(schemaReport.reduce((total, entry) => total + entry.bytes, 0)).toBeLessThanOrEqual(1_500_000);
    for (const entry of schemaReport) {
      const budget = ['diff', 'commit', 'apply'].includes(entry.command) ? 128 * 1024 : 64 * 1024;
      expect(entry.bytes, entry.command).toBeLessThanOrEqual(budget);
    }

    const exactCommands = [
      'indent', 'outdent', 'done cycle', 'definition configure', 'reference set',
      'reference replace', 'reference inline', 'reference restore', 'view set',
      'view group set', 'view sort add', 'view sort set', 'view sort remove',
      'view sort clear', 'view filter add', 'view filter set', 'view filter remove',
      'view filter clear', 'view display add', 'view display set', 'view display remove',
      'search ensure-tag', 'search refresh', 'template apply', 'source add',
      'source replace', 'source reorder', 'source remove', 'source clear', 'purge',
    ];
    for (const command of exactCommands) {
      const schema = compactOutlineSchema(outlineCapability(command)!.porcelain!.inputSchema);
      const encoded = JSON.stringify(schema);
      expect(encoded, command).not.toContain('QueryExpression');
      expect(encoded, command).not.toContain('TargetRef');
      expect(encoded, command).not.toContain('Selector');
      expect(Buffer.byteLength(encoded), command).toBeLessThanOrEqual(4 * 1024);
    }
    const add = JSON.stringify(compactOutlineSchema(outlineCapability('add')!.porcelain!.inputSchema));
    expect(add).not.toContain('TargetRef');
    expect(add).not.toContain('Selector');
    const bulk = JSON.stringify(compactOutlineSchema(outlineCapability('done set')!.porcelain!.inputSchema));
    expect(bulk).toContain('BoundedSelectionInput');
    expect(bulk).toContain('QueryExpression');
  });

  test('lowers exact view field locators without exposing generic TargetRef input', async () => {
    const request = await buildPorcelainRequest('view set', ['--input', '-'], {
      read: async () => JSON.stringify({
        target: 'node:owner',
        view: {
          group: 'sys:name',
          replace: {
            sort: [{ field: 'field:priority', direction: 'desc' }],
            display: [{ field: 'sys:updatedAt', visible: true }],
          },
        },
      }),
      lookup: async () => { throw new Error('lookup should not run'); },
      project: async () => { throw new Error('projection should not run'); },
      ingestAsset: async () => { throw new Error('asset ingest should not run'); },
    });
    const change = request.changeSet.operations[0] as {
      targets: unknown;
      changes: Array<{ view: { group: unknown; replace: { sort: Array<{ field: unknown }>; display: Array<{ field: unknown }> } } }>;
    };
    expect(change.targets).toEqual({
      target: { selector: { by: 'id', id: 'node:owner' }, cardinality: 'one' },
    });
    expect(change.changes[0]!.view.group).toBe('sys:name');
    expect(change.changes[0]!.view.replace.sort[0]!.field).toEqual({
      target: { selector: { by: 'id', id: 'field:priority' }, cardinality: 'one' },
    });
    expect(change.changes[0]!.view.replace.display[0]!.field).toBe('sys:updatedAt');
  });

  test('requires a receipt family and never emits the retired generic rerun response', () => {
    for (const capability of OUTLINE_CAPABILITIES) expect(capability.receipt, capability.name).toBeTruthy();
    const diff = renderSummaryResult('diff', {
      kind: 'outline.diff',
      diffHash: 'a'.repeat(64),
      changeSetHash: 'b'.repeat(64),
      baseRevision: 4,
      affected: [],
      bindings: {},
      destructive: [],
      warnings: [],
    });
    expect(diff).toContain(`Diff: ${'a'.repeat(64)}`);
    expect(diff).not.toContain('rerun with --json');
  });

  test('renders bounded actionable failure details without echoing rejected input', () => {
    const secret = 'never-echo-this-input';
    const output = renderFailureSummary({
      code: 'invalid_input',
      category: 'usage',
      message: 'Input does not match the add schema.',
      retryable: false,
      details: {
        validation: {
          issues: [{ path: '/placement/parent', schemaPath: '#/properties/placement', keyword: 'type', message: 'must be string' }],
          truncated: false,
        },
        rejectedInput: secret,
      },
      next: ['outline example add viewed-tree'],
    });
    expect(output).toContain('At /placement/parent: must be string');
    expect(output).toContain('Next: outline example add viewed-tree');
    expect(output).not.toContain(secret);
    expect(Buffer.byteLength(output)).toBeLessThanOrEqual(4 * 1024);
  });

  test('keeps the packaged Skill self-contained and byte-checks its viewed-tree example', async () => {
    const skillRoot = path.join(root, 'src', 'main', 'builtInSkills', 'outline');
    expect((await readdir(skillRoot)).sort()).toEqual(['SKILL.md']);
    const skill = await readFile(path.join(skillRoot, 'SKILL.md'), 'utf8');
    expect(Buffer.byteLength(skill)).toBeLessThanOrEqual(8 * 1024);
    expect(skill).not.toContain('references/');
    const block = skill.match(/```json\n([\s\S]*?)\n```/u)?.[1];
    expect(block).toBeDefined();
    expect(JSON.parse(block!)).toEqual(JSON.parse(outlineRecipe('add', 'viewed-tree')!.stdin!));
  });
});
