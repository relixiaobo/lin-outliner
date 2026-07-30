import { describe, expect, test } from 'bun:test';
import { highlightCode } from '../../src/renderer/ui/editor/shikiHighlighter';

describe('Shiki highlighter fallback', () => {
  test('keeps unknown-language decorated code out of the tab order', async () => {
    const code = 'open /workspace/report.md';
    const start = code.indexOf('/workspace/report.md');
    const html = await highlightCode(code, 'not-a-real-language', [{
      start,
      end: start + '/workspace/report.md'.length,
      properties: {
        'data-test-decoration': 'tool-path',
        'role': 'link',
        'tabIndex': 0,
      },
    }]);

    expect(html).toContain('<pre class="shiki shiki-themes github-light github-dark"');
    expect(html).toContain('tabindex="-1"');
    expect(html).toContain('data-test-decoration="tool-path"');
  });
});
