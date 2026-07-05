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
const inlineNativeAffordanceProperties = new Set([
  'WebkitAppRegion',
  'WebkitUserSelect',
  'cursor',
  'userSelect',
  'webkitAppRegion',
  'webkitUserSelect',
]);
const inlineNativeAffordanceCssProperties = new Set([
  '-webkit-app-region',
  '-webkit-user-select',
  'cursor',
  'user-select',
]);
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
const tooltipSurfaceSelectors = new Map([
  ['.agent-debug-usage-popover', 'Agent debug usage tooltip.'],
  ['.agent-message-usage-hover-card', 'Agent message usage tooltip.'],
  ['.inline-file-preview-popover', 'Pointer-delayed inline file preview tooltip.'],
  ['.view-toolbar-tooltip', 'View toolbar tooltip.'],
]);
const readOnlyTooltipComponents = new Map([
  ['AgentUsageBreakdown', 'Read-only agent usage token/cost rows.'],
  ['FilePreviewIcon', 'Read-only inline file identity glyph.'],
  ['RoundInfoContent', 'Read-only agent debug round usage details.'],
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
const focusVisibleOutlineSuppressionExceptions = new Map([
  [
    'src/renderer/styles/base.css|input:focus-visible, textarea:focus-visible, select:focus-visible',
    'Text controls suppress the UA outline; the modality-gated keyboard rule adds the shared focus ring.',
  ],
  [
    'src/renderer/styles/file-preview.css|.file-node-image-button:focus-visible',
    'The hidden image-row anchor transfers keyboard focus to the visible image frame.',
  ],
  [
    'src/renderer/styles/input.css|.input-bare:focus-visible',
    'Bare inputs suppress the UA outline while keeping the shared keyboard focus ring available.',
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
    'src/renderer/styles/outliner.css|.row-chevron-button:focus, .row-chevron-button:focus-visible, .row-chevron-button:active, .row-bullet-button:focus, .row-bullet-button:focus-visible, .row-bullet-button:active',
    'Outliner marker controls are non-tabstop structural controls.',
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
  if (ts.isComputedPropertyName(name) && ts.isStringLiteral(name.expression)) return name.expression.text;
  return name.getText(sourceFile);
}

function stringLiteralText(expression: ts.Expression): string | null {
  const value = unwrapExpression(expression);
  if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) return value.text;
  return null;
}

function isNativeAffordanceStylePropertyName(propertyName: string) {
  return (
    inlineNativeAffordanceProperties.has(propertyName)
    || inlineNativeAffordanceCssProperties.has(propertyName.toLowerCase())
  );
}

function nativeAffordanceCssTextPropertyName(cssText: string) {
  for (const propertyName of inlineNativeAffordanceCssProperties) {
    const escapedName = propertyName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(?:^|[;{])\\s*${escapedName}\\s*:`, 'iu').test(cssText)) return propertyName;
  }
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

function collectInlineNativeAffordanceStyleViolations() {
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
    const styleInitializers = new Map<string, ts.Expression>();

    function inspectStyleObject(styleObject: ts.ObjectLiteralExpression, seenIdentifiers: Set<string>) {
      for (const property of styleObject.properties) {
        if (ts.isSpreadAssignment(property)) {
          inspectStyleExpression(property.expression, seenIdentifiers);
          continue;
        }
        if (!('name' in property) || !property.name) continue;
        if (!isNativeAffordanceStylePropertyName(propertyNameText(property.name, sourceFile))) continue;
        const { line } = sourceFile.getLineAndCharacterOfPosition(property.name.getStart(sourceFile));
        violations.push(`${file}:${line + 1} ${property.getText(sourceFile)}`);
      }
    }

    function inspectStyleStringExpression(expression: ts.Expression, seenIdentifiers = new Set<string>()) {
      const styleString = unwrapExpression(expression);
      for (const textPart of stringLikeTextParts(styleString)) {
        const propertyName = nativeAffordanceCssTextPropertyName(textPart);
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

    function inspectStyleExpression(expression: ts.Expression, seenIdentifiers = new Set<string>()) {
      const styleObject = unwrapExpression(expression);
      if (ts.isObjectLiteralExpression(styleObject)) {
        inspectStyleObject(styleObject, seenIdentifiers);
        return;
      }
      inspectStyleStringExpression(styleObject);
      if (ts.isIdentifier(styleObject)) {
        if (seenIdentifiers.has(styleObject.text)) return;
        seenIdentifiers.add(styleObject.text);
        const initializer = styleInitializers.get(styleObject.text);
        if (initializer) inspectStyleExpression(initializer, seenIdentifiers);
        return;
      }
      ts.forEachChild(styleObject, (child) => {
        if (ts.isExpression(child)) inspectStyleExpression(child, seenIdentifiers);
      });
    }

    function nativeAffordanceStyleWriteName(expression: ts.Expression) {
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
        || !isNativeAffordanceStylePropertyName(propertyName)
        || !ts.isPropertyAccessExpression(styleTarget)
        || styleTarget.name.text !== 'style'
      ) {
        return null;
      }
      return propertyName;
    }

    function nativeAffordanceStyleSetPropertyName(expression: ts.CallExpression) {
      const callTarget = unwrapExpression(expression.expression);
      if (!ts.isPropertyAccessExpression(callTarget) || callTarget.name.text !== 'setProperty') return null;
      const styleTarget = unwrapExpression(callTarget.expression);
      if (!ts.isPropertyAccessExpression(styleTarget) || styleTarget.name.text !== 'style') return null;
      const propertyName = expression.arguments[0] ? stringLiteralText(expression.arguments[0]) : null;
      if (!propertyName || !inlineNativeAffordanceCssProperties.has(propertyName.toLowerCase())) return null;
      return propertyName;
    }

    function isInlineStyleStringAssignment(expression: ts.Expression) {
      const target = unwrapExpression(expression);
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
      }
      if (ts.isPropertyAssignment(node) && propertyNameText(node.name, sourceFile) === 'style') {
        inspectStyleStringExpression(node.initializer);
      }
      if (
        ts.isJsxAttribute(node)
        && node.name.text === 'style'
        && node.initializer
        && ts.isJsxExpression(node.initializer)
        && node.initializer.expression
      ) {
        inspectStyleExpression(node.initializer.expression);
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        const propertyName = nativeAffordanceStyleWriteName(node.left);
        if (propertyName) {
          const { line } = sourceFile.getLineAndCharacterOfPosition(node.left.getStart(sourceFile));
          violations.push(`${file}:${line + 1} ${node.left.getText(sourceFile)}`);
        }
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        if (isInlineStyleStringAssignment(node.left)) inspectStyleStringExpression(node.right);
      }
      if (ts.isCallExpression(node)) {
        const propertyName = nativeAffordanceStyleSetPropertyName(node);
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
  const seen = new Set<string>();

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
      seen.add(key);
      if (focusVisibleRingSuppressionExceptions.has(key)) continue;

      const lineNumber = source.slice(0, match.index).split('\n').length;
      violations.push(`${file}:${lineNumber} ${selector}`);
    }
  }

  for (const [key, reason] of focusVisibleRingSuppressionExceptions) {
    if (seen.has(key)) continue;
    violations.push(`${key} is a stale focus-visible ring-suppression exception (${reason})`);
  }

  return violations;
}

function collectFocusVisibleOutlineSuppressionViolations() {
  const violations: string[] = [];
  const seen = new Set<string>();
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
      if (!/\boutline\s*:\s*(?:none|0)\s*;/.test(body)) continue;
      if (focusToken.test(body)) continue;

      const key = `${file}|${selector}`;
      seen.add(key);
      if (focusVisibleOutlineSuppressionExceptions.has(key)) continue;

      const lineNumber = source.slice(0, match.index).split('\n').length;
      violations.push(`${file}:${lineNumber} ${selector}`);
    }
  }

  for (const [key, reason] of focusVisibleOutlineSuppressionExceptions) {
    if (seen.has(key)) continue;
    violations.push(`${key} is a stale focus-visible outline-suppression exception (${reason})`);
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

function collectTooltipPointerEventViolations() {
  const violations: string[] = [];
  const pointerTransparentSelectors = new Set<string>();

  for (const file of styleFiles) {
    const source = readFileSync(file, 'utf8').replace(
      /\/\*[\s\S]*?\*\//g,
      (block) => block.replace(/[^\n]/g, ' '),
    );
    for (const match of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = match[1]!.trim().replace(/\s+/g, ' ');
      const body = match[2] ?? '';
      const tooltipSelector = [...tooltipSurfaceSelectors.keys()]
        .find((candidate) => selector.includes(candidate));
      if (!tooltipSelector) continue;
      if (/\bpointer-events\s*:\s*none\s*;/.test(body)) {
        pointerTransparentSelectors.add(tooltipSelector);
      }
      if (!/\bpointer-events\s*:\s*auto\s*;/.test(body)) continue;

      const lineNumber = source.slice(0, match.index).split('\n').length;
      violations.push(`${file}:${lineNumber} ${selector}`);
    }
  }

  for (const [selector, reason] of tooltipSurfaceSelectors) {
    if (pointerTransparentSelectors.has(selector)) continue;
    violations.push(`${selector} has no pointer-events: none declaration (${reason})`);
  }

  return violations;
}

function stringValuesFromExpression(expression: ts.Expression): string[] {
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return [expression.text];
  }

  const values: string[] = [];
  function visit(node: ts.Node) {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      values.push(node.text);
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(expression);
  return values;
}

function stringValuesFromJsxAttribute(attribute: ts.JsxAttribute): string[] {
  const initializer = attribute.initializer;
  if (!initializer) return [];
  if (ts.isStringLiteral(initializer)) return [initializer.text];
  if (ts.isJsxExpression(initializer) && initializer.expression) {
    return stringValuesFromExpression(initializer.expression);
  }
  return [];
}

function collectTooltipRoleRegistrationViolations() {
  const violations: string[] = [];
  const selectorByClass = new Map(
    [...tooltipSurfaceSelectors.keys()].map((selector) => [selector.replace(/^\./, ''), selector]),
  );
  const seenSelectors = new Set<string>();

  for (const file of rendererSourceFiles.filter((sourceFile) => sourceFile.endsWith('.tsx'))) {
    const text = readFileSync(file, 'utf8');
    const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

    function visit(node: ts.Node) {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const attributes = node.attributes.properties.filter(ts.isJsxAttribute);
        const role = attributes.find((attribute) => attribute.name.text === 'role');
        if (!role || !stringValuesFromJsxAttribute(role).includes('tooltip')) {
          ts.forEachChild(node, visit);
          return;
        }

        const className = attributes.find((attribute) => attribute.name.text === 'className');
        const classNames = new Set(
          className
            ? stringValuesFromJsxAttribute(className).flatMap((value) => value.split(/\s+/).filter(Boolean))
            : [],
        );
        const matchedSelectors = [...classNames]
          .map((name) => selectorByClass.get(name))
          .filter((selector): selector is string => Boolean(selector));
        for (const selector of matchedSelectors) seenSelectors.add(selector);
        if (matchedSelectors.length === 0) {
          const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
          violations.push(`${file}:${line + 1} tooltip role is not registered (${[...classNames].join(' ') || 'no className'})`);
        }
      }
      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
  }

  for (const [selector, reason] of tooltipSurfaceSelectors) {
    if (seenSelectors.has(selector)) continue;
    violations.push(`${selector} is registered as a tooltip surface but no role="tooltip" JSX remains (${reason})`);
  }

  return violations;
}

function jsxTagNameText(tagName: ts.JsxTagNameExpression, sourceFile: ts.SourceFile): string {
  return tagName.getText(sourceFile);
}

function collectTooltipReadOnlyViolations() {
  const violations: string[] = [];
  const seenReadOnlyComponents = new Set<string>();
  const nativeInteractiveTags = new Set(['a', 'button', 'input', 'select', 'textarea']);
  const interactiveRoles = new Set(['button', 'checkbox', 'combobox', 'link', 'menuitem', 'option', 'radio', 'switch', 'textbox']);
  const actionEventHandlers = new Set(['onChange', 'onClick', 'onInput', 'onKeyDown', 'onMouseDown', 'onPointerDown', 'onSubmit']);

  for (const file of rendererSourceFiles.filter((sourceFile) => sourceFile.endsWith('.tsx'))) {
    const text = readFileSync(file, 'utf8');
    const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

    function inspectTooltipDescendant(node: ts.Node) {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tagName = jsxTagNameText(node.tagName, sourceFile);
        const attributes = node.attributes.properties.filter(ts.isJsxAttribute);
        const attributeNames = new Set(attributes.map((attribute) => attribute.name.text.toString()));
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));

        if (/^[A-Z]/.test(tagName)) {
          seenReadOnlyComponents.add(tagName);
          if (!readOnlyTooltipComponents.has(tagName)) {
            violations.push(`${file}:${line + 1} tooltip contains unregistered component <${tagName}>`);
          }
        } else {
          if (nativeInteractiveTags.has(tagName)) {
            violations.push(`${file}:${line + 1} tooltip contains native interactive <${tagName}>`);
          }
          if (attributes.some((attribute) => stringValuesFromJsxAttribute(attribute).some((value) => interactiveRoles.has(value)))) {
            violations.push(`${file}:${line + 1} tooltip contains an interactive role on <${tagName}>`);
          }
          for (const handler of actionEventHandlers) {
            if (!attributeNames.has(handler)) continue;
            violations.push(`${file}:${line + 1} tooltip contains ${handler} on <${tagName}>`);
          }
          if (attributeNames.has('tabIndex')) {
            violations.push(`${file}:${line + 1} tooltip contains tabIndex on <${tagName}>`);
          }
        }
      }

      ts.forEachChild(node, inspectTooltipDescendant);
    }

    function visit(node: ts.Node) {
      if (ts.isJsxElement(node)) {
        const attributes = node.openingElement.attributes.properties.filter(ts.isJsxAttribute);
        const role = attributes.find((attribute) => attribute.name.text === 'role');
        if (role && stringValuesFromJsxAttribute(role).includes('tooltip')) {
          node.children.forEach(inspectTooltipDescendant);
        }
      } else if (ts.isJsxSelfClosingElement(node)) {
        const attributes = node.attributes.properties.filter(ts.isJsxAttribute);
        const role = attributes.find((attribute) => attribute.name.text === 'role');
        if (role && stringValuesFromJsxAttribute(role).includes('tooltip')) {
          // A self-closing tooltip has no content to audit.
        }
      }
      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
  }

  for (const [component, reason] of readOnlyTooltipComponents) {
    if (seenReadOnlyComponents.has(component)) continue;
    violations.push(`${component} is a stale read-only tooltip component exception (${reason})`);
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

  test('keeps renderer source-owned inline styles from declaring native affordance properties', () => {
    expect(collectInlineNativeAffordanceStyleViolations()).toEqual([]);
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

  test('keeps focus-visible suppressions explicitly named', () => {
    expect([
      ...collectFocusVisibleRingSuppressionViolations(),
      ...collectFocusVisibleOutlineSuppressionViolations(),
    ]).toEqual([]);
  });

  test('keeps focus-visible indicators routed through focus tokens', () => {
    expect(collectFocusVisibleIndicatorTokenViolations()).toEqual([]);
  });

  test('keeps resize cursors routed through shared tokens', () => {
    expect(collectRawResizeCursorViolations()).toEqual([]);
  });

  test('keeps tooltip surfaces pointer-transparent', () => {
    expect([
      ...collectTooltipRoleRegistrationViolations(),
      ...collectTooltipReadOnlyViolations(),
      ...collectTooltipPointerEventViolations(),
    ]).toEqual([]);
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
