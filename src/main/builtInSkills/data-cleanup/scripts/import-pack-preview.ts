#!/usr/bin/env bun
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { optionValue, readJson, requiredArg, validateImportPackShape, type ImportNode, type ImportPack } from './import-pack-lib';

const USAGE = 'Usage: bun import-pack-preview.ts <pack.json> --out <preview.md> [--samples 8]';

async function main() {
  const args = process.argv.slice(2);
  const packFile = requiredArg(args, 0, USAGE);
  const out = optionValue(args, '--out');
  if (!out) throw new Error(USAGE);
  const samples = clampNumber(Number(optionValue(args, '--samples') ?? 8), 1, 50);
  const validation = validateImportPackShape(await readJson(packFile));
  if (!validation.ok) throw new Error(`Invalid Import Pack: ${validation.errors.join('; ')}`);
  const markdown = renderPreview(validation.pack, samples);
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, markdown, 'utf8');
  console.log(JSON.stringify({ ok: true, out, stats: validation.pack.stats, warnings: validation.pack.warnings }, null, 2));
}

function renderPreview(pack: ImportPack, sampleLimit: number): string {
  const lines: string[] = [
    `# Import Preview: ${pack.source.kind}`,
    '',
    `Source: ${pack.source.path}`,
    '',
    '## Stats',
    '',
    `- Source records: ${pack.stats.sourceRecords}`,
    `- Sections: ${pack.stats.sections}`,
    `- Nodes: ${pack.stats.nodes}`,
    `- Descriptions: ${pack.stats.descriptions}`,
    `- Tags: ${pack.stats.tags}`,
    `- Fields: ${pack.stats.fields}`,
    `- Checked tasks: ${pack.stats.checked}`,
    `- Dropped records: ${pack.stats.dropped}`,
    '',
    '## Coverage',
    '',
    `- Imported: ${pack.coverage.imported}`,
    `- Merged: ${pack.coverage.merged}`,
    `- Dropped: ${pack.coverage.dropped}`,
    `- Unsupported: ${pack.coverage.unsupported}`,
    `- Empty: ${pack.coverage.empty}`,
    `- Unaccounted: ${pack.coverage.unaccounted}`,
  ];
  if (pack.coverage.entriesFile) lines.push(`- Entries file: ${pack.coverage.entriesFile}`);
  lines.push('', '## Warnings', '');
  if (pack.warnings.length === 0) lines.push('- None');
  for (const warning of pack.warnings.slice(0, 20)) {
    lines.push(`- ${warning.code}: ${warning.message}${warning.count === undefined ? '' : ` (${warning.count})`}`);
  }
  lines.push('', '## Sections', '');
  for (const section of pack.sections) {
    lines.push(`- ${section.title}: ${countNodes(section.nodes)} node(s)`);
  }
  lines.push('', '## Representative Nodes', '');
  const samples = pack.sections.flatMap((section) => section.nodes.map((node) => ({ section: section.title, node }))).slice(0, sampleLimit);
  for (const sample of samples) {
    lines.push(`### ${sample.node.title}`);
    lines.push('');
    lines.push(`Section: ${sample.section}`);
    if (sample.node.description) lines.push(`Description: ${sample.node.description.slice(0, 300)}`);
    if (sample.node.tags?.length) lines.push(`Tags: ${sample.node.tags.join(', ')}`);
    if (sample.node.fields?.length) lines.push(`Fields: ${sample.node.fields.map((field) => field.name).join(', ')}`);
    if (sample.node.children?.length) lines.push(`Children: ${sample.node.children.length}`);
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

function countNodes(nodes: readonly ImportNode[]): number {
  let count = 0;
  for (const node of nodes) {
    count += 1;
    count += countNodes(node.children ?? []);
  }
  return count;
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
