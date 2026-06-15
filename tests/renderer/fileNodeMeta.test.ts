import { describe, expect, test } from 'bun:test';
import type { NodeProjection } from '../../src/renderer/api/types';
import { fileNodeMeta, fileNodeTitle, formatBytes, type FileNode } from '../../src/renderer/ui/preview/fileNode';
import { getMessages } from '../../src/core/i18n';

// fileNodeMeta is exercised end-to-end only by two e2e cases, so its size/duration math
// (KB→GB rollover, the 0:01 / 1:00 boundary) could regress green. Assert it directly,
// against the real English labels so the composition (order, separator) is covered too.
const labels = getMessages('en').outliner.field.attachment;

function fileNode(overrides: Partial<NodeProjection>): FileNode {
  const node: NodeProjection = {
    id: 'file',
    children: [],
    content: { text: '', marks: [], inlineRefs: [] },
    tags: [],
    createdAt: 0,
    updatedAt: 0,
    locked: false,
    autoCollected: false,
    toolbarVisible: false,
    filterValues: [],
    ...overrides,
  };
  return node as FileNode;
}

describe('formatBytes', () => {
  test('guards non-positive and non-finite sizes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(-1)).toBe('0 B');
    expect(formatBytes(Number.NaN)).toBe('0 B');
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('0 B');
  });

  test('keeps raw bytes under 1 KiB', () => {
    expect(formatBytes(1)).toBe('1 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1023)).toBe('1023 B');
  });

  test('rolls up KB/MB/GB with one decimal below 10 and none at/above', () => {
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(5872)).toBe('5.7 KB');
    expect(formatBytes(10 * 1024)).toBe('10 KB');
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
    expect(formatBytes(1024 ** 3)).toBe('1.0 GB');
  });

  test('caps the unit ladder at GB (no TB rollover)', () => {
    expect(formatBytes(1024 ** 4)).toBe('1024 GB');
  });
});

describe('fileNodeMeta', () => {
  test('attachment: type · size · pages, in order', () => {
    const node = fileNode({ type: 'attachment', assetId: 'a', mimeType: 'application/pdf', fileSize: 1024, pdfPageCount: 3 });
    expect(fileNodeMeta(node, labels)).toBe([labels.pdf, '1.0 KB', labels.pages({ count: 3 })].join(' · '));
  });

  test('attachment: unknown mime falls back to the file label', () => {
    const node = fileNode({ type: 'attachment', assetId: 'a', mimeType: 'application/octet-stream', fileSize: 2048 });
    expect(fileNodeMeta(node, labels)).toBe([labels.file, '2.0 KB'].join(' · '));
  });

  test('attachment: audio duration uses m:ss across the 0:01 / 1:00 boundary', () => {
    const oneSecond = fileNode({ type: 'attachment', assetId: 'a', mimeType: 'audio/mpeg', audioDurationMs: 1000 });
    expect(fileNodeMeta(oneSecond, labels)).toBe([labels.audio, labels.duration({ duration: '0:01' })].join(' · '));
    const oneMinute = fileNode({ type: 'attachment', assetId: 'a', mimeType: 'audio/mpeg', audioDurationMs: 60_000 });
    expect(fileNodeMeta(oneMinute, labels)).toBe([labels.audio, labels.duration({ duration: '1:00' })].join(' · '));
  });

  test('attachment: video duration rolls over to h:mm:ss past an hour', () => {
    const node = fileNode({ type: 'attachment', assetId: 'a', mimeType: 'video/mp4', videoDurationMs: 3_661_000 });
    expect(fileNodeMeta(node, labels)).toBe([labels.video, labels.duration({ duration: '1:01:01' })].join(' · '));
  });

  test('image: dimensions when known, else null', () => {
    expect(fileNodeMeta(fileNode({ type: 'image', assetId: 'a', imageWidth: 600, imageHeight: 360 }), labels)).toBe('600 × 360');
    expect(fileNodeMeta(fileNode({ type: 'image', assetId: 'a' }), labels)).toBeNull();
  });
});

describe('fileNodeTitle', () => {
  test('prefers the node display text when present', () => {
    const node = fileNode({
      type: 'attachment',
      assetId: 'a',
      originalFilename: 'report.pdf',
      content: { text: 'Quarterly Report', marks: [], inlineRefs: [] },
    });
    expect(fileNodeTitle(node)).toBe('Quarterly Report');
  });

  test('falls back to the original attachment filename for blank legacy titles', () => {
    const node = fileNode({
      type: 'attachment',
      assetId: 'a',
      originalFilename: 'report.pdf',
      content: { text: '', marks: [], inlineRefs: [] },
    });
    expect(fileNodeTitle(node)).toBe('report.pdf');
  });

  test('falls back to the image source identity when no display name exists', () => {
    expect(fileNodeTitle(fileNode({
      type: 'image',
      mediaUrl: 'https://example.com/diagram.png',
      content: { text: '', marks: [], inlineRefs: [] },
    }))).toBe('https://example.com/diagram.png');
    expect(fileNodeTitle(fileNode({
      type: 'image',
      assetId: 'asset-image',
      content: { text: '', marks: [], inlineRefs: [] },
    }))).toBe('asset-image');
  });
});
