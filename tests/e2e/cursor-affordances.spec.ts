import { expect, test } from '@playwright/test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as ts from 'typescript';
import { ids, installElectronMock, openMockedApp, row } from './outlinerMock';

const STYLES_DIR = 'src/renderer/styles';
const RENDERER_DIR = 'src/renderer';
const styleFiles = readdirSync(STYLES_DIR)
  .filter((file) => file.endsWith('.css'))
  .map((file) => join(STYLES_DIR, file));
const rendererSourceFiles = collectFiles(RENDERER_DIR, ['.ts', '.tsx']);
const pointerCursorSelectors = new Set([
  '.inline-ref.agent-message-inline-ref[href]',
  '.inline-ref:hover',
  '.row-editor .inline-ref:hover',
]);
const helpCursorSelectors = new Map([
  ['src/renderer/styles/agent-debug.css|.agent-debug-cost', 'Debug cost diagnostic tooltip.'],
  ['src/renderer/styles/outliner.css|.field-value-hint', 'Field-value validation hint uses a native title tooltip.'],
]);
const textCursorSelectors = new Map([
  ['src/renderer/styles/agent-composer.css|.agent-composer-editor', 'Agent composer text editor.'],
  ['src/renderer/styles/file-preview.css|.file-preview-pdf-text-layer :is(span, br)', 'Selectable PDF text layer glyphs.'],
  ['src/renderer/styles/outliner.css|.field-option-picker-row', 'Field option value opens into an inline filter input.'],
  ['src/renderer/styles/outliner.css|.node-description', 'Outliner node description textarea.'],
  ['src/renderer/styles/outliner.css|.row.ref-converting .row-editor .inline-ref:hover', 'Inline reference returns to text cursor while converting inside row text.'],
]);
const chromeIconControlSelectors = [
  '.agent-dock-run-back',
  '.agent-dock-title-button',
  '.agent-run-icon-button',
  '.agent-run-panel-button',
  '.outline-panel-close',
  '.panel-breadcrumb-close',
  '.panel-page-back-button',
  '.panel-title-more-button',
  '.rail-toggle',
  '.settings-row-menu-trigger',
];
const focusVisibleRingSuppressionExceptions = new Map([
  [
    'src/renderer/styles/agent-message.css|.agent-channel-working-stop-all:focus-visible',
    'Compact text action uses underline as its keyboard-focus indicator.',
  ],
  [
    'src/renderer/styles/code.css|.code-block-textarea:focus-visible',
    'Code editor textarea is a transparent caret plane over syntax-highlighted text.',
  ],
  [
    'src/renderer/styles/launcher.css|.launcher-input:focus, .launcher-input:focus-visible',
    'Single-field launcher focus is carried by the caret and active launcher surface.',
  ],
  [
    'src/renderer/styles/outliner.css|.indent-guide:focus, .indent-guide:focus-visible, .indent-guide:active',
    'Outliner indent guide is a non-tabstop structural hit target.',
  ],
  [
    'src/renderer/styles/outliner.css|.field-name-input:focus-visible',
    'Outliner field-name editing uses the row/editor focus model.',
  ],
  [
    'src/renderer/styles/outliner.css|.row-chevron-button:focus, .row-chevron-button:focus-visible, .row-chevron-button:active, .row-bullet-button:focus, .row-bullet-button:focus-visible, .row-bullet-button:active',
    'Outliner marker controls are non-tabstop structural controls.',
  ],
  [
    'src/renderer/styles/outliner.css|.node-description:focus-visible',
    'Outliner description editing uses the caret and local description surface.',
  ],
  [
    'src/renderer/styles/settings-provider-sheet.css|.inset-card .settings-sheet-row-input:focus-visible',
    'Clipped inset-card inputs transfer the keyboard ring to the row.',
  ],
]);

function collectFiles(dir: string, extensions: readonly string[]): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const filePath = join(dir, entry.name);
    if (entry.isDirectory()) return collectFiles(filePath, extensions);
    return entry.isFile() && extensions.some((extension) => entry.name.endsWith(extension)) ? [filePath] : [];
  }).sort();
}

function collectPointerCursorViolations() {
  const violations: string[] = [];

  for (const file of styleFiles) {
    const source = readFileSync(file, 'utf8').replace(
      /\/\*[\s\S]*?\*\//g,
      (block) => block.replace(/[^\n]/g, ' '),
    );
    for (const match of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = match[1]!.trim();
      const body = match[2] ?? '';
      if (!/\bcursor\s*:\s*pointer\s*;/.test(body)) continue;
      const lineNumber = source.slice(0, match.index).split('\n').length;
      if (pointerCursorSelectors.has(selector)) continue;
      violations.push(`${file}:${lineNumber} ${selector}`);
    }
  }

  return violations;
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

function propertyNameText(name: ts.PropertyName, sourceFile: ts.SourceFile): string {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return name.getText(sourceFile);
}

function collectInlineCursorStyleViolations() {
  const violations: string[] = [];

  for (const file of rendererSourceFiles) {
    const text = readFileSync(file, 'utf8');
    const sourceFile = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );

    function inspectStyleExpression(expression: ts.Expression) {
      const styleObject = unwrapExpression(expression);
      if (!ts.isObjectLiteralExpression(styleObject)) return;
      for (const property of styleObject.properties) {
        if (!ts.isPropertyAssignment(property)) continue;
        if (propertyNameText(property.name, sourceFile) !== 'cursor') continue;
        const { line } = sourceFile.getLineAndCharacterOfPosition(property.name.getStart(sourceFile));
        violations.push(`${file}:${line + 1} ${property.getText(sourceFile)}`);
      }
    }

    function visit(node: ts.Node) {
      if (
        ts.isJsxAttribute(node)
        && node.name.text === 'style'
        && node.initializer
        && ts.isJsxExpression(node.initializer)
        && node.initializer.expression
      ) {
        inspectStyleExpression(node.initializer.expression);
      }
      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
  }

  return violations;
}

function collectHelpCursorViolations() {
  const violations: string[] = [];
  const seen = new Set<string>();

  for (const file of styleFiles) {
    const source = readFileSync(file, 'utf8').replace(
      /\/\*[\s\S]*?\*\//g,
      (block) => block.replace(/[^\n]/g, ' '),
    );
    for (const match of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = match[1]!.trim().replace(/\s+/g, ' ');
      const body = match[2] ?? '';
      if (!/\bcursor\s*:\s*help\s*;/.test(body)) continue;

      const key = `${file}|${selector}`;
      seen.add(key);
      if (helpCursorSelectors.has(key)) continue;

      const lineNumber = source.slice(0, match.index).split('\n').length;
      violations.push(`${file}:${lineNumber} ${selector}`);
    }
  }

  for (const [key, reason] of helpCursorSelectors) {
    if (seen.has(key)) continue;
    violations.push(`${key} is registered as a help cursor selector but no longer exists (${reason})`);
  }

  return violations;
}

function collectTextCursorViolations() {
  const violations: string[] = [];
  const seen = new Set<string>();

  for (const file of styleFiles) {
    const source = readFileSync(file, 'utf8').replace(
      /\/\*[\s\S]*?\*\//g,
      (block) => block.replace(/[^\n]/g, ' '),
    );
    for (const match of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = match[1]!.trim().replace(/\s+/g, ' ');
      const body = match[2] ?? '';
      if (!/\bcursor\s*:\s*text\s*;/.test(body)) continue;

      const key = `${file}|${selector}`;
      seen.add(key);
      if (textCursorSelectors.has(key)) continue;

      const lineNumber = source.slice(0, match.index).split('\n').length;
      violations.push(`${file}:${lineNumber} ${selector}`);
    }
  }

  for (const [key, reason] of textCursorSelectors) {
    if (seen.has(key)) continue;
    violations.push(`${key} is registered as a text cursor selector but no longer exists (${reason})`);
  }

  return violations;
}

function collectForcedUserSelectViolations() {
  const allowedSelectors = new Set([
    'body.drag-selecting, body.drag-selecting *',
    'body.is-resizing-layout, body.is-resizing-layout *',
  ]);
  const violations: string[] = [];

  for (const file of styleFiles) {
    const source = readFileSync(file, 'utf8').replace(
      /\/\*[\s\S]*?\*\//g,
      (block) => block.replace(/[^\n]/g, ' '),
    );
    for (const match of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = match[1]!.trim().replace(/\s+/g, ' ');
      const body = match[2] ?? '';
      if (!/(?:-webkit-)?user-select\s*:\s*none\s*!important\s*;/.test(body)) continue;
      if (allowedSelectors.has(selector)) continue;
      const lineNumber = source.slice(0, match.index).split('\n').length;
      violations.push(`${file}:${lineNumber} ${selector}`);
    }
  }

  return violations;
}

function collectSelectableDragRegionViolations() {
  const violations: string[] = [];

  for (const file of styleFiles) {
    const source = readFileSync(file, 'utf8').replace(
      /\/\*[\s\S]*?\*\//g,
      (block) => block.replace(/[^\n]/g, ' '),
    );
    for (const match of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const body = match[2] ?? '';
      if (!/-webkit-app-region\s*:\s*drag\s*;/.test(body)) continue;
      if (/\buser-select\s*:\s*none\s*;/.test(body)) continue;

      const selector = match[1]!.trim().replace(/\s+/g, ' ');
      const lineNumber = source.slice(0, match.index).split('\n').length;
      violations.push(`${file}:${lineNumber} ${selector}`);
    }
  }

  return violations;
}

function collectBareInputFocusSuppressionViolations() {
  const violations: string[] = [];

  for (const file of styleFiles) {
    const source = readFileSync(file, 'utf8').replace(
      /\/\*[\s\S]*?\*\//g,
      (block) => block.replace(/[^\n]/g, ' '),
    );
    for (const match of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = match[1]!.trim().replace(/\s+/g, ' ');
      if (selector !== '.input-bare:focus-visible') continue;
      const body = match[2] ?? '';
      if (!/\bbox-shadow\s*:\s*none\s*;/.test(body)) continue;
      const lineNumber = source.slice(0, match.index).split('\n').length;
      violations.push(`${file}:${lineNumber} ${selector}`);
    }
  }

  return violations;
}

function collectFocusVisibleRingSuppressionViolations() {
  const violations: string[] = [];

  for (const file of styleFiles) {
    const source = readFileSync(file, 'utf8').replace(
      /\/\*[\s\S]*?\*\//g,
      (block) => block.replace(/[^\n]/g, ' '),
    );
    for (const match of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = match[1]!.trim().replace(/\s+/g, ' ');
      if (!/:focus-visible\b/.test(selector)) continue;
      if (/:not\(:focus-visible\)/.test(selector)) continue;

      const body = match[2] ?? '';
      if (!/\bbox-shadow\s*:\s*none\s*;/.test(body)) continue;

      const key = `${file}|${selector}`;
      if (focusVisibleRingSuppressionExceptions.has(key)) continue;

      const lineNumber = source.slice(0, match.index).split('\n').length;
      violations.push(`${file}:${lineNumber} ${selector}`);
    }
  }

  return violations;
}

function collectFocusVisibleIndicatorTokenViolations() {
  const violations: string[] = [];
  const focusIndicatorProperty = /\b(outline(?:-color)?|border(?:-(?:top|right|bottom|left))?(?:-color)?|box-shadow)\s*:\s*([^;]+);/g;
  const focusToken = /--[\w-]*focus[\w-]*/;

  for (const file of styleFiles) {
    const source = readFileSync(file, 'utf8').replace(
      /\/\*[\s\S]*?\*\//g,
      (block) => block.replace(/[^\n]/g, ' '),
    );
    for (const match of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = match[1]!.trim().replace(/\s+/g, ' ');
      if (!/:focus-visible\b/.test(selector)) continue;
      if (/:not\(:focus-visible\)/.test(selector)) continue;

      const body = match[2] ?? '';
      for (const declaration of body.matchAll(focusIndicatorProperty)) {
        const property = declaration[1]!;
        const value = declaration[2]!.trim();
        if (/^(none|0|transparent)$/.test(value)) continue;
        if (focusToken.test(value)) continue;

        const lineNumber = source.slice(0, match.index).split('\n').length;
        violations.push(`${file}:${lineNumber} ${selector} -> ${property}: ${value}`);
      }
    }
  }

  return violations;
}

function collectRawResizeCursorViolations() {
  const violations: string[] = [];
  const rawResizeCursor = /(?:^|[;\s])cursor\s*:\s*(?:ew-resize|ns-resize|col-resize|row-resize)\s*;/;

  for (const file of styleFiles) {
    const source = readFileSync(file, 'utf8').replace(
      /\/\*[\s\S]*?\*\//g,
      (block) => block.replace(/[^\n]/g, ' '),
    );
    for (const match of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = match[1]!.trim();
      const body = match[2] ?? '';
      if (!rawResizeCursor.test(body)) continue;
      const lineNumber = source.slice(0, match.index).split('\n').length;
      violations.push(`${file}:${lineNumber} ${selector}`);
    }
  }

  return violations;
}

function collectChromeIconHoverBoxViolations() {
  const violations: string[] = [];

  for (const file of styleFiles) {
    const source = readFileSync(file, 'utf8').replace(
      /\/\*[\s\S]*?\*\//g,
      (block) => block.replace(/[^\n]/g, ' '),
    );
    for (const match of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = match[1]!.trim().replace(/\s+/g, ' ');
      if (!/:(?:hover|focus-visible|active)\b/.test(selector)) continue;
      if (!chromeIconControlSelectors.some((controlSelector) => selector.includes(controlSelector))) continue;

      const body = match[2] ?? '';
      const background = body.match(/\bbackground(?:-color)?\s*:\s*([^;]+);/);
      if (!background) continue;

      const value = background[1]!.trim();
      if (value === 'transparent' || value === 'none') continue;

      const lineNumber = source.slice(0, match.index).split('\n').length;
      violations.push(`${file}:${lineNumber} ${selector} -> ${value}`);
    }
  }

  return violations;
}

// Strict-native cursor policy: chrome (buttons, toggles, rows, bullets) keeps the
// default arrow cursor the way a native macOS/Windows app does. The pointing-hand
// cursor is reserved for genuine content hyperlinks (inline references / links in
// rendered text). Changing the cursor on hoverable chrome is exactly what makes an
// app feel like a web page, so these assertions guard against it regressing.
test.describe('cursor affordances', () => {
  test('reserves pointer cursor declarations for inline content references', () => {
    expect(collectPointerCursorViolations()).toEqual([]);
  });

  test('keeps renderer inline styles from declaring cursors', () => {
    expect(collectInlineCursorStyleViolations()).toEqual([]);
  });

  test('keeps help cursor declarations limited to named diagnostics', () => {
    expect(collectHelpCursorViolations()).toEqual([]);
  });

  test('keeps text cursor declarations limited to text and editor surfaces', () => {
    expect(collectTextCursorViolations()).toEqual([]);
  });

  test('keeps forced text-selection suppression limited to active gestures', () => {
    expect(collectForcedUserSelectViolations()).toEqual([]);
  });

  test('keeps renderer drag regions from selecting chrome text', () => {
    expect(collectSelectableDragRegionViolations()).toEqual([]);
  });

  test('keeps shared bare inputs inheriting the keyboard focus ring', () => {
    expect(collectBareInputFocusSuppressionViolations()).toEqual([]);
  });

  test('keeps focus-visible ring suppressions explicitly named', () => {
    expect(collectFocusVisibleRingSuppressionViolations()).toEqual([]);
  });

  test('keeps focus-visible indicators routed through focus tokens', () => {
    expect(collectFocusVisibleIndicatorTokenViolations()).toEqual([]);
  });

  test('keeps resize cursors routed through shared tokens', () => {
    expect(collectRawResizeCursorViolations()).toEqual([]);
  });

  test('keeps chrome icon hover feedback colour-only', () => {
    expect(collectChromeIconHoverBoxViolations()).toEqual([]);
  });

  test('core controls keep the native arrow cursor', async ({ page }) => {
    await openMockedApp(page);

    const cursors = await page.evaluate((ids) => {
      const cursor = (selector: string) => {
        const element = document.querySelector(selector);
        if (!(element instanceof HTMLElement)) throw new Error(`missing ${selector}`);
        return getComputedStyle(element).cursor;
      };

      return {
        panelMore: cursor('.panel-title-more-button'),
        rowBullet: cursor(`[data-node-id="${ids.alpha}"] .row-bullet-button`),
        composerSend: cursor('.agent-composer-action-button'),
        agentTitle: cursor('.agent-dock-title-button'),
      };
    }, ids);

    // Every chrome control uses the arrow cursor — no pointer affordance anywhere.
    expect(cursors.panelMore).toBe('default');
    expect(cursors.rowBullet).toBe('default');
    expect(cursors.composerSend).toBe('default');
    expect(cursors.agentTitle).toBe('default');
  });

  test('shared icon buttons and definition switches stay on the arrow cursor', async ({ page }) => {
    await openMockedApp(page);

    const iconButtonCursors = await page.evaluate(() => {
      const enabled = document.createElement('button');
      enabled.className = 'icon-button';
      enabled.type = 'button';
      document.body.appendChild(enabled);

      const disabled = document.createElement('button');
      disabled.className = 'icon-button';
      disabled.disabled = true;
      disabled.type = 'button';
      document.body.appendChild(disabled);

      return {
        enabled: getComputedStyle(enabled).cursor,
        disabled: getComputedStyle(disabled).cursor,
      };
    });

    expect(iconButtonCursors.enabled).toBe('default');
    expect(iconButtonCursors.disabled).toBe('default');

    await page.locator('.sidebar-primary-nav').getByRole('button', { name: 'Schema', exact: true }).click();
    await row(page, ids.projectTag).getByRole('button', { name: 'Open' }).click();

    const definitionSwitchCursor = await page.locator('.definition-switch').first().evaluate((element) =>
      getComputedStyle(element).cursor);

    expect(definitionSwitchCursor).toBe('default');
  });

  test('de-pointered non-link controls never use the hand cursor (A5)', async ({ page }) => {
    await openMockedApp(page);

    // These three controls used to carry cursor: pointer even though none is a
    // content hyperlink (an approval toggle, an approval action button, a tag
    // label). PR-C removed the pointer; guard that it never comes back. These are
    // class-only probes (no ancestor context), so they catch a pointer re-added to
    // the class rule itself — not one inherited via a different selector/ancestor.
    const cursors = await page.evaluate(() => {
      const probe = (tag: string, className: string) => {
        const element = document.createElement(tag);
        element.className = className;
        document.body.appendChild(element);
        return getComputedStyle(element).cursor;
      };
      return {
        approvalToggle: probe('button', 'agent-approval-details-toggle'),
        approvalButton: probe('button', 'agent-approval-button'),
        tagLabel: probe('span', 'tag-badge-label clickable'),
      };
    });

    expect(cursors.approvalToggle).not.toBe('pointer');
    expect(cursors.approvalButton).not.toBe('pointer');
    expect(cursors.tagLabel).not.toBe('pointer');
  });

  test('settings inset rows, row menu and provider sheet keep the arrow cursor', async ({ page }) => {
    // The redesigned settings surface adds new chrome — inset grouped-list rows,
    // a per-row `⋯` actions trigger, and the provider sheet's buttons. None is a
    // content hyperlink, so every one must keep the native arrow cursor (B10).
    await installElectronMock(page);
    await page.goto('/?surface=settings');
    const settings = page.locator('.settings-window');
    await expect(settings.locator('.inset-row-main').first()).toBeVisible();

    const listCursors = await page.evaluate(() => {
      const cursor = (selector: string) => {
        const element = document.querySelector(selector);
        if (!(element instanceof HTMLElement)) throw new Error(`missing ${selector}`);
        return getComputedStyle(element).cursor;
      };
      return {
        insetRow: cursor('.inset-row-main'),
        rowMenuTrigger: cursor('.settings-row-menu-trigger'),
        historyArrow: cursor('.settings-history-nav .rail-toggle'),
        configure: cursor('.settings-provider-configure'),
      };
    });
    expect(listCursors.insetRow).toBe('default');
    expect(listCursors.rowMenuTrigger).toBe('default');
    expect(listCursors.historyArrow).toBe('default');
    expect(listCursors.configure).toBe('default');

    // The per-provider config is its own native window (?surface=provider-config);
    // probe its action buttons there (clicking a row opens that window, not a modal).
    await page.goto('/?surface=provider-config&provider=anthropic&mode=configure');
    const sheet = page.locator('.provider-config-window');
    await expect(sheet.getByRole('button', { name: 'Save', exact: true })).toBeVisible();
    const sheetCursors = await page.evaluate(() => {
      const cursor = (selector: string) => {
        const element = document.querySelector(selector);
        if (!(element instanceof HTMLElement)) throw new Error(`missing ${selector}`);
        return getComputedStyle(element).cursor;
      };
      return {
        primary: cursor('.settings-sheet-actions-right .button-primary'),
        reveal: cursor('.settings-sheet-reveal'),
      };
    });
    expect(sheetCursors.primary).toBe('default');
    expect(sheetCursors.reveal).toBe('default');
  });

  test('content references show the pointer cursor on hover', async ({ page }) => {
    await openMockedApp(page);

    // Inline references behave like content hyperlinks, so hovering one is the single
    // place the pointing-hand cursor is allowed under the strict-native policy.
    await page.evaluate(() => {
      const link = document.createElement('a');
      link.className = 'inline-ref';
      link.id = 'cursor-affordance-probe';
      link.textContent = 'reference';
      document.body.appendChild(link);
    });

    const probe = page.locator('#cursor-affordance-probe');
    await probe.hover();
    const hoverCursor = await probe.evaluate((element) => getComputedStyle(element).cursor);

    expect(hoverCursor).toBe('pointer');
  });
});
