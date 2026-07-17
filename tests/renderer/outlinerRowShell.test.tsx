import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { OutlinerRowShell } from '../../src/renderer/ui/outliner/OutlinerRowShell';

interface Rendered {
  cleanup: () => void;
  document: Document;
  window: Window;
}

const mounted: Rendered[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()?.cleanup();
});

const baseProps = {
  wrapProps: { 'data-node-id': 'n1' },
  rowClassName: 'row',
  onSelectFromPointer: () => undefined,
  onContextMenu: () => undefined,
  rowContent: <span>row</span>,
};

describe('OutlinerRowShell tree ARIA', () => {
  test('a parent row is a treeitem carrying level / expanded / selected', () => {
    const rendered = render(
      <OutlinerRowShell {...baseProps} hasChildren expanded={false} level={2} selected />,
    );
    const wrap = rendered.document.querySelector('.row-wrap');
    expect(wrap?.getAttribute('role')).toBe('treeitem');
    expect(wrap?.getAttribute('aria-level')).toBe('2');
    expect(wrap?.getAttribute('aria-expanded')).toBe('false');
    expect(wrap?.getAttribute('aria-selected')).toBe('true');
  });

  test('an expanded parent announces aria-expanded=true', () => {
    const rendered = render(
      <OutlinerRowShell {...baseProps} hasChildren expanded level={1} selected={false} />,
    );
    const wrap = rendered.document.querySelector('.row-wrap');
    expect(wrap?.getAttribute('aria-expanded')).toBe('true');
    expect(wrap?.getAttribute('aria-selected')).toBe('false');
  });

  test('a leaf row omits aria-expanded so no phantom toggle is announced', () => {
    const rendered = render(
      <OutlinerRowShell {...baseProps} hasChildren={false} expanded={false} level={3} selected={false} />,
    );
    const wrap = rendered.document.querySelector('.row-wrap');
    expect(wrap?.getAttribute('role')).toBe('treeitem');
    expect(wrap?.getAttribute('aria-level')).toBe('3');
    expect(wrap?.hasAttribute('aria-expanded')).toBe(false);
  });

  test('a table presentation omits tree attributes inside its owning gridcell', () => {
    const rendered = render(
      <OutlinerRowShell
        {...baseProps}
        hasChildren
        expanded
        level={3}
        selected
        semanticRole="presentation"
      />,
    );
    const wrap = rendered.document.querySelector('.row-wrap');
    expect(wrap?.getAttribute('role')).toBe('presentation');
    expect(wrap?.hasAttribute('aria-colindex')).toBe(false);
    expect(wrap?.hasAttribute('aria-level')).toBe(false);
    expect(wrap?.hasAttribute('aria-expanded')).toBe(false);
    expect(wrap?.hasAttribute('aria-selected')).toBe(false);
  });
});

function render(node: React.ReactElement): Rendered {
  const { document, window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  installDomGlobals(window);
  const container = document.getElementById('root');
  if (!container) throw new Error('Missing root container');
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  const rendered: Rendered = { cleanup: () => act(() => root.unmount()), document, window };
  mounted.push(rendered);
  return rendered;
}

function installDomGlobals(window: Window) {
  Object.assign(globalThis, {
    document: window.document,
    window,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
}
