import { describe, expect, test } from 'bun:test';
import { classifyMediaPaste } from '../../src/renderer/ui/interactions/clipboardPaste';

function fileItem(file: File): DataTransferItem {
  return { kind: 'file', type: file.type, getAsFile: () => file } as unknown as DataTransferItem;
}

function stringItem(type: string): DataTransferItem {
  return { kind: 'string', type, getAsFile: () => null } as unknown as DataTransferItem;
}

function dataTransfer(parts: {
  items?: DataTransferItem[];
  files?: File[];
  text?: string;
}): DataTransfer {
  const text = parts.text ?? '';
  return {
    items: parts.items ?? [],
    files: parts.files ?? [],
    getData: (type: string) => (type === 'text/plain' ? text : ''),
  } as unknown as DataTransfer;
}

const png = () => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'shot.png', { type: 'image/png' });

describe('classifyMediaPaste', () => {
  test('image files win over accompanying filename text', () => {
    const file = png();
    const intent = classifyMediaPaste(
      dataTransfer({ items: [stringItem('text/plain'), fileItem(file)], text: 'shot.png' }),
      { hasSelection: false },
    );
    expect(intent).toEqual({ kind: 'images', files: [file] });
  });

  test('a lone remote image URL becomes a media-URL intent when there is no selection', () => {
    const intent = classifyMediaPaste(dataTransfer({ text: 'https://cdn.test/a.png' }), { hasSelection: false });
    expect(intent).toEqual({ kind: 'mediaUrl', url: 'https://cdn.test/a.png' });
  });

  test('an image URL with an active selection links the selection instead (linkUrl, not mediaUrl)', () => {
    const intent = classifyMediaPaste(dataTransfer({ text: 'https://cdn.test/a.png' }), { hasSelection: true });
    expect(intent).toEqual({ kind: 'linkUrl', url: 'https://cdn.test/a.png' });
  });

  test('a non-image single-line URL becomes a link intent regardless of selection', () => {
    expect(classifyMediaPaste(dataTransfer({ text: 'https://example.com/page' }), { hasSelection: false }))
      .toEqual({ kind: 'linkUrl', url: 'https://example.com/page' });
    expect(classifyMediaPaste(dataTransfer({ text: 'www.example.com/x' }), { hasSelection: true }))
      .toEqual({ kind: 'linkUrl', url: 'https://www.example.com/x' });
  });

  test('plain prose / multi-token text is not a media paste (caller handles structured/plain)', () => {
    expect(classifyMediaPaste(dataTransfer({ text: 'hello world' }), { hasSelection: false })).toBeNull();
    expect(classifyMediaPaste(dataTransfer({ text: 'see https://x.io/a.png now' }), { hasSelection: false })).toBeNull();
    expect(classifyMediaPaste(dataTransfer({ text: '' }), { hasSelection: false })).toBeNull();
    expect(classifyMediaPaste(null, { hasSelection: false })).toBeNull();
  });

  test('defaults to no-selection when options are omitted', () => {
    expect(classifyMediaPaste(dataTransfer({ text: 'https://cdn.test/a.png' })))
      .toEqual({ kind: 'mediaUrl', url: 'https://cdn.test/a.png' });
  });
});
