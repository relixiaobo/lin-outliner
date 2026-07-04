import { expect, test } from '@playwright/test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_GENERAL_CHANNEL_ID } from '../../src/core/agentChannel';
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
const darkMediaRuleFiles = new Map([
  ['src/renderer/styles/theme-dark.css', 'Central OS-driven dark theme token layer.'],
  ['src/renderer/styles/code.css', 'Generated Shiki token stream resolves --shiki-dark.'],
  ['src/renderer/styles/panel.css', 'Documented blend-mode correction for panel header icons.'],
]);
const reducedMotionRuleFiles = new Map([
  ['src/renderer/styles/a11y.css', 'Central reduced-motion baseline.'],
  ['src/renderer/styles/feedback-state.css', 'Loading spinner becomes a static loading state.'],
  ['src/renderer/styles/agent-message.css', 'Working dots become a static working state.'],
  ['src/renderer/styles/outliner.css', 'Command run spinner becomes a static processing state.'],
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

function markdownFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const filePath = join(dir, entry.name);
    if (entry.isDirectory()) return markdownFiles(filePath);
    return entry.isFile() && entry.name.endsWith('.md') ? [filePath] : [];
  }).sort();
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

    await emitAgentProjection(page, DEFAULT_GENERAL_CHANNEL_ID, {
      conversationTitle: 'Agent System',
      systemPrompt: '',
      model: { id: 'gpt-5.4', provider: 'openai' },
      thinkingLevel: 'medium',
      messages: [user, assistant],
      conversation: [
        { nodeId: 'user-node', message: user, branches: null },
        { nodeId: 'assistant-node', message: assistant, branches: null, runDurationMs: 3_000 },
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
    await expect(cssTextMetrics(page, '.agent-work-divider')).resolves.toEqual({
      fontSize: '12px',
      lineHeight: '18px',
    });
    await expect(cssTextMetrics(page, '.panel-title-editor .row-editor')).resolves.toEqual({
      fontSize: '24px',
      lineHeight: '32px',
    });
  });
});
