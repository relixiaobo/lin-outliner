import { expect, test } from '@playwright/test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as ts from 'typescript';
import { ids, openMockedApp } from './outlinerMock';

async function cssTextMetrics(page: import('@playwright/test').Page, selector: string) {
  return page.locator(selector).first().evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      fontSize: style.fontSize,
      lineHeight: style.lineHeight,
    };
  });
}

// The single src/renderer/styles.css was split into src/renderer/styles/*.css.
// Glob the whole split set so the token/hex guards police every stylesheet and
// automatically cover files added later (no more ENOENT on the deleted file).
const STYLES_DIR = 'src/renderer/styles';
const productStyleFiles = readdirSync(STYLES_DIR)
  .filter((file) => file.endsWith('.css'))
  .map((file) => join(STYLES_DIR, file));
const rendererSourceFiles = collectFiles('src/renderer', ['.css', '.ts', '.tsx']);
const foundationTokenDeclarationFiles = new Set([
  'src/renderer/styles/a11y.css',
  'src/renderer/styles/theme-dark.css',
  'src/renderer/styles/tokens.css',
]);
const rawColorTokenDeclarationFiles = foundationTokenDeclarationFiles;
const darkMediaRuleFiles = new Map([
  ['src/renderer/styles/theme-dark.css', 'Central OS-driven dark theme token layer.'],
  ['src/renderer/styles/code.css', 'Generated Shiki token stream resolves --shiki-dark.'],
  ['src/renderer/styles/panel.css', 'Documented blend-mode correction for panel header icons.'],
]);
const colorSchemeDeclarationFiles = new Map([
  ['src/renderer/styles/tokens.css', 'Root advertises light/dark native controls to the OS.'],
  ['src/renderer/styles/theme-dark.css', 'Central dark-theme token layer flips native controls dark.'],
  ['src/renderer/styles/file-preview.css', 'Document-preview iframe chrome follows the light-canvas exception.'],
  ['src/renderer/ui/preview/EpubPreview.tsx', 'EPUB iframe document content follows the light-canvas exception.'],
]);
const reducedMotionRuleFiles = new Map([
  ['src/renderer/styles/a11y.css', 'Central reduced-motion baseline.'],
  ['src/renderer/styles/feedback-state.css', 'Loading spinner becomes a static loading state.'],
  ['src/renderer/styles/outliner.css', 'Command run spinner becomes a static processing state.'],
  ['src/renderer/styles/file-preview.css', 'URL translation header spinner becomes a static loading state.'],
  ['src/renderer/styles/thread.css', 'Thread action affordances become immediately visible.'],
]);
const reducedTransparencyRuleFiles = new Map([
  ['src/renderer/styles/a11y.css', 'Central material fallback token layer.'],
  ['src/renderer/styles/launcher.css', 'System launcher transparent glass collapses to an opaque elevated surface.'],
]);
const contrastRuleFiles = new Map([
  ['src/renderer/styles/a11y.css', 'Central increased-contrast token layer.'],
  ['src/renderer/styles/launcher.css', 'System launcher transparent glass collapses to an opaque elevated surface.'],
]);
const hiddenScrollbarSelectors = new Set([
  '.document-outline-rail-track',
  '.document-outline-rail-track::-webkit-scrollbar',
]);
const layoutTransitionAllowlist = new Map([
  ['src/renderer/styles/canvas.css|.workspace-canvas|padding', 'Workspace canvas pads around rails during open/close layout motion.'],
  ['src/renderer/styles/outliner.css|.indent-guide-line|width', 'Absolute decorative guide stroke thickens without changing row layout.'],
]);
const interactiveStateSelector = /(:hover|:active|:focus|:focus-visible|:focus-within|\.is-selected|\.selected|\.is-active|\[aria-selected)/;
const stateLayoutDeclarationAllowlist = new Map([
  ['src/renderer/styles/outliner.css|.indent-guide:hover > .indent-guide-line|width', 'Absolute decorative guide stroke thickens without changing row layout.'],
  ['src/renderer/styles/outliner.css|.row.selected:not(.drop-before):not(.drop-after)::before|top', 'Absolute selection overlay insets within the existing row box.'],
  ['src/renderer/styles/outliner.css|.row.selected:not(.drop-before):not(.drop-after)::before|right', 'Absolute selection overlay insets within the existing row box.'],
  ['src/renderer/styles/outliner.css|.row.selected:not(.drop-before):not(.drop-after)::before|bottom', 'Absolute selection overlay insets within the existing row box.'],
  ['src/renderer/styles/outliner.css|.row.selected:not(.drop-before):not(.drop-after)::before|left', 'Absolute selection overlay insets within the existing row box.'],
]);
const materialSurfaceSelectors = new Map([
  ['src/renderer/styles/agent-dock.css|:root[data-window-material] .agent-dock', 'Agent rail chrome material.'],
  ['src/renderer/styles/thread.css|.thread-header-menu', 'Thread action menu.'],
  ['src/renderer/styles/code.css|.agent-code-header > span', 'Floating code-block language label chrome.'],
  ['src/renderer/styles/code.css|.agent-code-copy, .code-block-copy', 'Floating code-block copy chrome.'],
  ['src/renderer/styles/code.css|.code-block-language', 'Floating code-block language trigger.'],
  ['src/renderer/styles/code.css|.code-block-language-menu', 'Code-block language menu.'],
  ['src/renderer/styles/file-preview.css|.document-outline-popover', 'Document outline popover.'],
  ['src/renderer/styles/file-preview.css|.file-node-image-actions .file-node-card-menu-trigger', 'Floating image-row menu trigger over arbitrary pixels.'],
  ['src/renderer/styles/inline-ref.css|.inline-file-preview-popover', 'Inline file hover preview popover.'],
  ['src/renderer/styles/outliner.css|.batch-tag-selector', 'Batch tag selector popover.'],
  ['src/renderer/styles/outliner.css|.node-context-menu', 'Node context menu.'],
  ['src/renderer/styles/outliner.css|.node-picker-popover', 'Node picker popover.'],
  ['src/renderer/styles/outliner.css|.outliner-table-column-menu, .outliner-table-add-column-menu', 'Table column configuration menus.'],
  ['src/renderer/styles/outliner.css|.tag-context-menu', 'Tag context menu.'],
  ['src/renderer/styles/outliner.css|.typed-field-date-popover', 'Field date picker popover.'],
  ['src/renderer/styles/outliner.css|.view-toolbar-popover', 'View toolbar popover.'],
  ['src/renderer/styles/outliner.css|.view-toolbar-tooltip', 'View toolbar tooltip.'],
  ['src/renderer/styles/panel.css|.panel-date-popover', 'Panel date popover.'],
  ['src/renderer/styles/popover-command.css|.trigger-popover', 'Trigger/reference/slash popover shell.'],
  ['src/renderer/styles/settings-providers.css|.settings-row-menu', 'Settings provider row menu.'],
  ['src/renderer/styles/shell.css|.top-chrome-more-menu', 'Top chrome menu.'],
  ['src/renderer/styles/sidebar.css|:root[data-window-material] .sidebar-dock', 'Sidebar rail chrome material.'],
]);
const borderlessOverlaySurfaceSelectors = new Map([
  ['src/renderer/styles/thread.css|.thread-header-menu', 'Thread action menu.'],
  ['src/renderer/styles/code.css|.code-block-language-menu', 'Code-block language menu.'],
  ['src/renderer/styles/confirm-dialog.css|.confirm-dialog', 'Confirm dialog level-2 surface.'],
  ['src/renderer/styles/file-preview.css|.document-outline-popover', 'Document outline popover.'],
  ['src/renderer/styles/inline-ref.css|.inline-file-preview-popover', 'Inline file hover preview popover.'],
  ['src/renderer/styles/overlay-palette.css|.command-palette', 'Command palette layout surface.'],
  ['src/renderer/styles/outliner.css|.batch-tag-selector', 'Batch tag selector popover.'],
  ['src/renderer/styles/outliner.css|.node-context-menu', 'Node context menu.'],
  ['src/renderer/styles/outliner.css|.node-picker-popover', 'Node picker popover.'],
  ['src/renderer/styles/outliner.css|.outliner-table-column-menu, .outliner-table-add-column-menu', 'Table column configuration menus.'],
  ['src/renderer/styles/outliner.css|.tag-context-menu', 'Tag context menu.'],
  ['src/renderer/styles/outliner.css|.typed-field-date-popover', 'Field date picker popover.'],
  ['src/renderer/styles/outliner.css|.view-toolbar-popover', 'View toolbar popover.'],
  ['src/renderer/styles/outliner.css|.view-toolbar-tooltip', 'View toolbar tooltip.'],
  ['src/renderer/styles/panel.css|.panel-date-popover', 'Panel date popover.'],
  ['src/renderer/styles/popover-command.css|.command-palette', 'Command palette visual surface.'],
  ['src/renderer/styles/popover-command.css|.trigger-popover', 'Trigger/reference/slash popover shell.'],
  ['src/renderer/styles/settings-providers.css|.settings-row-menu', 'Settings provider row menu.'],
  ['src/renderer/styles/shell.css|.top-chrome-more-menu', 'Top chrome menu.'],
]);
const previewHudBackdropSelectors = new Map([
  ['src/renderer/styles/file-preview.css|.file-preview-pill-primary', 'Preview HUD primary action over arbitrary document/media pixels.'],
  ['src/renderer/styles/file-preview.css|.file-preview-pill-more', 'Preview HUD more action over arbitrary document/media pixels.'],
]);
const runtimeTokenInputs = new Map([
  ['src/renderer/styles/code.css|--shiki-light', 'Generated Shiki token colour stream for light code themes.'],
  ['src/renderer/styles/code.css|--shiki-dark', 'Generated Shiki token colour stream for dark code themes.'],
  ['src/renderer/styles/file-preview.css|--file-preview-resized-height', 'File preview resizing writes the live split-pane height.'],
  ['src/renderer/styles/outliner.css|--flat-indent-guide-top', 'Flat indent guides receive measured geometry from the outliner runtime.'],
  ['src/renderer/styles/outliner.css|--flat-indent-guide-left', 'Flat indent guides receive measured geometry from the outliner runtime.'],
  ['src/renderer/styles/outliner.css|--flat-indent-guide-height', 'Flat indent guides receive measured geometry from the outliner runtime.'],
  ['src/renderer/styles/outliner.css|--table-columns', 'Table owners provide one live column template to aligned header and body rows.'],
  ['src/renderer/styles/outliner.css|--table-min-width', 'Table owners provide the live horizontal extent derived from configured column widths.'],
  ['src/renderer/styles/thread.css|--thread-depth', 'Thread rows receive their live lineage depth from the Thread list.'],
]);
const layoutTransitionProperties = new Set([
  'all',
  'width',
  'height',
  'min-width',
  'max-width',
  'min-height',
  'max-height',
  'padding',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'margin',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
  'top',
  'right',
  'bottom',
  'left',
  'inset',
  'gap',
  'row-gap',
  'column-gap',
  'flex-basis',
]);
const stateLayoutDeclarationProperties = new Set([
  ...layoutTransitionProperties,
  'font-size',
  'letter-spacing',
  'line-height',
]);
const inlineFoundationStyleProperties = new Set([
  'borderRadius',
  'boxShadow',
  'fontSize',
  'letterSpacing',
  'lineHeight',
]);
const inlineFoundationStyleCssProperties = new Set([
  'border-radius',
  'box-shadow',
  'font-size',
  'letter-spacing',
  'line-height',
]);
const inlineZIndexStyleProperties = new Set(['zIndex']);
const inlineZIndexStyleCssProperties = new Set(['z-index']);

function markdownFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const filePath = join(dir, entry.name);
    if (entry.isDirectory()) return markdownFiles(filePath);
    return entry.isFile() && entry.name.endsWith('.md') ? [filePath] : [];
  }).sort();
}

function collectFiles(dir: string, extensions: readonly string[]): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const filePath = join(dir, entry.name);
    if (entry.isDirectory()) return collectFiles(filePath, extensions);
    return entry.isFile() && extensions.some((extension) => entry.name.endsWith(extension)) ? [filePath] : [];
  }).sort();
}

function propertyNameText(name: ts.PropertyName, sourceFile: ts.SourceFile): string {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name) && ts.isStringLiteral(name.expression)) return name.expression.text;
  return name.getText(sourceFile);
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isAsExpression(current)
    || ts.isParenthesizedExpression(current)
    || ts.isSatisfiesExpression(current)
    || ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function stringLiteralText(expression: ts.Expression): string | null {
  const value = unwrapExpression(expression);
  if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) return value.text;
  return null;
}

function stringLikeTextParts(expression: ts.Expression) {
  const value = unwrapExpression(expression);
  if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) return [value.text];
  if (ts.isTemplateExpression(value)) {
    return [
      value.head.text,
      ...value.templateSpans.map((span) => span.literal.text),
    ];
  }
  return [];
}

function cssDeclarationPropertyName(cssText: string, cssProperties: ReadonlySet<string>) {
  for (const propertyName of cssProperties) {
    const escapedName = propertyName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(?:^|[;{])\\s*${escapedName}\\s*:`, 'iu').test(cssText)) return propertyName;
  }
  return null;
}

const designSystemSpecFiles = [
  'docs/spec/design-system.md',
  ...markdownFiles('docs/spec/design-system'),
];

function extractCssCodeBlocks(file: string) {
  const text = readFileSync(file, 'utf8');
  return [...text.matchAll(/```css\n([\s\S]*?)```/g)].map((match) => ({
    file,
    css: match[1] ?? '',
    startLine: text.slice(0, match.index).split('\n').length + 1,
  }));
}

function extractDesignSystemCssCodeBlocks() {
  return designSystemSpecFiles.flatMap((file) => extractCssCodeBlocks(file));
}

function collectCssDeclarationViolations(
  file: string,
  css: string,
  startLine: number,
  declarationPattern: RegExp,
  isAllowed: (value: string, property: string) => boolean,
) {
  const violations: string[] = [];
  const lines = css.split('\n');
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (trimmed.startsWith('--')) continue;
    const match = declarationPattern.exec(line);
    if (!match) continue;
    const property = match[1]!.trim();
    const value = match[2]!.trim();
    if (isAllowed(value, property)) continue;
    violations.push(`${file}:${startLine + index} ${trimmed}`);
  }
  return violations;
}

function isRawColorTokenDeclaration(file: string, line: string): boolean {
  return line.trim().startsWith('--') && rawColorTokenDeclarationFiles.has(file);
}

function collectUndefinedTokenReferences(file: string, css: string, startLine: number) {
  const definitions = new Set([...css.matchAll(/--[\w-]+\s*:/g)].map((match) => match[0]!.slice(0, -1).trim()));
  const violations: string[] = [];
  const lines = css.split('\n');

  for (const [index, line] of lines.entries()) {
    for (const match of line.matchAll(/var\((--[\w-]+)(\s*,)?/g)) {
      const token = match[1]!;
      const hasFallback = !!match[2];
      if (hasFallback || definitions.has(token)) continue;
      violations.push(`${file}:${startLine + index} ${token} in ${line.trim()}`);
    }
  }

  return violations;
}

function collectDeclarationViolations(
  declarationPattern: RegExp,
  isAllowed: (value: string, property: string) => boolean,
) {
  const violations: string[] = [];

  for (const file of productStyleFiles) {
    const text = readFileSync(file, 'utf8');
    const lines = text.split('\n');
    for (const [index, line] of lines.entries()) {
      const trimmed = line.trim();
      if (trimmed.startsWith('--')) continue;
      const match = declarationPattern.exec(line);
      if (!match) continue;
      const property = match[1]!.trim();
      const value = match[2]!.trim();
      if (isAllowed(value, property)) continue;
      violations.push(`${file}:${index + 1} ${trimmed}`);
    }
  }

  return violations;
}

function collectCssTextViolations(pattern: RegExp) {
  const violations: string[] = [];

  for (const file of productStyleFiles) {
    const text = readFileSync(file, 'utf8').replace(
      /\/\*[\s\S]*?\*\//g,
      (block) => block.replace(/[^\n]/g, ' '),
    );
    const lines = text.split('\n');
    for (const [index, line] of lines.entries()) {
      if (!pattern.test(line)) continue;
      violations.push(`${file}:${index + 1} ${line.trim()}`);
    }
  }

  return violations;
}

function collectCssRuleDeclarationViolations(
  selectorPattern: RegExp,
  declarationPattern: RegExp,
  isAllowed: (value: string, property: string, selector: string) => boolean,
) {
  const violations: string[] = [];

  for (const file of productStyleFiles) {
    const source = readFileSync(file, 'utf8').replace(
      /\/\*[\s\S]*?\*\//g,
      (block) => block.replace(/[^\n]/g, ' '),
    );
    for (const match of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = match[1]!.trim();
      if (!selectorPattern.test(selector)) continue;
      const body = match[2] ?? '';
      const lineNumber = source.slice(0, match.index).split('\n').length;
      for (const declaration of body.matchAll(declarationPattern)) {
        const property = declaration[1]!.trim();
        const value = declaration[2]!.trim();
        if (isAllowed(value, property, selector)) continue;
        violations.push(`${file}:${lineNumber} ${selector} { ${property}: ${value}; }`);
      }
    }
  }

  return violations;
}

function collectMaterialBackdropPairViolations() {
  const violations: string[] = [];

  for (const file of productStyleFiles) {
    const source = readFileSync(file, 'utf8').replace(
      /\/\*[\s\S]*?\*\//g,
      (block) => block.replace(/[^\n]/g, ' '),
    );
    for (const match of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = match[1]!.trim();
      const body = match[2] ?? '';
      if (!/\bbackground(?:-color)?\s*:\s*var\(--material-/.test(body)) continue;

      const hasBackdrop = /(?:^|[;\s])backdrop-filter\s*:\s*var\(--material-backdrop\)\s*;/.test(body);
      const hasWebkitBackdrop = /-webkit-backdrop-filter\s*:\s*var\(--material-backdrop\)\s*;/.test(body);
      if (hasBackdrop && hasWebkitBackdrop) continue;

      const lineNumber = source.slice(0, match.index).split('\n').length;
      violations.push(`${file}:${lineNumber} ${selector} uses a material background without both standard backdrop filters`);
    }
  }

  return violations;
}

function collectMaterialSurfaceScopeViolations() {
  const violations: string[] = [];
  const seen = new Set<string>();

  for (const file of productStyleFiles) {
    const source = readFileSync(file, 'utf8').replace(
      /\/\*[\s\S]*?\*\//g,
      (block) => block.replace(/[^\n]/g, ' '),
    );
    for (const match of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = match[1]!.trim().replace(/\s+/g, ' ');
      const body = match[2] ?? '';
      if (!/\bbackground(?:-color)?\s*:\s*var\(--material-/.test(body)) continue;

      const key = `${file}|${selector}`;
      seen.add(key);
      if (materialSurfaceSelectors.has(key)) continue;

      const lineNumber = source.slice(0, match.index).split('\n').length;
      violations.push(`${file}:${lineNumber} ${selector} uses a material background outside the registered chrome/overlay surface set`);
    }
  }

  for (const [key, reason] of materialSurfaceSelectors) {
    if (seen.has(key)) continue;
    violations.push(`${key} is registered as a material surface but no longer exists (${reason})`);
  }

  return violations;
}

function collectMaterialBackdropScopeViolations() {
  const violations: string[] = [];
  const seenPreviewHud = new Set<string>();

  for (const file of productStyleFiles) {
    const source = readFileSync(file, 'utf8').replace(
      /\/\*[\s\S]*?\*\//g,
      (block) => block.replace(/[^\n]/g, ' '),
    );
    for (const match of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = match[1]!.trim().replace(/\s+/g, ' ');
      const body = match[2] ?? '';
      const backdropValues = [...body.matchAll(/(?:^|[;\s])(?:-webkit-)?backdrop-filter\s*:\s*([^;]+);/g)]
        .map((backdrop) => backdrop[1]!.trim())
        .filter((value) => value !== 'none');
      if (backdropValues.length === 0) continue;

      const key = `${file}|${selector}`;
      const usesMaterialBackground = /\bbackground(?:-color)?\s*:\s*var\(--material-/.test(body);
      if (usesMaterialBackground && materialSurfaceSelectors.has(key)) continue;
      if (previewHudBackdropSelectors.has(key)) {
        seenPreviewHud.add(key);
        continue;
      }

      const lineNumber = source.slice(0, match.index).split('\n').length;
      violations.push(`${file}:${lineNumber} ${selector} uses backdrop-filter outside material surfaces or registered preview HUD controls`);
    }
  }

  for (const [key, reason] of previewHudBackdropSelectors) {
    if (seenPreviewHud.has(key)) continue;
    violations.push(`${key} is registered as a preview HUD backdrop surface but no longer exists (${reason})`);
  }

  return violations;
}

function collectMaterialFallbackViolations() {
  const violations: string[] = [];
  const usedMaterialSurfaceTokens = new Set<string>();
  let usesMaterialBackdrop = false;

  for (const file of productStyleFiles) {
    const source = readFileSync(file, 'utf8').replace(
      /\/\*[\s\S]*?\*\//g,
      (block) => block.replace(/[^\n]/g, ' '),
    );
    for (const match of source.matchAll(/\bbackground(?:-color)?\s*:\s*var\((--material-[\w-]+)\)\s*;/g)) {
      usedMaterialSurfaceTokens.add(match[1]!);
    }
    if (/(?:^|[;\s])(?:-webkit-)?backdrop-filter\s*:\s*var\(--material-backdrop\)\s*;/.test(source)) {
      usesMaterialBackdrop = true;
    }
  }

  const fallbackSource = readFileSync('src/renderer/styles/a11y.css', 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    (block) => block.replace(/[^\n]/g, ' '),
  );
  const fallbackTokens = new Map(
    [...fallbackSource.matchAll(/^\s*(--material-[\w-]+)\s*:\s*([^;]+);/gm)]
      .map((match) => [match[1]!, match[2]!.trim()]),
  );

  for (const token of usedMaterialSurfaceTokens) {
    if (fallbackTokens.has(token)) continue;
    violations.push(`${token} is used as a material background without an a11y opaque fallback`);
  }
  if (usesMaterialBackdrop && fallbackTokens.get('--material-backdrop') !== 'none') {
    violations.push('--material-backdrop is used without a reduced-transparency fallback to none');
  }

  return violations;
}

function collectOverlayOuterBorderViolations() {
  const violations: string[] = [];
  const seen = new Set<string>();

  for (const file of productStyleFiles) {
    const source = readFileSync(file, 'utf8').replace(
      /\/\*[\s\S]*?\*\//g,
      (block) => block.replace(/[^\n]/g, ' '),
    );
    for (const match of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = match[1]!.trim().replace(/\s+/g, ' ');
      const key = `${file}|${selector}`;
      if (!borderlessOverlaySurfaceSelectors.has(key)) continue;
      seen.add(key);

      const body = match[2] ?? '';
      for (const declaration of body.matchAll(/\bborder(?:-(?:top|right|bottom|left))?\s*:\s*([^;]+);/g)) {
        const value = declaration[1]!.trim();
        if (/^(?:0|none)\b/.test(value)) continue;
        const lineNumber = source.slice(0, match.index).split('\n').length;
        violations.push(`${file}:${lineNumber} ${selector} declares an overlay outer border: ${value}`);
      }
    }
  }

  for (const [key, reason] of borderlessOverlaySurfaceSelectors) {
    if (seen.has(key)) continue;
    violations.push(`${key} is registered as a borderless overlay surface but no longer exists (${reason})`);
  }

  return violations;
}

function collectLayoutTransitionViolations() {
  const violations: string[] = [];

  for (const file of productStyleFiles) {
    const source = readFileSync(file, 'utf8').replace(
      /\/\*[\s\S]*?\*\//g,
      (block) => block.replace(/[^\n]/g, ' '),
    );
    for (const match of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = match[1]!.trim().replace(/\s+/g, ' ');
      const body = match[2] ?? '';
      const lineNumber = source.slice(0, match.index).split('\n').length;
      for (const declaration of body.matchAll(/\b(transition|transition-property):\s*([^;]+);/g)) {
        const declarationKind = declaration[1]!;
        const value = declaration[2]!.replace(/\s+/g, ' ').trim();
        const properties = declarationKind === 'transition'
          ? value.split(',').map((segment) => segment.trim().split(/\s+/)[0]!)
          : value.split(',').map((property) => property.trim());
        for (const property of properties) {
          if (!layoutTransitionProperties.has(property)) continue;
          if (layoutTransitionAllowlist.has(`${file}|${selector}|${property}`)) continue;
          violations.push(`${file}:${lineNumber} ${selector} transitions layout property ${property}`);
        }
      }
    }
  }

  return violations;
}

function collectStateLayoutDeclarationViolations() {
  const violations: string[] = [];
  const seenAllowlist = new Set<string>();

  for (const file of productStyleFiles) {
    const source = readFileSync(file, 'utf8').replace(
      /\/\*[\s\S]*?\*\//g,
      (block) => block.replace(/[^\n]/g, ' '),
    );
    for (const match of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = match[1]!.trim().replace(/\s+/g, ' ');
      if (!interactiveStateSelector.test(selector)) continue;
      const body = match[2] ?? '';
      const lineNumber = source.slice(0, match.index).split('\n').length;
      for (const declaration of body.matchAll(/\b([\w-]+)\s*:\s*([^;]+);/g)) {
        const property = declaration[1]!;
        if (!stateLayoutDeclarationProperties.has(property)) continue;
        const key = `${file}|${selector}|${property}`;
        if (stateLayoutDeclarationAllowlist.has(key)) {
          seenAllowlist.add(key);
          continue;
        }
        const value = declaration[2]!.replace(/\s+/g, ' ').trim();
        violations.push(`${file}:${lineNumber} ${selector} changes ${property}: ${value}`);
      }
    }
  }

  for (const [key, reason] of stateLayoutDeclarationAllowlist) {
    if (seenAllowlist.has(key)) continue;
    violations.push(`${key} is a stale interactive-state layout exception (${reason})`);
  }

  return violations;
}

function collectUndefinedLiveTokenReferenceViolations() {
  const violations: string[] = [];
  const definitions = new Set<string>();
  const observedAllowedInputs = new Set<string>();

  for (const file of productStyleFiles) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/--[\w-]+\s*:/g)) {
      definitions.add(match[0]!.slice(0, -1).trim());
    }
  }

  for (const file of productStyleFiles) {
    const text = readFileSync(file, 'utf8').replace(
      /\/\*[\s\S]*?\*\//g,
      (block) => block.replace(/[^\n]/g, ' '),
    );
    const lines = text.split('\n');
    for (const [index, line] of lines.entries()) {
      for (const match of line.matchAll(/var\(\s*(--[\w-]+)(\s*,)?/g)) {
        const token = match[1]!;
        const hasFallback = !!match[2];
        if (hasFallback || definitions.has(token)) continue;

        const key = `${file}|${token}`;
        if (runtimeTokenInputs.has(key)) {
          observedAllowedInputs.add(key);
          continue;
        }

        violations.push(`${file}:${index + 1} ${token} in ${line.trim()}`);
      }
    }
  }

  for (const key of runtimeTokenInputs.keys()) {
    if (observedAllowedInputs.has(key)) continue;
    violations.push(`${key} is a stale runtime token input exception`);
  }

  return violations;
}

function collectSourceOwnedInlineStylePropertyViolations({
  cssProperties,
  styleProperties,
}: {
  cssProperties: ReadonlySet<string>;
  styleProperties: ReadonlySet<string>;
}) {
  const violations: string[] = [];

  for (const file of rendererSourceFiles.filter((sourceFile) => sourceFile.endsWith('.ts') || sourceFile.endsWith('.tsx'))) {
    const text = readFileSync(file, 'utf8');
    const sourceFile = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const styleInitializers = new Map<string, ts.Expression>();
    const styleAliases = new Set<string>();

    function isTrackedPropertyName(propertyName: string) {
      return (
        styleProperties.has(propertyName)
        || cssProperties.has(propertyName.toLowerCase())
      );
    }

    function inspectStyleStringExpression(expression: ts.Expression, seenIdentifiers = new Set<string>()) {
      const styleString = unwrapExpression(expression);
      for (const textPart of stringLikeTextParts(styleString)) {
        const propertyName = cssDeclarationPropertyName(textPart, cssProperties);
        if (!propertyName) continue;
        const { line } = sourceFile.getLineAndCharacterOfPosition(styleString.getStart(sourceFile));
        violations.push(`${file}:${line + 1} inline style string declares ${propertyName}`);
      }
      if (ts.isIdentifier(styleString)) {
        if (seenIdentifiers.has(styleString.text)) return;
        seenIdentifiers.add(styleString.text);
        const initializer = styleInitializers.get(styleString.text);
        if (initializer) inspectStyleStringExpression(initializer, seenIdentifiers);
        return;
      }
      ts.forEachChild(styleString, (child) => {
        if (ts.isExpression(child)) inspectStyleStringExpression(child, seenIdentifiers);
      });
    }

    function trackedStyleWriteName(expression: ts.Expression) {
      const target = unwrapExpression(expression);
      let styleExpression: ts.Expression;
      let propertyName: string | null;

      if (ts.isPropertyAccessExpression(target)) {
        styleExpression = target.expression;
        propertyName = target.name.text;
      } else if (ts.isElementAccessExpression(target)) {
        styleExpression = target.expression;
        propertyName = target.argumentExpression ? stringLiteralText(target.argumentExpression) : null;
      } else {
        return null;
      }

      const styleTarget = unwrapExpression(styleExpression);
      if (
        !propertyName
        || !isTrackedPropertyName(propertyName)
        || !isStyleObjectExpression(styleTarget)
      ) {
        return null;
      }
      return propertyName;
    }

    function trackedStyleSetPropertyName(expression: ts.CallExpression) {
      const callTarget = unwrapExpression(expression.expression);
      if (!ts.isPropertyAccessExpression(callTarget) || callTarget.name.text !== 'setProperty') return null;
      const styleTarget = unwrapExpression(callTarget.expression);
      if (!isStyleObjectExpression(styleTarget)) return null;
      const propertyName = expression.arguments[0] ? stringLiteralText(expression.arguments[0]) : null;
      if (!propertyName || !cssProperties.has(propertyName.toLowerCase())) return null;
      return propertyName;
    }

    function isInlineStyleStringAssignment(expression: ts.Expression) {
      const target = unwrapExpression(expression);
      if (ts.isPropertyAccessExpression(target)) {
        if (target.name.text === 'style') return true;
        return target.name.text === 'cssText' && isStyleObjectExpression(target.expression);
      }
      if (ts.isElementAccessExpression(target)) {
        const propertyName = target.argumentExpression ? stringLiteralText(target.argumentExpression) : null;
        if (propertyName === 'style') return true;
        return propertyName === 'cssText' && isStyleObjectExpression(target.expression);
      }
      return false;
    }

    function isStyleObjectExpression(expression: ts.Expression) {
      const target = unwrapExpression(expression);
      if (ts.isIdentifier(target)) return styleAliases.has(target.text);
      if (ts.isPropertyAccessExpression(target)) return target.name.text === 'style';
      if (ts.isElementAccessExpression(target)) return target.argumentExpression
        ? stringLiteralText(target.argumentExpression) === 'style'
        : false;
      return false;
    }

    function inlineStyleStringSetAttribute(expression: ts.CallExpression) {
      const callTarget = unwrapExpression(expression.expression);
      if (!ts.isPropertyAccessExpression(callTarget) || callTarget.name.text !== 'setAttribute') return null;
      const attributeName = expression.arguments[0] ? stringLiteralText(expression.arguments[0]) : null;
      if (attributeName !== 'style') return null;
      return expression.arguments[1] ?? null;
    }

    function visit(node: ts.Node) {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        styleInitializers.set(node.name.text, node.initializer);
        if (isStyleObjectExpression(node.initializer)) styleAliases.add(node.name.text);
      }
      if (ts.isPropertyAssignment(node) && isTrackedPropertyName(propertyNameText(node.name, sourceFile))) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.name.getStart(sourceFile));
        violations.push(`${file}:${line + 1} ${node.getText(sourceFile)}`);
      }
      if (ts.isPropertyAssignment(node) && propertyNameText(node.name, sourceFile) === 'style') {
        inspectStyleStringExpression(node.initializer);
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        const propertyName = trackedStyleWriteName(node.left);
        if (propertyName) {
          const { line } = sourceFile.getLineAndCharacterOfPosition(node.left.getStart(sourceFile));
          violations.push(`${file}:${line + 1} ${node.left.getText(sourceFile)}`);
        }
      }
      if (
        ts.isBinaryExpression(node)
        && (node.operatorToken.kind === ts.SyntaxKind.EqualsToken || node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken)
      ) {
        if (isInlineStyleStringAssignment(node.left)) inspectStyleStringExpression(node.right);
      }
      if (ts.isCallExpression(node)) {
        const propertyName = trackedStyleSetPropertyName(node);
        if (propertyName) {
          const { line } = sourceFile.getLineAndCharacterOfPosition(node.expression.getStart(sourceFile));
          violations.push(`${file}:${line + 1} ${node.expression.getText(sourceFile)}('${propertyName}')`);
        }
        const inlineStyleValue = inlineStyleStringSetAttribute(node);
        if (inlineStyleValue) inspectStyleStringExpression(inlineStyleValue);
      }
      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
  }

  return violations;
}

function collectInlineZIndexViolations() {
  return collectSourceOwnedInlineStylePropertyViolations({
    cssProperties: inlineZIndexStyleCssProperties,
    styleProperties: inlineZIndexStyleProperties,
  });
}

function collectInlineFoundationStyleViolations() {
  return collectSourceOwnedInlineStylePropertyViolations({
    cssProperties: inlineFoundationStyleCssProperties,
    styleProperties: inlineFoundationStyleProperties,
  });
}

test.describe('typography tokens', () => {
  test('keeps product font declarations tokenized outside proportional glyph exceptions', () => {
    const allowedValues = new Set([
      '0.92em',
      '0',
      '1',
      '1.16em',
      '1.25',
      '9px',
      'inherit',
    ]);
    const violations = collectDeclarationViolations(
      /\b(font-size|line-height):\s*([^;]+);/,
      (value) => value.startsWith('var(') || allowedValues.has(value),
    );

    expect(violations).toEqual([]);
  });

  test('keeps font sizing independent of viewport units', () => {
    const viewportUnitPattern = /\b(?:font-size|--font-[\w-]+)\s*:[^;]*(?:dvw|dvh|svw|svh|lvw|lvh|vw|vh|vmin|vmax|cqw|cqh|cqi|cqb|cqmin|cqmax)\b/;
    const violations = collectCssTextViolations(viewportUnitPattern);

    expect(violations).toEqual([]);
  });

  test('keeps product letter spacing neutral', () => {
    const violations = collectDeclarationViolations(
      /\b(letter-spacing):\s*([^;]+);/,
      (value) => value === '0',
    );

    expect(violations).toEqual([]);
  });

  test('keeps product foundation styling tokenized outside layout geometry', () => {
    const violations = [
      ...collectDeclarationViolations(
        // A radius is tokenized if it IS a token or DERIVES from one via calc()
        // (e.g. the concentric inset `calc(var(--radius-sm) - 2px)`).
        /\b(border-radius):\s*([^;]+);/,
        (value) => value.includes('var(') || value === 'inherit',
      ),
      ...collectDeclarationViolations(
        /\b(transition):\s*([^;]+);/,
        (value) => !/\d+ms/.test(value),
      ),
      ...collectDeclarationViolations(
        /\b(box-shadow):\s*([^;]+);/,
        (value) => value.startsWith('var(') || value === 'none',
      ),
      ...collectDeclarationViolations(
        /\b(gap|column-gap|row-gap|padding|margin):\s*([^;]+);/,
        (value) => !/\d+px/.test(value) || value.includes('var('),
      ),
    ];

    expect(violations).toEqual([]);
  });

  test('keeps renderer theming OS-driven without data-theme selectors', () => {
    const violations = collectCssTextViolations(/\[data-theme\b/);

    expect(violations).toEqual([]);
  });

  test('keeps color-scheme declarations centralized or registered document exceptions', () => {
    const violations: string[] = [];

    for (const file of rendererSourceFiles) {
      const text = readFileSync(file, 'utf8').replace(
        /\/\*[\s\S]*?\*\//g,
        (block) => block.replace(/[^\n]/g, ' '),
      );
      if (!/(?:^|\n)\s*color-scheme\s*:/.test(text)) continue;
      if (colorSchemeDeclarationFiles.has(file)) continue;
      violations.push(`${file} has an unregistered color-scheme declaration`);
    }

    expect(violations).toEqual([]);
  });

  test('keeps dark media rules centralized or explicitly scoped', () => {
    const violations: string[] = [];

    for (const file of productStyleFiles) {
      const text = readFileSync(file, 'utf8').replace(
        /\/\*[\s\S]*?\*\//g,
        (block) => block.replace(/[^\n]/g, ' '),
      );
      if (!/@media\s*\(\s*prefers-color-scheme:\s*dark\s*\)/.test(text)) continue;
      if (darkMediaRuleFiles.has(file)) continue;
      violations.push(`${file} has an unregistered prefers-color-scheme: dark rule`);
    }

    expect(violations).toEqual([]);
  });

  test('keeps reduced-motion rules centralized or explicitly scoped', () => {
    const violations: string[] = [];

    for (const file of productStyleFiles) {
      const text = readFileSync(file, 'utf8').replace(
        /\/\*[\s\S]*?\*\//g,
        (block) => block.replace(/[^\n]/g, ' '),
      );
      if (!/@media\s*\(\s*prefers-reduced-motion:\s*reduce\s*\)/.test(text)) continue;
      if (reducedMotionRuleFiles.has(file)) continue;
      violations.push(`${file} has an unregistered prefers-reduced-motion: reduce rule`);
    }

    expect(violations).toEqual([]);
  });

  test('keeps reduced-transparency rules centralized or explicitly scoped', () => {
    const violations: string[] = [];

    for (const file of productStyleFiles) {
      const text = readFileSync(file, 'utf8').replace(
        /\/\*[\s\S]*?\*\//g,
        (block) => block.replace(/[^\n]/g, ' '),
      );
      if (!/@media[^{]*prefers-reduced-transparency:\s*reduce/.test(text)) continue;
      if (reducedTransparencyRuleFiles.has(file)) continue;
      violations.push(`${file} has an unregistered prefers-reduced-transparency: reduce rule`);
    }

    expect(violations).toEqual([]);
  });

  test('keeps increased-contrast rules centralized or explicitly scoped', () => {
    const violations: string[] = [];

    for (const file of productStyleFiles) {
      const text = readFileSync(file, 'utf8').replace(
        /\/\*[\s\S]*?\*\//g,
        (block) => block.replace(/[^\n]/g, ' '),
      );
      if (!/@media[^{]*prefers-contrast:\s*more/.test(text)) continue;
      if (contrastRuleFiles.has(file)) continue;
      violations.push(`${file} has an unregistered prefers-contrast: more rule`);
    }

    expect(violations).toEqual([]);
  });

  test('keeps the primary token family absent from live CSS', () => {
    const violations = collectCssTextViolations(
      /(?:--primary(?:-[\w-]+)?\s*:|var\(\s*--primary(?:-[\w-]+)?\b)/,
    );

    expect(violations).toEqual([]);
  });

  test('keeps functional-state fills neutral', () => {
    const chromaticSemanticToken = /var\(--(?:accent|accent-strong|status-[\w-]+|danger|semantic-[\w-]+|link|link-hover)\)/;
    const violations = collectCssRuleDeclarationViolations(
      /(:hover|:active|:focus|:focus-visible|:focus-within|\.is-selected|\.selected|\.is-active|\[aria-selected)/,
      /\b(background(?:-color)?|border(?:-[\w-]+)?|box-shadow|outline(?:-color)?):\s*([^;]+);/g,
      (value, _property, selector) => (
        !chromaticSemanticToken.test(value)
        || /\.button-danger\.button-solid:(?:hover|active)/.test(selector)
      ),
    );

    expect(violations).toEqual([]);
  });

  test('keeps hover feedback from using scale transforms', () => {
    const violations = collectDeclarationViolations(
      /\b(transform):\s*([^;]+);/,
      (value) => !/\bscale(?:3d|X|Y|Z)?\s*\(/.test(value),
    );

    expect(violations).toEqual([]);
  });

  test('keeps layout-affecting transitions registered', () => {
    expect(collectLayoutTransitionViolations()).toEqual([]);
  });

  test('keeps interactive state layout declarations registered', () => {
    expect(collectStateLayoutDeclarationViolations()).toEqual([]);
  });

  test('keeps motion timing literals tokenized outside zero delays', () => {
    const timingLiteral = /\b\d+(?:\.\d+)?(?:ms|s)\b/g;
    const violations = collectCssRuleDeclarationViolations(
      /./,
      /\b(animation(?:-duration|-delay)?|transition(?:-duration|-delay)?):\s*([^;]+);/g,
      (value, property) => {
        const literals = [...value.matchAll(timingLiteral)].map((match) => match[0]!);
        if (literals.length === 0) return true;
        if (property.endsWith('delay') && literals.every((literal) => /^(?:0ms|0s)$/.test(literal))) return true;
        return false;
      },
    );

    expect(violations).toEqual([]);
  });

  test('keeps global z-index values on the token ladder', () => {
    const localStackingValues = new Set(['0', '1', '2']);
    const violations = collectDeclarationViolations(
      /\b(z-index):\s*([^;]+);/,
      (value) => (
        value.startsWith('var(--z-')
        || value.startsWith('calc(var(--z-')
        || localStackingValues.has(value)
      ),
    );

    expect(violations).toEqual([]);
  });

  test('keeps renderer source-owned inline z-index out of source styles', () => {
    expect(collectInlineZIndexViolations()).toEqual([]);
  });

  test('keeps renderer source-owned inline foundation styling out of source styles', () => {
    expect(collectInlineFoundationStyleViolations()).toEqual([]);
  });

  test('keeps hidden scrollbars limited to registered non-content rails', () => {
    const violations = [
      ...collectCssRuleDeclarationViolations(
        /./,
        /\b(scrollbar-width):\s*([^;]+);/g,
        (value, _property, selector) => value !== 'none' || hiddenScrollbarSelectors.has(selector),
      ),
      ...collectCssRuleDeclarationViolations(
        /::-webkit-scrollbar/,
        /\b(display):\s*([^;]+);/g,
        (value, _property, selector) => value !== 'none' || hiddenScrollbarSelectors.has(selector),
      ),
    ];

    expect(violations).toEqual([]);
  });

  test('keeps material backdrop filters routed through the shared token', () => {
    const violations = collectDeclarationViolations(
      /(-webkit-backdrop-filter|backdrop-filter):\s*([^;]+);/,
      (value) => value === 'var(--material-backdrop)' || value === 'none',
    );

    expect(violations).toEqual([]);
  });

  test('keeps material backgrounds paired with shared backdrop filters', () => {
    expect(collectMaterialBackdropPairViolations()).toEqual([]);
  });

  test('keeps material backgrounds scoped to registered chrome and overlay surfaces', () => {
    expect(collectMaterialSurfaceScopeViolations()).toEqual([]);
  });

  test('keeps material tokens on the shared accessibility fallback path', () => {
    expect(collectMaterialFallbackViolations()).toEqual([]);
  });

  test('keeps backdrop filters scoped to material surfaces and preview HUD controls', () => {
    expect(collectMaterialBackdropScopeViolations()).toEqual([]);
  });

  test('keeps overlay surfaces free of real outer borders', () => {
    expect(collectOverlayOuterBorderViolations()).toEqual([]);
  });

  test('keeps level-2 focused overlays on the opaque elevated tier', () => {
    const violations = collectCssRuleDeclarationViolations(
      /(?:^|,\s*)(?:\.command-palette|\.confirm-dialog)(?:$|[\s,:])/,
      /\b(background(?:-color)?|(?:-webkit-)?backdrop-filter|box-shadow):\s*([^;]+);/g,
      (value, property) => {
        if (property === 'background' || property === 'background-color') return value === 'var(--bg-elevated)';
        if (property === 'box-shadow') return value === 'var(--overlay-shadow-level-2)';
        return value === 'none';
      },
    );

    expect(violations).toEqual([]);
  });

  test('keeps design-system spec css examples tokenized outside token declarations', () => {
    const violations = extractDesignSystemCssCodeBlocks().flatMap(({ file, css, startLine }) => [
      ...collectCssDeclarationViolations(
        file,
        css,
        startLine,
        /\b(border-radius):\s*([^;]+);/,
        (value) => value.startsWith('var('),
      ),
      ...collectCssDeclarationViolations(
        file,
        css,
        startLine,
        /\b(transition):\s*([^;]+);/,
        (value) => !/\d+ms/.test(value),
      ),
      ...collectCssDeclarationViolations(
        file,
        css,
        startLine,
        /\b(box-shadow):\s*([^;]+);/,
        (value) => value.startsWith('var(') || value === 'none',
      ),
      ...collectCssDeclarationViolations(
        file,
        css,
        startLine,
        /(?:^|;)\s*([\w-]*color|background):\s*(#[0-9a-fA-F]{3,8})\b/,
        () => false,
      ),
    ]);

    expect(violations).toEqual([]);
  });

  test('keeps foundation css token examples self-contained', () => {
    const violations = extractDesignSystemCssCodeBlocks().flatMap(({ file, css, startLine }) => (
      collectUndefinedTokenReferences(file, css, startLine)
    ));

    expect(violations).toEqual([]);
  });

  test('keeps foundation token values sourced from live CSS', () => {
    const violations = extractDesignSystemCssCodeBlocks().flatMap(({ file, css, startLine }) => {
      if (!/^\s*:root\s*\{/m.test(css)) return [];
      return [`${file}:${startLine} duplicates the live :root token table instead of linking to tokens.css`];
    });

    expect(violations).toEqual([]);
  });

  test('keeps documented dock widths aligned with live tokens', () => {
    const tokenSource = readFileSync('src/renderer/styles/tokens.css', 'utf8');
    const foundations = readFileSync('docs/spec/design-system/foundations.md', 'utf8');
    const tokenValue = (name: string) => {
      const match = new RegExp(`--${name}:\\s*([^;]+);`).exec(tokenSource);
      expect(match, `missing --${name}`).not.toBeNull();
      return match![1]!.trim();
    };

    const expected = [
      '- **Dock widths:** sidebar `',
      tokenValue('sidebar-width'),
      '` (`',
      tokenValue('sidebar-min-width'),
      '–',
      tokenValue('sidebar-max-width'),
      '`); agent dock `',
      tokenValue('agent-width'),
      '` (`',
      tokenValue('agent-min-width'),
      '–',
      tokenValue('agent-max-width'),
      '`).',
    ].join('');

    expect(foundations).toContain(expected);
  });

  test('keeps raw hex colors inside token declarations', () => {
    const violations: string[] = [];

    for (const file of productStyleFiles) {
      // Blank out CSS comments before scanning so prose mentioning a hex (e.g.
      // GitHub issue refs like "#7605", or a colour cited in a rationale comment)
      // is not mistaken for a raw-hex declaration. Newlines are preserved so the
      // reported line numbers stay accurate.
      const text = readFileSync(file, 'utf8').replace(
        /\/\*[\s\S]*?\*\//g,
        (block) => block.replace(/[^\n]/g, ' '),
      );
      const lines = text.split('\n');
      for (const [index, line] of lines.entries()) {
        const trimmed = line.trim();
        if (isRawColorTokenDeclaration(file, line)) continue;
        if (!/#(?:[0-9a-fA-F]{3,8})\b/.test(line)) continue;
        violations.push(`${file}:${index + 1} ${trimmed}`);
      }
    }

    expect(violations).toEqual([]);
  });

  test('keeps raw functional colors inside token declarations', () => {
    const violations: string[] = [];

    for (const file of productStyleFiles) {
      const text = readFileSync(file, 'utf8').replace(
        /\/\*[\s\S]*?\*\//g,
        (block) => block.replace(/[^\n]/g, ' '),
      );
      const lines = text.split('\n');
      for (const [index, line] of lines.entries()) {
        const trimmed = line.trim();
        if (isRawColorTokenDeclaration(file, line)) continue;
        if (!/\b(?:rgba?|hsla?)\s*\(/i.test(line)) continue;
        violations.push(`${file}:${index + 1} ${trimmed}`);
      }
    }

    expect(violations).toEqual([]);
  });

  test('keeps live token references defined or registered as runtime inputs', () => {
    expect(collectUndefinedLiveTokenReferenceViolations()).toEqual([]);
  });

  test('keeps token aliases from referencing themselves', () => {
    const violations: string[] = [];

    for (const file of productStyleFiles) {
      const text = readFileSync(file, 'utf8');
      const lines = text.split('\n');
      for (const [index, line] of lines.entries()) {
        const match = /(--[\w-]+):\s*var\((--[\w-]+)\)/.exec(line);
        if (!match || match[1] !== match[2]) continue;
        violations.push(`${file}:${index + 1} ${line.trim()}`);
      }
    }

    expect(violations).toEqual([]);
  });

  test('keeps component shadow custom properties routed through token shadows', () => {
    const violations: string[] = [];

    for (const file of productStyleFiles) {
      if (foundationTokenDeclarationFiles.has(file)) continue;
      const text = readFileSync(file, 'utf8').replace(
        /\/\*[\s\S]*?\*\//g,
        (block) => block.replace(/[^\n]/g, ' '),
      );
      const lines = text.split('\n');
      for (const [index, line] of lines.entries()) {
        const match = /^\s*(--[\w-]*shadow[\w-]*):\s*([^;]+);/.exec(line);
        if (!match) continue;
        const value = match[2]!.trim();
        if (value.startsWith('var(')) continue;
        violations.push(`${file}:${index + 1} ${line.trim()}`);
      }
    }

    expect(violations).toEqual([]);
  });

  test('keeps component color mixes derived from tokens or currentColor', () => {
    const violations: string[] = [];

    for (const file of productStyleFiles) {
      if (foundationTokenDeclarationFiles.has(file)) continue;
      const text = readFileSync(file, 'utf8').replace(
        /\/\*[\s\S]*?\*\//g,
        (block) => block.replace(/[^\n]/g, ' '),
      );
      const lines = text.split('\n');
      for (const [index, line] of lines.entries()) {
        if (!/color-mix\(/.test(line)) continue;
        if (/color-mix\([^,]+,\s*(?:var\(--|currentColor\b)/.test(line)) continue;
        violations.push(`${file}:${index + 1} ${line.trim()}`);
      }
    }

    expect(violations).toEqual([]);
  });

  test('keeps foundation token definitions unique', () => {
    const violations: string[] = [];
    const file = 'src/renderer/styles/tokens.css';
    const text = readFileSync(file, 'utf8').replace(
      /\/\*[\s\S]*?\*\//g,
      (block) => block.replace(/[^\n]/g, ' '),
    );
    const definitions = new Map<string, number[]>();

    for (const match of text.matchAll(/^\s*(--[\w-]+)\s*:/gm)) {
      const token = match[1]!;
      const lineNumber = text.slice(0, match.index).split('\n').length;
      const lines = definitions.get(token) ?? [];
      lines.push(lineNumber);
      definitions.set(token, lines);
    }

    for (const [token, lines] of definitions) {
      if (lines.length <= 1) continue;
      violations.push(`${file}: ${token} is defined on lines ${lines.join(', ')}`);
    }

    expect(violations).toEqual([]);
  });

  test('keeps overlay elevation as pure shadows without outline strokes', () => {
    const violations: string[] = [];

    for (const file of productStyleFiles) {
      const text = readFileSync(file, 'utf8').replace(
        /\/\*[\s\S]*?\*\//g,
        (block) => block.replace(/[^\n]/g, ' '),
      );
      const lines = text.split('\n');
      for (const [index, line] of lines.entries()) {
        if (!/--overlay-shadow-level-\d+:/.test(line)) continue;
        if (!/0\s+0\s+0\s+1px/.test(line)) continue;
        violations.push(`${file}:${index + 1} ${line.trim()}`);
      }
      for (const match of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const selector = match[1]!.trim();
        const body = match[2] ?? '';
        for (const declaration of body.matchAll(/\bbox-shadow\s*:\s*([^;]+);/g)) {
          const value = declaration[1]!.replace(/\s+/g, ' ').trim();
          if (!/var\(--overlay-shadow-level-\d\)/.test(value)) continue;
          if (!/var\(--outline-/.test(value)) continue;
          const lineNumber = text.slice(0, match.index).split('\n').length;
          violations.push(`${file}:${lineNumber} ${selector} { box-shadow: ${value}; }`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  test('keeps the legacy generic shadow alias out of live CSS', () => {
    const violations = collectCssTextViolations(
      /(?:--shadow\s*:|var\(--shadow\))/,
    );

    expect(violations).toEqual([]);
  });

  test('keeps danger styling on semantic status tokens instead of legacy aliases', () => {
    const violations = collectCssTextViolations(
      /(?:--danger\s*:|var\(--danger\))/,
    );

    expect(violations).toEqual([]);
  });

  test('keeps retired legacy aliases out of live CSS', () => {
    const retiredAliases = [
      'app-bg',
      'accent-brand',
      'agent-collapsed-width',
      'agent-side-panel-shadow',
      'danger',
      'outline-panel-ideal-width',
      'status-info',
      'semantic-success',
      'semantic-success-strong',
      'semantic-warning',
      'semantic-danger-muted',
      'semantic-info',
      'overlay-active-bg',
      'border-muted',
      'border',
      'border-subtle',
      'text-body',
      'text-muted',
      'text-sub',
      'text-main',
      'text-disabled',
      'text',
      'muted',
      'muted-2',
      'row-selection-bg',
      'z-base',
      'window-material-frost',
      'surface-disabled',
      'overlay-bg',
      'overlay-backdrop-strong',
      'deck-bg',
      'surface-soft',
      'surface-user-bubble',
      'agent-accent',
      'breadcrumb-height',
      'focus-border',
      'search-builder-focus-shadow',
      'shadow',
      'shell-padding-x',
      'sidebar-collapsed-width',
      'shell-padding-top',
      'shell-padding-bottom',
      'shell-gap',
      'space-micro',
      'space-sm',
      'space-md',
      'tab-active-bg',
      'tab-bg',
      'workspace-tab-width',
      'workspace-tab-close-size',
      'workspace-tab-icon-slot',
      'panel-gap',
      'checkbox-mark-radius',
      'agent-dock-inset-x',
      'panel-bg',
      'surface',
      'surface-2',
      'bg',
      'tab-hover-bg',
    ].join('|');
    const retiredAliasPattern = new RegExp(
      `(?:--(?:${retiredAliases})\\s*:|var\\(--(?:${retiredAliases})\\)|['"\`]--(?:${retiredAliases})['"\`])`,
    );
    expect(retiredAliasPattern.test('--surface: var(--bg-content);')).toBe(true);
    expect(retiredAliasPattern.test('background: var(--surface);')).toBe(true);
    expect(retiredAliasPattern.test('const alias = "--surface";')).toBe(true);
    expect(retiredAliasPattern.test('background: var(--bg-content);')).toBe(false);
    const violations: string[] = [];

    for (const file of rendererSourceFiles) {
      const text = readFileSync(file, 'utf8').replace(
        /\/\*[\s\S]*?\*\//g,
        (block) => block.replace(/[^\n]/g, ' '),
      );
      const lines = text.split('\n');
      for (const [index, line] of lines.entries()) {
        if (!retiredAliasPattern.test(line)) continue;
        violations.push(`${file}:${index + 1} ${line.trim()}`);
      }
    }

    expect(violations).toEqual([]);
  });

  test('keeps rail chrome shadow routed through the shared surface token', () => {
    const violations = collectCssTextViolations(
      /box-shadow:\s*var\(--shadow-rail\),\s*inset 0 0 0 0\.5px var\(--rail-edge\)/,
    );

    expect(violations).toEqual([]);
  });

  test('keeps preview HUD action shadow routed through the shared contrast token', () => {
    const violations = collectCssTextViolations(
      /box-shadow:\s*var\(--shadow-thumb-strong\),\s*inset 0 0 0 1px var\(--preview-action-outline\)/,
    );

    expect(violations).toEqual([]);
  });

  test('keeps primary reading text aligned across outliner and Thread surfaces', async ({ page }) => {
    await openMockedApp(page);
    await page.getByRole('button', { name: 'New Thread' }).last().click();
    await page.getByRole('textbox', { name: 'Message this Thread' }).fill('Summarize current outline.');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByText('Current outline focuses on design-system work.')).toBeVisible();

    await expect(cssTextMetrics(page, `[data-node-id="${ids.alpha}"] .row-editor`)).resolves.toEqual({
      fontSize: '16px',
      lineHeight: '26px',
    });
    await expect(cssTextMetrics(page, '.thread-agent-message')).resolves.toEqual({
      fontSize: '16px',
      lineHeight: '26px',
    });
    await expect(cssTextMetrics(page, '.thread-user-message')).resolves.toEqual({
      fontSize: '16px',
      lineHeight: '26px',
    });
    await expect(cssTextMetrics(page, '.thread-composer textarea')).resolves.toEqual({
      fontSize: '16px',
      lineHeight: '26px',
    });
    await expect(cssTextMetrics(page, '.panel-title-editor .row-editor')).resolves.toEqual({
      fontSize: '24px',
      lineHeight: '32px',
    });
  });
});
