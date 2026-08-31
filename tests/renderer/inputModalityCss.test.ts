import { describe, expect, test } from 'bun:test';

const baseCss = await Bun.file('src/renderer/styles/base.css').text();
const tokensCss = await Bun.file('src/renderer/styles/tokens.css').text();
const a11yCss = await Bun.file('src/renderer/styles/a11y.css').text();
const outlinerCss = await Bun.file('src/renderer/styles/outliner.css').text();
const filePreviewCss = await Bun.file('src/renderer/styles/file-preview.css').text();

describe('input modality CSS guards', () => {
  test('routes every shared focus indicator through keyboard-modality paint seeds', () => {
    expect(tokensCss).toContain('--focus-ring-modality: 0;');
    expect(tokensCss).toContain('calc(var(--focus-ring-alpha) * var(--focus-ring-modality))');
    expect(tokensCss).toContain('calc(2px * var(--focus-ring-modality))');
    expect(tokensCss).toContain('--drop-line: rgb(var(--ink) / var(--focus-ring-alpha));');
    expect(tokensCss).toMatch(/--underline-focus-shadow:[^;]*var\(--focus-ring-modality\)/);
    expect(tokensCss).toMatch(/--tag-focus-shadow:[^;]*var\(--focus-ring-modality\)/);
    expect(tokensCss).toMatch(/--inline-ref-focus-shadow:[^;]*var\(--focus-ring-modality\)/);
    expect(a11yCss).toContain('--focus-ring-alpha: 0.75;');
    expect(a11yCss).toContain('--focus-ring-shadow-alpha: 0.42;');
    expect(a11yCss).not.toMatch(/--focus-ring(?:-shadow)?:\s*(?:rgb|0 0 0 2px)/);
  });

  test('keeps the global text-control keyboard ring low-specificity', () => {
    expect(baseCss).toContain(':root[data-input-modality="keyboard"] :where(input:focus-visible, textarea:focus-visible, select:focus-visible)');
  });

  test('gates definition text input focus paint behind keyboard modality', () => {
    expect(outlinerCss).toContain(':root[data-input-modality="keyboard"] .definition-text-input.input-bare:focus-visible');
    expect(outlinerCss).not.toMatch(/(?:^|\n)\.definition-text-input\.input-bare:focus-visible\s*\{/);
  });

  test('keeps structural outline guides visible without changing layout', () => {
    expect(outlinerCss).toMatch(/--indent-guide-line-offset:\s*calc\(100% - 1px\);/);
    expect(outlinerCss).toMatch(/\.indent-guide-line\s*\{[^}]*width:\s*1px;[^}]*background:\s*var\(--separator\);/s);
    expect(outlinerCss).toMatch(/\.indent-guide:hover > \.indent-guide-line\s*\{[^}]*width:\s*2px;[^}]*background:\s*var\(--border-emphasis\);/s);
    expect(outlinerCss).not.toMatch(/\.indent-guide-line\s*\{[^}]*transform:/s);
  });

  test('keeps Source owner disclosure on ordinary row-hover visibility', () => {
    expect(outlinerCss).toContain('.row-wrap:has(> .row:hover):not(:has(> .row .row:hover))');
    expect(outlinerCss).not.toMatch(
      /(?:^|\n)\.outline-source-preview-row > \.row-leading > \.row-chevron-button\s*\{[^}]*opacity:\s*1;/s,
    );
  });

  test('gives Outline Source composition one preview-to-title gap', () => {
    expect(filePreviewCss).toMatch(
      /\.outline-source-preview \.file-node-body\s*\{[^}]*margin-bottom:\s*0;/s,
    );
    expect(filePreviewCss).toMatch(
      /\.outline-source-preview \.file-node-body\s*\{[^}]*vertical-align:\s*top;/s,
    );
    expect(outlinerCss).not.toContain('.source-field-row');
    expect(outlinerCss).toMatch(
      /\.row-inline-content-slot\s*\{[^}]*display:\s*inline-flex;/s,
    );
    expect(outlinerCss).toMatch(
      /\.field-value-affordances\s*\{[^}]*display:\s*inline-flex;[^}]*margin-inline-start:\s*var\(--space-1\);/s,
    );
    expect(outlinerCss).not.toMatch(/\.field-value-affordances\s*\{[^}]*position:\s*absolute;/s);
    expect(outlinerCss).not.toContain('.ProseMirror p:has(.field-value-affordances)');
    expect(filePreviewCss).toMatch(
      /\.outline-source-preview-actions\s*\{[^}]*position:\s*absolute;[^}]*inset-block-start:\s*calc\(var\(--file-preview-frame-padding-block\) \+ var\(--space-1\)\);[^}]*inset-inline-end:\s*calc\(var\(--file-preview-frame-padding-inline\) \+ var\(--space-1\)\);[^}]*display:\s*inline-flex;/s,
    );
    expect(filePreviewCss).toMatch(
      /\.file-preview-pill--source-corner \.file-preview-pill-more,[\s\S]*?\.outline-source-preview-close\.icon-button\s*\{[^}]*border-radius:\s*var\(--radius-pill\);/s,
    );
    expect(filePreviewCss).toMatch(
      /\.file-preview-pill--source-corner \.file-preview-pill-more,[\s\S]*?\.outline-source-preview-close\.icon-button\s*\{[^}]*background:\s*transparent;[^}]*box-shadow:\s*none;/s,
    );
    expect(filePreviewCss).toMatch(
      /\.outline-source-preview-actions\s*\{[^}]*background:\s*transparent;[^}]*opacity:\s*0;[^}]*pointer-events:\s*none;[^}]*transition:\s*opacity var\(--motion-fast\);/s,
    );
    expect(filePreviewCss).toMatch(
      /\.file-node-body:hover > \.outline-source-preview-actions,[\s\S]*?\.outline-source-preview-actions:focus-within,[\s\S]*?\.outline-source-preview-actions:has\(\[aria-expanded='true'\]\)\s*\{[^}]*opacity:\s*1;[^}]*pointer-events:\s*auto;/s,
    );
    expect(filePreviewCss).toMatch(
      /@media \(hover: none\), \(pointer: coarse\)\s*\{\s*\.outline-source-preview-actions\s*\{[^}]*opacity:\s*1;[^}]*pointer-events:\s*auto;/s,
    );
    expect(filePreviewCss).toMatch(
      /\.file-preview-pill--source-corner \.file-preview-pill-more,[\s\S]*?\.outline-source-preview-close\.icon-button\s*\{[^}]*opacity:\s*0\.82;/s,
    );
    expect(filePreviewCss).toMatch(
      /\.file-preview-pill--source-corner \.file-preview-pill-more:hover,[\s\S]*?\.outline-source-preview-close\.icon-button:hover\s*\{[^}]*background:\s*transparent;[^}]*opacity:\s*1;/s,
    );
    expect(filePreviewCss).toMatch(
      /\.file-preview-pill--source-corner \.file-preview-pill-more:focus-visible,[\s\S]*?\.outline-source-preview-close\.icon-button:focus-visible\s*\{[^}]*box-shadow:\s*var\(--focus-ring-shadow\);/s,
    );
    expect(filePreviewCss).not.toContain(':root[data-input-modality="keyboard"] .file-preview-pill--source-corner');
    expect(filePreviewCss).toMatch(
      /\.node-context-menu\.file-preview-menu--source-contained\s*\{[^}]*min-width:\s*0;/s,
    );
  });

  test('keeps audio and video on one shared HUD geometry', () => {
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
    expect(filePreviewCss).toMatch(/\.file-preview-media-controls\s*\{[^}]*flex-direction:\s*column;/s);
    expect(filePreviewCss).toMatch(/\.file-preview-media-controls\s*\{[^}]*border:\s*0;[^}]*border-radius:\s*0;/s);
    expect(filePreviewCss).toMatch(/\.file-preview-media-controls\s*\{[^}]*background:\s*transparent;/s);
    expect(filePreviewCss).toMatch(/\.file-preview-media-controls\s*\{[^}]*box-shadow:\s*none;/s);
    expect(filePreviewCss).toContain('.file-preview-media-info');
    expect(filePreviewCss).toContain('.file-preview-media-progress-row');
    expect(filePreviewCss).toContain('.file-preview-media-command-row');
    expect(filePreviewCss).toMatch(/\.file-preview-media-player--audio\s*\{[^}]*min-height:\s*calc\([\s\S]*?var\(--media-control-height\) \* 2 \+ var\(--line-ui-sm\) \+ var\(--space-6\)[\s\S]*?\);/s);
    expect(filePreviewCss).toMatch(/\.file-preview-media-info\s*\{[^}]*min-height:\s*var\(--control-size-md\);[^}]*margin-block-start:\s*calc\(var\(--file-preview-frame-padding-block\) \+ var\(--space-1\)\);[^}]*padding:\s*0 var\(--space-8\);/s);
    expect(filePreviewCss).toMatch(/\.file-node-body--media:has\(> \.outline-source-preview-actions\) \.file-preview-media-info\s*\{[^}]*padding-inline-end:\s*calc\(/s);
    expect(filePreviewCss).toMatch(/\.file-preview-media-timeline\s*\{[^}]*width:\s*100%;[^}]*min-width:\s*0;/s);
    expect(filePreviewCss).toMatch(/\.file-preview-media-controls\s*\{[^}]*gap:\s*var\(--space-4\);[^}]*padding:\s*var\(--space-6\) var\(--space-8\);/s);
    expect(filePreviewCss).toMatch(/\.file-preview-media-progress-row\s*\{[^}]*padding:\s*0;/s);
    expect(filePreviewCss).toMatch(/\.file-preview-media-command-row\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) auto minmax\(0, 1fr\);/s);
    expect(filePreviewCss).toMatch(/\.file-preview-media-volume\s*\{[^}]*width:\s*var\(--media-volume-range-width\);[^}]*flex:\s*0 0 var\(--media-volume-range-width\);/s);
    expect(filePreviewCss).toMatch(/\.file-preview-media-command-row\s*\{[^}]*min-height:\s*var\(--control-size-xl\);/s);
    expect(filePreviewCss).toMatch(/\.file-preview-media-name\s*\{[^}]*color:\s*var\(--text-primary\);[^}]*font-size:\s*var\(--font-ui-sm\);[^}]*line-height:\s*var\(--line-ui-sm\);/s);
    expect(filePreviewCss).toMatch(/\.file-preview-media-time-group\s*\{[^}]*color:\s*var\(--text-primary\);[^}]*font-family:\s*var\(--font-family-sans\);[^}]*font-size:\s*var\(--font-ui-xs\);[^}]*font-variant-numeric:\s*tabular-nums;[^}]*font-weight:\s*500;[^}]*letter-spacing:\s*0;[^}]*line-height:\s*var\(--line-ui-xs\);/s);
    expect(filePreviewCss).toMatch(/\.file-preview-media-fullscreen-spacer\s*\{[^}]*width:\s*var\(--control-size-xl\);[^}]*height:\s*var\(--control-size-xl\);[^}]*flex:\s*0 0 var\(--control-size-xl\);/s);
    expect(filePreviewCss).toMatch(/@container \(max-width: 360px\)\s*\{[\s\S]*?\.outline-source-preview \.file-preview-media-volume,[\s\S]*?\.outline-source-preview \.file-preview-media-fullscreen-spacer\s*\{[^}]*display:\s*none;/s);
    expect(filePreviewCss).toMatch(/\.file-preview-media-command-group--transport\s*\{[^}]*justify-content:\s*center;/s);
    expect(filePreviewCss).toMatch(/\.file-preview-media-command-group--trailing\s*\{[^}]*justify-content:\s*flex-end;/s);
    expect(filePreviewCss).toMatch(/\.file-node-body--media-video:not\(\.file-node-body--reader\)\s*\{[^}]*--file-preview-media-width:\s*min\(720px, 100%\);/s);
    expect(filePreviewCss).toMatch(/\.file-node-body--media-video:not\(\.file-node-body--reader\) \.file-preview-video\s*\{[^}]*max-height:\s*min\(60vh, 520px\);[^}]*object-fit:\s*contain;/s);
    expect(filePreviewCss).toMatch(/\.file-preview-media-player--video:fullscreen,[\s\S]*?\.file-preview-media-player--video\[mediaisfullscreen\]\s*\{[^}]*width:\s*100%;[^}]*height:\s*100%;[^}]*max-width:\s*none;[^}]*max-height:\s*none;[^}]*border-radius:\s*0;/s);
    expect(filePreviewCss).toMatch(/\.file-preview-media-player--video:fullscreen \.file-preview-video,[\s\S]*?\.file-preview-media-player--video\[mediaisfullscreen\] \.file-preview-video\s*\{[^}]*width:\s*100%;[^}]*height:\s*100%;[^}]*max-width:\s*none;[^}]*max-height:\s*none;[^}]*object-fit:\s*contain;/s);
    expect(filePreviewCss.indexOf('.file-preview-media-player--video:fullscreen'))
      .toBeGreaterThan(filePreviewCss.indexOf(
        '.file-node-body--media-video:not(.file-node-body--reader) .file-preview-video',
      ));
    expect(filePreviewCss).toMatch(/\.file-preview-media-button\s*\{[^}]*width:\s*var\(--control-size-xl\);[^}]*height:\s*var\(--control-size-xl\);[^}]*color:\s*var\(--text-primary\);/s);
    expect(filePreviewCss).toMatch(/\.file-preview-pill--source-corner \.file-preview-pill-more,[\s\S]*?\.outline-source-preview-close\.icon-button\s*\{[^}]*color:\s*inherit;/s);
    expect(filePreviewCss).toMatch(/\.file-node-body--media-audio > \.outline-source-preview-actions\s*\{[^}]*color:\s*var\(--text-primary\);/s);
    expect(filePreviewCss).toMatch(/\.file-node-body--media-audio > \.outline-source-preview-actions \.file-preview-pill\s*\{[^}]*color:\s*inherit;/s);
    expect(filePreviewCss).toMatch(/\.file-node-body--media-audio > \.outline-source-preview-actions[\s\S]*?:is\(\.file-preview-pill-more, \.outline-source-preview-close\.icon-button\) > svg\s*\{[^}]*filter:\s*none;/s);
    expect(filePreviewCss).toMatch(/\.file-preview-media-button:hover,[\s\S]*?--media-icon-color:\s*var\(--text-primary\);[\s\S]*?color:\s*var\(--text-primary\);/);
    expect(filePreviewCss).toMatch(/\.file-preview-media-player--video \.file-preview-media-controls\s*\{[^}]*padding-block-start:\s*var\(--space-xl\);[^}]*background:\s*linear-gradient\(to bottom, transparent, var\(--media-hud-active-bg\)\);[^}]*border:\s*0;[^}]*border-radius:\s*0;[^}]*box-shadow:\s*none;/s);
    expect(filePreviewCss).not.toContain('.file-preview-media-center-play');
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
    expect(filePreviewCss).not.toContain('right: calc(-1 *');
    expect(filePreviewCss).not.toContain('.file-preview-resize-handle::before');
    expect(filePreviewCss).toMatch(
      /\.file-node-body:has\(> \.file-preview-resize-handle:focus-visible\) \.file-node-preview\s*\{[^}]*box-shadow:\s*var\(--focus-ring-shadow\), var\(--inset-hairline\);/s,
    );
  });

  test('keeps image previews direct while retaining an ellipsis action', () => {
    expect(filePreviewCss).toMatch(/\.file-node-body--image\s*\{[^}]*width:\s*fit-content;[^}]*max-width:\s*100%;/s);
    expect(filePreviewCss).toMatch(/\.file-node-preview--image\s*\{[^}]*width:\s*fit-content;/s);
    expect(filePreviewCss).toMatch(/\.file-node-preview--image\s*\{[^}]*overflow:\s*hidden;/s);
    expect(filePreviewCss).toMatch(/\.file-node-preview--image\s*\{[^}]*border-radius:\s*var\(--file-preview-frame-radius\);/s);
    expect(filePreviewCss).toMatch(/\.file-node-preview--image\s*\{[^}]*background:\s*transparent;/s);
    expect(filePreviewCss).toMatch(/\.file-node-preview--image\s*\{[^}]*box-shadow:\s*none;/s);
    expect(filePreviewCss).toMatch(/\.file-node-preview\.file-node-preview--image\s*\{[^}]*padding:\s*0;/s);
    expect(filePreviewCss).toMatch(/\.file-preview-pill--image\s*\{[^}]*top:\s*var\(--space-2\);[^}]*right:\s*var\(--space-2\);/s);
  });

  test('keeps URL previews single-layer without the document preview frame', () => {
    expect(filePreviewCss).toMatch(/\.file-node-body\s*\{[^}]*--file-preview-frame-padding-block:\s*var\(--space-4\);/s);
    expect(filePreviewCss).toMatch(/\.file-node-body\s*\{[^}]*--file-preview-frame-radius:\s*var\(--radius-md\);/s);
    expect(filePreviewCss).toMatch(/\.file-node-body\s*\{[^}]*--file-preview-page-radius:\s*0;/s);
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
    expect(filePreviewCss).toMatch(/\.file-node-body--image:not\(\.file-node-body--reader\)\s*\{[^}]*max-width:\s*min\(720px, 100%\);/s);
    expect(filePreviewCss).toMatch(/\.file-node-body--image:not\(\.file-node-body--reader\) \.file-preview-image img\s*\{[^}]*max-height:\s*min\(60vh, 520px\);/s);
    expect(filePreviewCss).toMatch(/\.file-node-body--youtube\s*\{[^}]*width:\s*min\(760px, 100%\);/s);
    expect(filePreviewCss).toMatch(/\.file-node-body--reader\.file-node-body--youtube\s*\{[^}]*flex:\s*0 1 auto;[^}]*align-self:\s*flex-start;/s);
    expect(filePreviewCss).toMatch(/\.file-preview-youtube\s*\{[^}]*aspect-ratio:\s*16 \/ 9;[^}]*border-radius:\s*var\(--file-preview-frame-radius\);/s);
    expect(filePreviewCss).toMatch(/\.file-preview-youtube\s*\{[^}]*clip-path:\s*inset\(0 round var\(--file-preview-frame-radius\)\);/s);
    expect(filePreviewCss).toMatch(/\.file-node-body--reader:is\(\.file-node-body--epub, \.file-node-body--html, \.file-node-body--pdf\)\s*\{[^}]*flex:\s*1 1 auto;/s);
    expect(filePreviewCss).toMatch(/\.file-node-preview--reader\.expanded:is\(\.file-node-preview--epub, \.file-node-preview--html, \.file-node-preview--pdf, \.file-node-preview--url\)\s*\{[^}]*height:\s*100%;/s);
    expect(filePreviewCss).toMatch(/\.file-node-preview--reader:is\(\.file-node-preview--epub, \.file-node-preview--html, \.file-node-preview--pdf\)\s*\{[^}]*display:\s*flex;[^}]*flex:\s*1 1 auto;[^}]*flex-direction:\s*column;/s);
    expect(filePreviewCss).toMatch(/\.file-node-preview--reader:is\(\.file-node-preview--epub, \.file-node-preview--pdf\) > :is\(\.file-preview-epub--full, \.file-preview-pdf-shell--full\)\s*\{[^}]*flex:\s*1 1 auto;/s);
    expect(filePreviewCss).toMatch(/\.file-preview-pdf-shell--full\s*\{[^}]*height:\s*100%;[^}]*min-height:\s*0;/s);
    expect(filePreviewCss).toMatch(/\.file-preview-pdf--full\s*\{[^}]*height:\s*100%;[^}]*min-height:\s*0;[^}]*flex:\s*1 1 auto;/s);
  });

  test('keeps document outline markers centered in a readable-height rail', () => {
    expect(filePreviewCss).toMatch(/\.document-outline-rail\s*\{[^}]*--document-outline-track-height:\s*fit-content;/s);
    expect(filePreviewCss).toMatch(/\.document-outline-rail\s*\{[^}]*left:\s*var\(--space-5\);/s);
    expect(filePreviewCss).toMatch(/\.document-outline-rail\s*\{[^}]*height:\s*fit-content;[^}]*max-height:\s*80%;/s);
    expect(filePreviewCss).toMatch(/\.file-preview-epub--full \.document-outline-rail\s*\{[^}]*left:\s*max\(var\(--space-5\), calc\(\(100% - 720px\) \/ 2 \+ var\(--space-5\)\)\);/s);
    expect(filePreviewCss).toMatch(/\.document-outline-rail\s*\{[^}]*display:\s*flex;[^}]*align-items:\s*center;[^}]*justify-content:\s*flex-start;/s);
    expect(filePreviewCss).toMatch(/\.document-outline-rail-track\s*\{[^}]*height:\s*var\(--document-outline-track-height\);[^}]*max-height:\s*100%;/s);
    expect(filePreviewCss).toMatch(/\.document-outline-rail-track\s*\{[^}]*overflow-y:\s*auto;/s);
    expect(filePreviewCss).toMatch(/\.document-outline-popover\s*\{[^}]*left:\s*0;/s);
    expect(filePreviewCss).toContain(':root[data-input-modality="keyboard"] .document-outline-rail:has(.document-outline-popover:focus-within) .document-outline-rail-track');
    expect(filePreviewCss).toContain(':root[data-input-modality="keyboard"] .document-outline-rail:focus-within .document-outline-popover');
    expect(filePreviewCss).not.toMatch(/(?:^|\n)\.document-outline-rail:has\(\.document-outline-popover:focus-within\) \.document-outline-rail-track\s*\{/);
    expect(filePreviewCss).not.toMatch(/(?:^|\n)\.document-outline-rail:focus-within \.document-outline-popover\s*\{/);
  });
});
