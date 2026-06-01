import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { SystemFieldValue } from '../../src/renderer/ui/outliner/SystemFieldValue';
import type { NodeId, NodeProjection } from '../../src/renderer/api/types';
import type { SystemFieldDisplay } from '../../src/core/systemFields';

interface Rendered {
  cleanup: () => void;
  container: HTMLElement;
  document: Document;
  window: Window;
}

const mounted: Rendered[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()?.cleanup();
});

describe('SystemFieldValue — Done checkbox', () => {
  test('an editable owner renders an interactive checkbox button that toggles', async () => {
    const toggles: number[] = [];
    const rendered = render({ kind: 'done', checked: false }, { onToggleDone: () => toggles.push(1) });

    const checkbox = rendered.document.querySelector('[role="checkbox"]');
    expect(checkbox?.tagName).toBe('BUTTON');
    expect(checkbox?.getAttribute('aria-checked')).toBe('false');

    await click(rendered, checkbox);
    expect(toggles).toEqual([1]);
  });

  test('a locked owner (no toggle handler) renders the state read-only and inert', async () => {
    const rendered = render({ kind: 'done', checked: true }, {});

    const checkbox = rendered.document.querySelector('[role="checkbox"]');
    expect(checkbox).not.toBeNull();
    // Not a button: there is nothing to press.
    expect(checkbox?.tagName).not.toBe('BUTTON');
    expect(checkbox?.getAttribute('aria-checked')).toBe('true');
    expect(checkbox?.getAttribute('aria-readonly')).toBe('true');
    expect(checkbox?.getAttribute('aria-disabled')).toBe('true');
    expect(checkbox?.className).toContain('is-readonly');

    // Clicking must not throw (no handler wired) — this is the locked-owner case
    // that previously crashed with "operation is not allowed on locked node".
    await click(rendered, checkbox);
  });
});

function render(
  display: SystemFieldDisplay,
  opts: { onToggleDone?: () => void },
): Rendered {
  const { document, window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  installDomGlobals(window);
  const container = document.getElementById('root');
  if (!container) throw new Error('Missing root container');
  const root = createRoot(container);
  act(() => {
    root.render(
      <SystemFieldValue
        display={display}
        byId={new Map<NodeId, NodeProjection>()}
        onRoot={() => {}}
        onToggleDone={opts.onToggleDone}
      />,
    );
  });
  const rendered: Rendered = { cleanup: () => act(() => root.unmount()), container, document, window };
  mounted.push(rendered);
  return rendered;
}

async function click(rendered: Rendered, element: Element | null) {
  if (!element) throw new Error('Missing clickable element');
  await act(async () => {
    element.dispatchEvent(new rendered.window.Event('click', { bubbles: true, cancelable: true }));
  });
}

function installDomGlobals(window: Window) {
  Object.assign(globalThis, {
    document: window.document,
    window,
    HTMLElement: window.HTMLElement,
    KeyboardEvent: window.KeyboardEvent,
    MouseEvent: window.MouseEvent,
    Node: window.Node,
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
}
