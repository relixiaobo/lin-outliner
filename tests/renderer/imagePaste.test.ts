import { describe, expect, test } from 'bun:test';
import { clipboardImageFiles, imageUrlFromText, readPastedImages, shouldConvertRowToImage } from '../../src/renderer/ui/interactions/imagePaste';

function fileItem(file: File): DataTransferItem {
  return { kind: 'file', type: file.type, getAsFile: () => file } as unknown as DataTransferItem;
}

function stringItem(type: string): DataTransferItem {
  return { kind: 'string', type, getAsFile: () => null } as unknown as DataTransferItem;
}

function dataTransfer(parts: {
  items?: DataTransferItem[];
  files?: File[];
  types?: string[];
}): DataTransfer {
  return {
    items: parts.items ?? [],
    files: parts.files ?? [],
    types: parts.types ?? [],
  } as unknown as DataTransfer;
}

const png = () => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'shot.png', { type: 'image/png' });

describe('clipboardImageFiles', () => {
  test('extracts image files from clipboard items (the screenshot-paste path)', () => {
    const file = png();
    const found = clipboardImageFiles(dataTransfer({
      items: [stringItem('text/plain'), fileItem(file)],
      types: ['text/plain', 'Files'],
    }));
    expect(found).toEqual([file]);
  });

  test('falls back to .files when items carry no image (some sources only populate files)', () => {
    const file = png();
    const found = clipboardImageFiles(dataTransfer({ items: [], files: [file], types: ['Files'] }));
    expect(found).toEqual([file]);
  });

  test('ignores non-image files and plain text', () => {
    const pdf = new File([new Uint8Array([1])], 'doc.pdf', { type: 'application/pdf' });
    const found = clipboardImageFiles(dataTransfer({
      items: [fileItem(pdf), stringItem('text/plain')],
      files: [pdf],
    }));
    expect(found).toEqual([]);
  });

  test('returns empty for a null DataTransfer', () => {
    expect(clipboardImageFiles(null)).toEqual([]);
  });
});

describe('imageUrlFromText', () => {
  test('accepts a lone http(s) image URL (trimmed, case/query tolerant)', () => {
    expect(imageUrlFromText('https://example.com/a.png')).toBe('https://example.com/a.png');
    expect(imageUrlFromText('  http://x.io/p.JPG?v=2  ')).toBe('http://x.io/p.JPG?v=2');
    expect(imageUrlFromText('https://cdn.test/img.webp')).toBe('https://cdn.test/img.webp');
  });

  test('rejects non-image URLs, multi-token text, and non-URLs', () => {
    expect(imageUrlFromText('https://example.com/page')).toBeNull();
    expect(imageUrlFromText('see https://x.io/a.png now')).toBeNull();
    expect(imageUrlFromText('/local/a.png')).toBeNull();
    expect(imageUrlFromText('hello world')).toBeNull();
    expect(imageUrlFromText('')).toBeNull();
    expect(imageUrlFromText(null)).toBeNull();
  });
});

describe('shouldConvertRowToImage', () => {
  const base = { referenceLikeRow: false, nodeType: undefined as string | undefined, hasChildren: false, rowTextEmpty: true };

  test('converts a plain, empty, childless row in place', () => {
    expect(shouldConvertRowToImage(base)).toBe(true);
  });

  test('inserts as a sibling when the row already has text (never buries it)', () => {
    expect(shouldConvertRowToImage({ ...base, rowTextEmpty: false })).toBe(false);
  });

  test('always converts an existing image row, even if it carries hidden text', () => {
    expect(shouldConvertRowToImage({ ...base, nodeType: 'image', rowTextEmpty: false })).toBe(true);
  });

  test('never converts reference rows, rows with children, or non-image typed rows', () => {
    expect(shouldConvertRowToImage({ ...base, referenceLikeRow: true })).toBe(false);
    expect(shouldConvertRowToImage({ ...base, hasChildren: true })).toBe(false);
    expect(shouldConvertRowToImage({ ...base, nodeType: 'codeBlock' })).toBe(false);
  });
});

describe('readPastedImages', () => {
  test('reads file bytes, mime, and name into PastedImage payloads', async () => {
    const images = await readPastedImages([png()]);
    expect(images).toHaveLength(1);
    expect(images[0].mimeType).toBe('image/png');
    expect(images[0].name).toBe('shot.png');
    expect(Array.from(images[0].data)).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });
});
