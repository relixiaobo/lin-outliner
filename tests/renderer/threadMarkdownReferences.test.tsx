import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { renderedMarkdownNodeReferenceIds } from '../../src/core/markdownNodeReferences';
import { ThreadMarkdown } from '../../src/renderer/agent/components/ThreadMarkdown';

const cleanups: Array<() => void> = [];
const NODE_ID = 'node:11111111-1111-4111-8111-111111111111';
const NODE_MARKER = '[[node://11111111-1111-4111-8111-111111111111]]';

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

describe('Thread Markdown references', () => {
  test('renders escaped and entity-normalized markers through the shared AST transform', () => {
    const document = renderThreadMarkdown([
      `\\${NODE_MARKER}`,
      `\\\\${NODE_MARKER}`,
      `\\\\\\${NODE_MARKER}`,
      '&#91;[node://11111111-1111-4111-8111-111111111111]]',
      `\`${NODE_MARKER}\``,
      `[Existing ${NODE_MARKER}](https://example.test)`,
    ].join('\n\n'));

    expect([...document.querySelectorAll('[data-inline-ref]')]
      .map((element) => element.getAttribute('data-inline-ref'))).toEqual([
      NODE_ID,
      NODE_ID,
    ]);
  });

  test('preserves document definitions when rendering reference-style links in blocks', () => {
    const markdown = [
      `[Existing ${NODE_MARKER}][reference-link]`,
      '[reference-link]: https://example.test',
    ].join('\n\n');

    expect(renderedMarkdownNodeReferenceIds(markdown)).toEqual([]);
    const document = renderThreadMarkdown(markdown);
    expect(document.querySelector(`[data-inline-ref="${NODE_ID}"]`)).toBeNull();
    expect(document.querySelector('a')?.getAttribute('href')).toBe('https://example.test');
  });
});

function renderThreadMarkdown(text: string): Document {
  const { document, window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  installDomGlobals(window);
  const container = document.getElementById('root');
  if (!container) throw new Error('Missing root container');
  const root = createRoot(container);
  act(() => {
    root.render(<ThreadMarkdown onNodeReferenceOpen={() => undefined} text={text} />);
  });
  cleanups.push(() => act(() => root.unmount()));
  return document;
}

function installDomGlobals(window: Window): void {
  Object.assign(globalThis, {
    document: window.document,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    window,
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
}
