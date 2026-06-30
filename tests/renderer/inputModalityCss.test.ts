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

  test('keeps URL previews single-layer without the document preview frame', () => {
    expect(filePreviewCss).toMatch(/\.outline-panel-surface \.file-preview-panel--fill\s*\{[^}]*overflow:\s*hidden;[^}]*padding-bottom:\s*0;/s);
    expect(filePreviewCss).toMatch(/\.file-preview-panel--fill \.file-preview-content\s*\{[^}]*height:\s*100%;[^}]*flex:\s*1 1 auto;/s);
    expect(filePreviewCss).toMatch(/\.file-node-preview--url\s*\{[^}]*background:\s*transparent;/s);
    expect(filePreviewCss).toMatch(/\.file-node-preview--url\s*\{[^}]*box-shadow:\s*none;/s);
    expect(filePreviewCss).toMatch(/\.file-node-preview--url\s*\{[^}]*padding:\s*0;/s);
    expect(filePreviewCss).toMatch(/\.file-node-preview\.file-node-preview--url\s*\{[^}]*padding-bottom:\s*0;/s);
    expect(filePreviewCss).toMatch(/\.file-node-preview\.file-node-preview--url\s*\{[^}]*max-height:\s*none;/s);
    expect(filePreviewCss).toMatch(/\.file-preview-url\s*\{[^}]*border-radius:\s*var\(--file-preview-frame-radius\);/s);
    expect(filePreviewCss).toMatch(/\.file-preview-url\s*\{[^}]*box-shadow:\s*var\(--inset-hairline\);/s);
    expect(filePreviewCss).toMatch(/\.file-preview-url\s*\{[^}]*clip-path:\s*inset\(0 round var\(--file-preview-frame-radius\)\);/s);
    expect(filePreviewCss).toMatch(/\.file-preview-url-webview\s*\{[^}]*border-radius:\s*inherit;/s);
    expect(filePreviewCss).toMatch(/\.file-preview-url-favicon\s*\{[^}]*width:\s*13px;[^}]*height:\s*13px;/s);
    expect(filePreviewCss).toMatch(/\.file-node-body--reader:is\(\.file-node-body--epub, \.file-node-body--html, \.file-node-body--pdf\)\s*\{[^}]*flex:\s*1 1 auto;/s);
    expect(filePreviewCss).toMatch(/\.file-node-preview--reader\.expanded:is\(\.file-node-preview--epub, \.file-node-preview--html, \.file-node-preview--pdf, \.file-node-preview--url\)\s*\{[^}]*height:\s*100%;/s);
    expect(filePreviewCss).toMatch(/\.file-node-preview--reader:is\(\.file-node-preview--epub, \.file-node-preview--html, \.file-node-preview--pdf\)\s*\{[^}]*display:\s*flex;[^}]*flex:\s*1 1 auto;[^}]*flex-direction:\s*column;/s);
    expect(filePreviewCss).toMatch(/\.file-node-preview--reader:is\(\.file-node-preview--epub, \.file-node-preview--pdf\) > :is\(\.file-preview-epub--full, \.file-preview-pdf-shell--full\)\s*\{[^}]*flex:\s*1 1 auto;/s);
    expect(filePreviewCss).toMatch(/\.file-preview-pdf-shell--full\s*\{[^}]*height:\s*100%;[^}]*min-height:\s*0;/s);
    expect(filePreviewCss).toMatch(/\.file-preview-pdf--full\s*\{[^}]*height:\s*100%;[^}]*min-height:\s*0;[^}]*flex:\s*1 1 auto;/s);
  });

  test('keeps document outline markers centered in a readable-height rail', () => {
    expect(filePreviewCss).toMatch(/\.document-outline-rail\s*\{[^}]*--document-outline-track-height:\s*100%;/s);
    expect(filePreviewCss).toMatch(/\.document-outline-rail\s*\{[^}]*left:\s*var\(--space-5\);/s);
    expect(filePreviewCss).toMatch(/\.document-outline-rail\s*\{[^}]*height:\s*80%;[^}]*max-height:\s*80%;/s);
    expect(filePreviewCss).toMatch(/\.file-preview-epub--full \.document-outline-rail\s*\{[^}]*left:\s*max\(var\(--space-5\), calc\(\(100% - 720px\) \/ 2 \+ var\(--space-5\)\)\);/s);
    expect(filePreviewCss).toMatch(/\.document-outline-rail\s*\{[^}]*display:\s*flex;[^}]*align-items:\s*center;[^}]*justify-content:\s*flex-start;/s);
    expect(filePreviewCss).toMatch(/\.document-outline-rail-track\s*\{[^}]*height:\s*var\(--document-outline-track-height\);[^}]*max-height:\s*var\(--document-outline-track-height\);/s);
    expect(filePreviewCss).toMatch(/\.document-outline-rail-track\s*\{[^}]*overflow-y:\s*auto;/s);
    expect(filePreviewCss).toMatch(/\.document-outline-popover\s*\{[^}]*left:\s*0;/s);
  });
});
