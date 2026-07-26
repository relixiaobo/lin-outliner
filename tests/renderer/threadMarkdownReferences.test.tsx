import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { ThreadMarkdown } from '../../src/renderer/agent/components/ThreadMarkdown';

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

describe('Thread Markdown references', () => {
  test('renders escaped and entity-normalized markers through the shared AST transform', () => {
    const { document, window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
    installDomGlobals(window);
    const container = document.getElementById('root');
    if (!container) throw new Error('Missing root container');
    const root = createRoot(container);
    act(() => {
      root.render(
        <ThreadMarkdown
          onNodeReferenceOpen={() => undefined}
          text={[
            '\\[[node:^escaped-node]]',
            '&#91;[node:^entity-node]]',
            '`[[node:^inline-code-node]]`',
            '[Existing [[node:^link-label-node]]](https://example.test)',
          ].join('\n\n')}
        />,
      );
    });
    cleanups.push(() => act(() => root.unmount()));

    expect([...document.querySelectorAll('[data-inline-ref]')]
      .map((element) => element.getAttribute('data-inline-ref'))).toEqual([
      'escaped-node',
      'entity-node',
    ]);
  });
});

function installDomGlobals(window: Window): void {
  Object.assign(globalThis, {
    document: window.document,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    window,
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
}
