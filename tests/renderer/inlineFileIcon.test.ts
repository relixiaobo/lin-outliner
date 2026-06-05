import { describe, expect, test } from 'bun:test';
import type { DOMOutputSpec } from 'prosemirror-model';
import { pmSchema } from '../../src/renderer/ui/editor/pmSchema';
import { inlineFileIconKind } from '../../src/renderer/ui/editor/inlineFileIcon';

describe('inlineFileIconKind', () => {
  test('maps entry kind, mime type, and extension to the shared icon taxonomy', () => {
    expect(inlineFileIconKind({ entryKind: 'directory' })).toBe('folder');
    expect(inlineFileIconKind({ mimeType: 'inode/directory' })).toBe('folder');
    expect(inlineFileIconKind({ mimeType: 'image/png', name: 'shot.png' })).toBe('image');
    expect(inlineFileIconKind({ mimeType: 'application/octet-stream', name: 'diagram.png' })).toBe('image');
    expect(inlineFileIconKind({ mimeType: 'audio/mpeg', name: 'song.mp3' })).toBe('audio');
    expect(inlineFileIconKind({ name: 'sheet.csv' })).toBe('spreadsheet');
    expect(inlineFileIconKind({ name: 'main.ts' })).toBe('code');
    expect(inlineFileIconKind({ name: 'report.pdf' })).toBe('text');
  });
});

describe('outliner inlineReference toDOM', () => {
  const toDOM = pmSchema.nodes.inlineReference.spec.toDOM;
  const render = (attrs: Record<string, unknown>): DOMOutputSpec[] => {
    const spec = toDOM?.(pmSchema.nodes.inlineReference.create(attrs)) as DOMOutputSpec[];
    return spec;
  };

  test('a local-file reference prepends the shared monochrome file icon, name in its own span', () => {
    const spec = render({
      targetKind: 'local-file',
      targetPath: '/Users/me/Projects',
      entryKind: 'directory',
      displayName: 'Projects',
    });
    // ['span', attrs, iconSpec, nameSpec] — the name lives in its own span so the
    // mention can be white-space: nowrap without freezing the name's wrapping.
    const [, , iconSpec, nameSpec] = spec as [
      string,
      Record<string, string>,
      [string, Record<string, string>],
      [string, Record<string, string>, string],
    ];
    expect(iconSpec[1].class).toBe('inline-ref-file-icon');
    expect(iconSpec[1]['data-file-icon-kind']).toBe('folder');
    expect(nameSpec[1].class).toBe('inline-ref-file-name');
    expect(nameSpec[2]).toBe('Projects');
  });

  test('a node reference is plain text with no icon', () => {
    const spec = render({ targetKind: 'node', targetNodeId: 'n1', displayName: 'Alpha' });
    // ['span', attrs, label] — no icon child
    expect(spec).toHaveLength(3);
    expect(spec[2]).toBe('Alpha');
  });
});
