import { afterEach, describe, expect, test } from 'bun:test';
import { useRef, useState } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { resolveMenuNavigation, useMenuKeyboard, type MenuKeyboardKind } from '../../src/renderer/ui/primitives/useMenuKeyboard';

interface Rendered {
  cleanup: () => void;
  document: Document;
  window: Window;
}

const mounted: Rendered[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()?.cleanup();
});

describe('resolveMenuNavigation', () => {
  test('ArrowDown advances and wraps to the top', () => {
    expect(resolveMenuNavigation('ArrowDown', 0, 3)).toBe(1);
    expect(resolveMenuNavigation('ArrowDown', 2, 3)).toBe(0);
    // No item focused yet (surface has focus) → first item.
    expect(resolveMenuNavigation('ArrowDown', -1, 3)).toBe(0);
  });

  test('ArrowUp retreats and wraps to the bottom', () => {
    expect(resolveMenuNavigation('ArrowUp', 2, 3)).toBe(1);
    expect(resolveMenuNavigation('ArrowUp', 0, 3)).toBe(2);
    expect(resolveMenuNavigation('ArrowUp', -1, 3)).toBe(2);
  });

  test('Home/End jump to the ends', () => {
    expect(resolveMenuNavigation('Home', 2, 3)).toBe(0);
    expect(resolveMenuNavigation('End', 0, 3)).toBe(2);
  });

  test('non-navigation keys and empty menus return null', () => {
    expect(resolveMenuNavigation('Enter', 0, 3)).toBeNull();
    expect(resolveMenuNavigation('a', 0, 3)).toBeNull();
    expect(resolveMenuNavigation('ArrowDown', 0, 0)).toBeNull();
  });
});

function MenuFixture({
  kind,
  onClose,
  disabledIndex,
}: {
  kind: MenuKeyboardKind;
  onClose: () => void;
  disabledIndex?: number;
}) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const { onKeyDown } = useMenuKeyboard({ surfaceRef, onClose, kind });
  return (
    <div ref={surfaceRef} role={kind} onKeyDown={onKeyDown} data-testid="surface">
      {[0, 1, 2].map((i) => (
        <button key={i} disabled={i === disabledIndex} data-index={i} type="button">
          item {i}
        </button>
      ))}
    </div>
  );
}

describe('useMenuKeyboard', () => {
  test('Escape closes the overlay and is scoped to it', () => {
    const closes: number[] = [];
    const rendered = render(<MenuFixture kind="menu" onClose={() => closes.push(1)} />);
    const event = dispatchKey(rendered, 'surface', 'Escape');
    expect(closes).toEqual([1]);
    expect(event.defaultPrevented).toBe(true);
  });

  test('Tab dismisses a menu (it is not in the tab sequence)', () => {
    const closes: number[] = [];
    const rendered = render(<MenuFixture kind="menu" onClose={() => closes.push(1)} />);
    const event = dispatchKey(rendered, 'surface', 'Tab');
    expect(closes).toEqual([1]);
    expect(event.defaultPrevented).toBe(true);
  });

  test('Tab is trapped (not a close) for a dialog-kind popover', () => {
    const closes: number[] = [];
    const rendered = render(<MenuFixture kind="dialog" onClose={() => closes.push(1)} />);
    dispatchKey(rendered, 'surface', 'Tab');
    expect(closes).toEqual([]);
  });

  test('ArrowDown from the surface focuses the first enabled item', () => {
    const rendered = render(<MenuFixture kind="menu" onClose={() => undefined} />);
    const focused = spyFocus(rendered);
    const event = dispatchKey(rendered, 'surface', 'ArrowDown');
    expect(event.defaultPrevented).toBe(true);
    // currentIndex resolves to -1 (no tracked item focus) → first item.
    expect(focused.at(-1)).toBe(0);
  });

  test('disabled items are skipped by focusable discovery', () => {
    const rendered = render(<MenuFixture kind="menu" onClose={() => undefined} disabledIndex={0} />);
    const focused = spyFocus(rendered);
    dispatchKey(rendered, 'surface', 'ArrowDown');
    // The disabled item 0 is not a focus target; discovery yields items 1,2 → first is 1.
    expect(focused.at(-1)).toBe(1);
  });

  test('a plain character key is ignored', () => {
    const closes: number[] = [];
    const rendered = render(<MenuFixture kind="menu" onClose={() => closes.push(1)} />);
    const event = dispatchKey(rendered, 'surface', 'a');
    expect(closes).toEqual([]);
    expect(event.defaultPrevented).toBe(false);
  });

  test('a focusKey change re-pulls focus into the surface (in-place content swap)', () => {
    // Models a menu that swaps its body in place (NodeContextMenu Back, ViewToolbar
    // section switch): focus can end up outside the surface, so bumping focusKey
    // must re-run focus-in or Escape/roving would go dead.
    const rendered = render(<FocusKeyFixture />);
    const focused = spyFocus(rendered);
    // The initial focus-in ran before the spy was installed; bump focusKey now.
    dispatchClick(rendered, 'bump');
    expect(focused.at(-1)).toBe(0);
  });
});

function FocusKeyFixture() {
  const [key, setKey] = useState('a');
  const surfaceRef = useRef<HTMLDivElement>(null);
  const { onKeyDown } = useMenuKeyboard({ surfaceRef, onClose: () => undefined, kind: 'menu', focusKey: key });
  return (
    <>
      <button data-testid="bump" onClick={() => setKey((value) => `${value}x`)} type="button">bump</button>
      <div ref={surfaceRef} role="menu" onKeyDown={onKeyDown} data-testid="surface">
        {[0, 1, 2].map((i) => (
          <button key={i} data-index={i} type="button">item {i}</button>
        ))}
      </div>
    </>
  );
}

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

// Replace each item button's focus() with a recorder of its data-index, so the
// roving target is asserted independently of the DOM's activeElement fidelity.
function spyFocus(rendered: Rendered): number[] {
  const order: number[] = [];
  rendered.document.querySelectorAll('button[data-index]').forEach((button) => {
    (button as HTMLElement).focus = () => order.push(Number(button.getAttribute('data-index')));
  });
  return order;
}

function dispatchKey(rendered: Rendered, testId: string, key: string): Event & { key: string } {
  const element = rendered.document.querySelector(`[data-testid="${testId}"]`);
  if (!element) throw new Error(`Missing element: ${testId}`);
  // linkedom has no KeyboardEvent constructor; React's synthetic handler only
  // reads `.key` off the native event, so a plain Event carrying `key` suffices.
  const event = new rendered.window.Event('keydown', { bubbles: true, cancelable: true }) as Event & { key: string };
  event.key = key;
  act(() => {
    element.dispatchEvent(event);
  });
  return event;
}

function dispatchClick(rendered: Rendered, testId: string) {
  const element = rendered.document.querySelector(`[data-testid="${testId}"]`);
  if (!element) throw new Error(`Missing element: ${testId}`);
  act(() => {
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
