import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { DOMParser } from 'linkedom';
import { FILE_ICONS } from '../../src/renderer/ui/editor/fileIcons';
import { fileIconMaskSvg, generateFileIconMasks, FILE_ICON_MASK_PATH } from '../../scripts/generate-file-icon-masks';

test('committed masks match the semantic file components for every classified kind', () => {
  expect(readFileSync(FILE_ICON_MASK_PATH, 'utf8')).toBe(generateFileIconMasks());
  expect(Object.keys(FILE_ICONS).sort()).toEqual([
    'archive', 'audio', 'code', 'database', 'folder', 'image', 'presentation', 'spreadsheet', 'text', 'video',
  ]);
  for (const Icon of Object.values(FILE_ICONS)) {
    const source = fileIconMaskSvg(Icon);
    const svg = new DOMParser().parseFromString(source, 'image/svg+xml').documentElement;
    expect(svg.getAttribute('viewBox')).toBe('0 0 24 24');
    expect(svg.hasAttribute('width')).toBe(false);
    expect(svg.hasAttribute('height')).toBe(false);
    expect(svg.querySelectorAll('path,rect,circle,ellipse,line,polyline,polygon').length).toBeGreaterThan(0);
    expect(source).not.toMatch(/var\(|currentColor|class=|style=/);
    expect(svg.getAttribute('stroke-width')).toBe('1.5');
    expect(svg.querySelector('[stroke="black"]')).not.toBeNull();
  }
});
