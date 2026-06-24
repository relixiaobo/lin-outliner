import { describe, expect, test } from 'bun:test';

const baseCss = await Bun.file('src/renderer/styles/base.css').text();
const outlinerCss = await Bun.file('src/renderer/styles/outliner.css').text();

describe('input modality CSS guards', () => {
  test('keeps the global text-control keyboard ring low-specificity', () => {
    expect(baseCss).toContain(':root[data-input-modality="keyboard"] :where(input:focus-visible, textarea:focus-visible, select:focus-visible)');
  });

  test('gates definition text input focus paint behind keyboard modality', () => {
    expect(outlinerCss).toContain(':root[data-input-modality="keyboard"] .definition-text-input.input-bare:focus-visible');
    expect(outlinerCss).not.toMatch(/(?:^|\n)\.definition-text-input\.input-bare:focus-visible\s*\{/);
  });
});
