import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { DoneCheckbox } from '../../src/renderer/ui/outliner/DoneCheckbox';

interface Rendered {
  cleanup: () => void;
  document: Document;
  window: Window;
}

const mounted: Rendered[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()?.cleanup();
});

describe('DoneCheckbox', () => {
  test('an editable owner renders an interactive button that toggles', async () => {
    const toggles: number[] = [];
    const rendered = render({ checked: false, onToggle: () => toggles.push(1) });

    const box = rendered.document.querySelector('.done-checkbox');
    expect(box?.tagName).toBe('BUTTON');
    // The interactive variant announces as a checkbox (matching its read-only twin),
    // not a toggle button — role + aria-checked, never aria-pressed.
    expect(box?.getAttribute('role')).toBe('checkbox');
    expect(box?.getAttribute('aria-checked')).toBe('false');
    expect(box?.hasAttribute('aria-pressed')).toBe(false);

    await click(rendered, box);
    expect(toggles).toEqual([1]);
  });

  test('the interactive checkbox reflects checked state via aria-checked', () => {
    const rendered = render({ checked: true, onToggle: () => undefined });
    const box = rendered.document.querySelector('.done-checkbox');
    expect(box?.getAttribute('aria-checked')).toBe('true');
  });

  test('a locked owner renders the state read-only and inert', async () => {
    const toggles: number[] = [];
    const rendered = render({ checked: true, readOnly: true, onToggle: () => toggles.push(1) });

    const box = rendered.document.querySelector('.done-checkbox');
    expect(box).not.toBeNull();
    // Not a button: there is nothing to press on a locked owner.
    expect(box?.tagName).not.toBe('BUTTON');
    expect(box?.getAttribute('role')).toBe('checkbox');
    expect(box?.getAttribute('aria-checked')).toBe('true');
    expect(box?.getAttribute('aria-readonly')).toBe('true');
    expect(box?.getAttribute('aria-disabled')).toBe('true');
    expect(box?.className).toContain('done-checkbox--readonly');

    // Clicking must not toggle — this is the locked-owner case that would
    // otherwise crash with "operation is not allowed on locked node".
    await click(rendered, box);
    expect(toggles).toEqual([]);
  });
});

function render(props: { checked: boolean; onToggle: () => void; readOnly?: boolean }): Rendered {
  const { document, window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  installDomGlobals(window);
  const container = document.getElementById('root');
  if (!container) throw new Error('Missing root container');
  const root = createRoot(container);
  act(() => {
    root.render(<DoneCheckbox {...props} />);
  });
  const rendered: Rendered = { cleanup: () => act(() => root.unmount()), document, window };
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
