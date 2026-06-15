import { describe, expect, test } from 'bun:test';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const root = path.resolve(import.meta.dir, '..', '..');
const markdownTool = path.join(root, 'src', 'main', 'builtInSkills', 'document', 'scripts', 'markdown_tool.mjs');

describe('built-in skill helper scripts', () => {
  test('document markdown inspector allows ordinary external source links', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lin-doc-skill-markdown-'));
    const input = path.join(dir, 'brief.md');
    const out = path.join(dir, 'report.json');
    await writeFile(input, [
      '# Decision Brief',
      '',
      '## Recommendation',
      '',
      'Use portable skills for repeated workflows. See [source](https://example.com/spec).',
      '',
    ].join('\n'), 'utf8');

    await execFile('node', [markdownTool, 'inspect', input, '--out', out]);
    const report = JSON.parse(await readFile(out, 'utf8'));

    expect(report).toMatchObject({
      ok: true,
      warnings: [],
      external_references: ['https://example.com/spec'],
      remote_image_references: [],
    });
  });

  test('document markdown inspector flags remote image dependencies', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lin-doc-skill-remote-image-'));
    const input = path.join(dir, 'brief.md');
    const out = path.join(dir, 'report.json');
    await writeFile(input, [
      '# Decision Brief',
      '',
      '## Evidence',
      '',
      '![Chart](https://example.com/chart.png)',
      '',
    ].join('\n'), 'utf8');

    await expect(execFile('node', [markdownTool, 'inspect', input, '--out', out])).rejects.toThrow();
    const report = JSON.parse(await readFile(out, 'utf8'));

    expect(report).toMatchObject({
      ok: false,
      warnings: ['remote_image_reference_found'],
      external_references: ['https://example.com/chart.png'],
      remote_image_references: ['https://example.com/chart.png'],
    });
  });
});
