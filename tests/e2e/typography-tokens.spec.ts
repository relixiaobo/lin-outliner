import { expect, test } from '@playwright/test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { emitAgentProjection, ids, openMockedApp } from './outlinerMock';

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
};

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
const designSystemSpecFile = 'docs/spec/design-system.md';

// Pre-existing detokenized declarations the monolithic guard never saw: it only
// read styles.css + outliner.css, so literal values in the settings feature
// sheets went unchecked. Widening the guard to the whole split set (above)
// correctly surfaces them. They are acknowledged debt — NOT new — so we allow the
// EXACT trimmed declarations here, keyed by text (stable across line moves), with
// the rule that the guard still bites any new/other literal. Do not grow this set
// to make a fresh violation pass; tokenize the offending CSS instead (design-
// system B11). Each entry should be retired as the sheet is tokenized.
const PRE_SPLIT_DETOKENIZED_DEBT = new Set<string>([
  // settings-providers.css: pre-existing badge/chip paddings.
  'padding: 3px 8px;',
  'padding: 1px 7px;',
  'padding: 2px 7px;',
  // settings-providers.css pill/dot radii — the "fully rounded" idiom (B6 allows
  // pill/circular). 50% rounds the status dot; 999px is the conventional pill.
  'border-radius: 50%;',
  'border-radius: 999px;',
]);

function extractCssCodeBlocks(file: string) {
  const text = readFileSync(file, 'utf8');
  return [...text.matchAll(/```css\n([\s\S]*?)```/g)].map((match) => ({
    css: match[1] ?? '',
    startLine: text.slice(0, match.index).split('\n').length + 1,
  }));
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
      if (PRE_SPLIT_DETOKENIZED_DEBT.has(trimmed)) continue;
      violations.push(`${file}:${index + 1} ${trimmed}`);
    }
  }

  return violations;
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

  test('keeps design-system spec css examples tokenized outside token declarations', () => {
    const violations = extractCssCodeBlocks(designSystemSpecFile).flatMap(({ css, startLine }) => [
      ...collectCssDeclarationViolations(
        designSystemSpecFile,
        css,
        startLine,
        /\b(border-radius):\s*([^;]+);/,
        (value) => value.startsWith('var('),
      ),
      ...collectCssDeclarationViolations(
        designSystemSpecFile,
        css,
        startLine,
        /\b(transition):\s*([^;]+);/,
        (value) => !/\d+ms/.test(value),
      ),
      ...collectCssDeclarationViolations(
        designSystemSpecFile,
        css,
        startLine,
        /\b(box-shadow):\s*([^;]+);/,
        (value) => value.startsWith('var(') || value === 'none',
      ),
      ...collectCssDeclarationViolations(
        designSystemSpecFile,
        css,
        startLine,
        /(?:^|;)\s*([\w-]*color|background):\s*(#[0-9a-fA-F]{3,8})\b/,
        () => false,
      ),
    ]);

    expect(violations).toEqual([]);
  });

  test('keeps foundation css token examples self-contained', () => {
    const violations = extractCssCodeBlocks(designSystemSpecFile).flatMap(({ css, startLine }) => (
      collectUndefinedTokenReferences(designSystemSpecFile, css, startLine)
    ));

    expect(violations).toEqual([]);
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
        if (trimmed.startsWith('--')) continue;
        if (!/#(?:[0-9a-fA-F]{3,8})\b/.test(line)) continue;
        violations.push(`${file}:${index + 1} ${trimmed}`);
      }
    }

    expect(violations).toEqual([]);
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

  test('keeps overlay elevation as pure shadows without outline strokes', () => {
    const violations: string[] = [];

    for (const file of productStyleFiles) {
      const text = readFileSync(file, 'utf8');
      const lines = text.split('\n');
      for (const [index, line] of lines.entries()) {
        if (!/--overlay-shadow-level-\d+:/.test(line)) continue;
        if (!/0\s+0\s+0\s+1px/.test(line)) continue;
        violations.push(`${file}:${index + 1} ${line.trim()}`);
      }
    }

    expect(violations).toEqual([]);
  });

  test('keeps primary reading text aligned across outliner and agent surfaces', async ({ page }) => {
    await openMockedApp(page);

    const user = {
      role: 'user',
      content: [{ type: 'text', text: 'Summarize current outline.' }],
      timestamp: 1_800_000_000_200,
    };
    const assistant = {
      role: 'assistant',
      api: 'responses',
      provider: 'openai',
      model: 'gpt-5.4',
      usage,
      stopReason: 'stop',
      timestamp: 1_800_000_000_201,
      content: [
        { type: 'thinking', thinking: 'Identify relevant outline nodes.' },
        { type: 'text', text: 'Current outline focuses on design-system work.' },
      ],
    };

    await emitAgentProjection(page, 'mock-agent-session', {
      conversationTitle: 'Agent System',
      systemPrompt: '',
      model: { id: 'gpt-5.4', provider: 'openai' },
      thinkingLevel: 'medium',
      messages: [user, assistant],
      conversation: [
        { nodeId: 'user-node', message: user, branches: null },
        { nodeId: 'assistant-node', message: assistant, branches: null },
      ],
      streamingMessage: null,
      isStreaming: false,
      pendingToolCallIds: [],
      errorMessage: null,
    });

    await expect(page.getByText('Current outline focuses on design-system work.')).toBeVisible();

    await expect(cssTextMetrics(page, `[data-node-id="${ids.alpha}"] .row-editor`)).resolves.toEqual({
      fontSize: '16px',
      lineHeight: '26px',
    });
    await expect(cssTextMetrics(page, '.agent-assistant-content')).resolves.toEqual({
      fontSize: '16px',
      lineHeight: '26px',
    });
    await expect(cssTextMetrics(page, '.agent-user-bubble')).resolves.toEqual({
      fontSize: '16px',
      lineHeight: '26px',
    });
    await expect(cssTextMetrics(page, '.agent-composer-editor')).resolves.toEqual({
      fontSize: '16px',
      lineHeight: '26px',
    });
    await expect(cssTextMetrics(page, '.agent-process-toggle')).resolves.toEqual({
      fontSize: '12px',
      lineHeight: '18px',
    });
    await expect(cssTextMetrics(page, '.panel-title-editor .row-editor')).resolves.toEqual({
      fontSize: '24px',
      lineHeight: '32px',
    });
  });
});
