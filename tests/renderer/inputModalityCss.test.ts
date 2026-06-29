import { describe, expect, test } from 'bun:test';

const baseCss = await Bun.file('src/renderer/styles/base.css').text();
const outlinerCss = await Bun.file('src/renderer/styles/outliner.css').text();
const filePreviewCss = await Bun.file('src/renderer/styles/file-preview.css').text();

describe('input modality CSS guards', () => {
  test('keeps the global text-control keyboard ring low-specificity', () => {
    expect(baseCss).toContain(':root[data-input-modality="keyboard"] :where(input:focus-visible, textarea:focus-visible, select:focus-visible)');
  });

  test('gates definition text input focus paint behind keyboard modality', () => {
    expect(outlinerCss).toContain(':root[data-input-modality="keyboard"] .definition-text-input.input-bare:focus-visible');
    expect(outlinerCss).not.toMatch(/(?:^|\n)\.definition-text-input\.input-bare:focus-visible\s*\{/);
  });

  test('keeps flat media previews visible and non-blocking while chrome is hidden', () => {
    expect(filePreviewCss).toContain('width: var(--file-preview-media-width, min(760px, 100%));');
    expect(filePreviewCss).toContain('.file-node-body--media-audio');
    expect(filePreviewCss).toContain('--file-preview-media-width: min(640px, 100%);');
    expect(filePreviewCss).toContain('.file-preview-media-player');
    expect(filePreviewCss).toContain('--media-control-height: 34px;');
    expect(filePreviewCss).toContain('.file-preview-media-controls');
    expect(filePreviewCss).toMatch(/\.file-preview-pill--media-control\s*\{[^}]*position:\s*static;/s);
    expect(filePreviewCss).toMatch(/\.file-preview-pill--media-control \.file-preview-pill-more\s*\{[^}]*background:\s*transparent;/s);
    expect(filePreviewCss).toMatch(/\.file-preview-pill--media\s*\{[^}]*pointer-events:\s*none;/s);
    expect(filePreviewCss).toMatch(/\.file-preview-pill--media:has\(\.file-preview-pill-more\[aria-expanded='true'\]\)\s*\{[^}]*pointer-events:\s*auto;/s);
    expect(filePreviewCss).not.toContain('right: calc(-1 *');
  });
});
