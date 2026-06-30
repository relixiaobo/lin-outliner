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
    expect(filePreviewCss).toContain('--media-control-height: var(--control-size-xl);');
    expect(filePreviewCss).toContain('--media-control-hover-background: transparent;');
    expect(filePreviewCss).toContain('--media-button-icon-width: var(--icon-size-md);');
    expect(filePreviewCss).toContain('--media-button-icon-height: var(--icon-size-md);');
    expect(filePreviewCss).toContain('.file-preview-media-controls');
    expect(filePreviewCss).toMatch(/\.file-preview-media-player\s*\{[^}]*border-radius:\s*var\(--file-preview-frame-radius\);/s);
    expect(filePreviewCss).toMatch(/\.file-preview-media-player\s*\{[^}]*box-shadow:\s*var\(--inset-hairline\);/s);
    expect(filePreviewCss).toMatch(/\.file-preview-media-controls\s*\{[^}]*border-radius:\s*inherit;/s);
    expect(filePreviewCss).toMatch(/\.file-preview-media-controls\s*\{[^}]*box-shadow:\s*none;/s);
    expect(filePreviewCss).toMatch(/\.file-preview-media-button\s*\{[^}]*width:\s*var\(--control-size-xl\);[^}]*height:\s*var\(--control-size-xl\);[^}]*color:\s*var\(--text-secondary\);/s);
    expect(filePreviewCss).toMatch(/\.file-preview-media-button:hover,[\s\S]*?--media-icon-color:\s*var\(--text-primary\);[\s\S]*?color:\s*var\(--text-primary\);/);
    expect(filePreviewCss).toMatch(/\.file-preview-media-player--video \.file-preview-media-controls\s*\{[^}]*box-shadow:\s*none;/s);
    expect(filePreviewCss).toMatch(/\.file-node-preview--media\s*\{[^}]*overflow:\s*visible;/s);
    expect(filePreviewCss).toMatch(/\.file-node-preview--media\s*\{[^}]*background:\s*transparent;/s);
    expect(filePreviewCss).toMatch(/\.file-node-preview--media\s*\{[^}]*box-shadow:\s*none;/s);
    expect(filePreviewCss).toMatch(/\.file-node-preview--media\s*\{[^}]*padding:\s*0;/s);
    expect(filePreviewCss).toMatch(/\.file-node-preview\.file-node-preview--media\s*\{[^}]*padding-bottom:\s*0;/s);
    expect(filePreviewCss).toMatch(/\.file-preview-pill--media-control\s*\{[^}]*position:\s*static;/s);
    expect(filePreviewCss).toMatch(/\.file-preview-pill--media-control\s*\{[^}]*--file-preview-action-size:\s*var\(--control-size-xl\);/s);
    expect(filePreviewCss).toMatch(/\.file-preview-pill--media-control \.file-preview-pill-more\s*\{[^}]*background:\s*transparent;/s);
    expect(filePreviewCss).toMatch(/\.file-preview-pill--media-control \.file-preview-pill-more\s*\{[^}]*box-shadow:\s*none;/s);
    expect(filePreviewCss).toMatch(/\.file-preview-pill--media-control \.file-preview-pill-more:hover,[\s\S]*?background:\s*transparent;[\s\S]*?color:\s*var\(--text-primary\);/);
    expect(filePreviewCss).toMatch(/\.file-preview-pill--media-control \.file-preview-pill-more svg\s*\{[^}]*width:\s*var\(--icon-size-md\);[^}]*height:\s*var\(--icon-size-md\);/s);
    expect(filePreviewCss).toMatch(/\.file-preview-pill--media\s*\{[^}]*pointer-events:\s*none;/s);
    expect(filePreviewCss).toMatch(/\.file-preview-pill--media:has\(\.file-preview-pill-more\[aria-expanded='true'\]\)\s*\{[^}]*pointer-events:\s*auto;/s);
    expect(filePreviewCss).not.toContain('right: calc(-1 *');
  });
});
