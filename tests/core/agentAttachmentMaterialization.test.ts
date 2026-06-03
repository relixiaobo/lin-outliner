import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { formatFileReferenceMarker, splitFileReferenceMarkers } from '../../src/core/referenceMarkup';
import {
  materializeFileReferenceMarkersInText,
  materializeFileReferenceMarkersInValue,
} from '../../src/main/agentAttachmentMaterialization';

describe('agent attachment materialization', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
    roots.length = 0;
  });

  test('rewrites file markers to materialized paths under localRoot', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-attachment-root-'));
    const sourceRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-attachment-source-'));
    roots.push(localRoot, sourceRoot);
    const sourcePath = path.join(sourceRoot, 'report.pdf');
    await writeFile(sourcePath, 'report body');

    const text = `Read ${formatFileReferenceMarker('../report.pdf', sourcePath)}.`;
    const rewritten = await materializeFileReferenceMarkersInText(localRoot, text);
    const marker = splitFileReferenceMarkers(rewritten).find((segment) => segment.type === 'file');

    expect(marker?.path).toStartWith(path.join(localRoot, 'tmp', 'agent-attachments'));
    expect(marker?.path).not.toBe(sourcePath);
    expect(marker?.label).toBe('../report.pdf');
    expect(path.basename(marker?.path ?? '')).not.toContain('..');
    expect(await readFile(marker!.path, 'utf8')).toBe('report body');
  });

  test('recursively rewrites file markers inside tool payload values', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-attachment-root-'));
    const sourceRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-attachment-source-'));
    roots.push(localRoot, sourceRoot);
    const sourcePath = path.join(sourceRoot, 'notes.txt');
    await writeFile(sourcePath, 'notes body');

    const value = {
      title: `Review ${formatFileReferenceMarker('notes.txt', sourcePath)}`,
      items: [{ outline: `- ${formatFileReferenceMarker('notes.txt', sourcePath)}` }],
    };
    const rewritten = await materializeFileReferenceMarkersInValue(localRoot, value);

    expect(rewritten.title).not.toContain(encodeURIComponent(sourcePath));
    const titleMarker = splitFileReferenceMarkers(rewritten.title).find((segment) => segment.type === 'file');
    const outlineMarker = splitFileReferenceMarkers(rewritten.items[0]!.outline).find((segment) => segment.type === 'file');
    expect(titleMarker?.path).toBe(outlineMarker?.path);
    expect(await readFile(titleMarker!.path, 'utf8')).toBe('notes body');
  });
});
