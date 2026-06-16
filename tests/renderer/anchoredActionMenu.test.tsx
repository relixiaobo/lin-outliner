import { afterEach, describe, expect, test } from 'bun:test';
import { useRef } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { AnchoredActionMenu, type AnchoredMenuAction } from '../../src/renderer/ui/primitives/AnchoredActionMenu';

interface Rendered {
  cleanup: () => void;
  document: Document;
  window: Window;
}

const mounted: Rendered[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()?.cleanup();
});

function Fixture({ actions, onClose }: { actions: AnchoredMenuAction[]; onClose: () => void }) {
  const anchorRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={anchorRef} data-testid="anchor" type="button">trigger</button>
      <AnchoredActionMenu
        actions={actions}
        anchorRef={anchorRef}
        ariaLabel="Row actions"
        className="test-action-menu"
        itemClassName="test-action-item"
        itemLabelClassName="test-action-label"
        onClose={onClose}
        surfaceProps={{ 'data-test-surface': 'true' }}
      />
    </>
  );
}

describe('AnchoredActionMenu', () => {
  test('renders a menu of the actions and forwards surface attributes', () => {
    const rendered = render([
      { label: 'Rename', onSelect: () => undefined },
      { label: 'Delete', onSelect: () => undefined, danger: true },
    ]);
    const surface = rendered.document.querySelector('.test-action-menu');
    expect(surface?.getAttribute('role')).toBe('menu');
    expect(surface?.getAttribute('aria-label')).toBe('Row actions');
    expect(surface?.getAttribute('data-test-surface')).toBe('true');

    const items = rendered.document.querySelectorAll('.test-action-menu [role="menuitem"]');
    expect(items).toHaveLength(2);
    expect(items[1]?.className).toContain('is-danger');
  });

  test('clicking an action fires onSelect and closes', async () => {
    const order: string[] = [];
    const rendered = render(
      [{ label: 'Rename', onSelect: () => order.push('select') }],
      () => order.push('close'),
    );
    const item = rendered.document.querySelector('.test-action-menu [role="menuitem"]');
    await click(rendered, item);
    // The menu closes first, then the action runs (matches the live ordering).
    expect(order).toEqual(['close', 'select']);
  });

  test('disabled actions render disabled', () => {
    const rendered = render([{ label: 'Configure', onSelect: () => undefined, disabled: true }]);
    const item = rendered.document.querySelector('.test-action-menu [role="menuitem"]') as HTMLButtonElement | null;
    expect(item?.disabled).toBe(true);
  });
});

function render(actions: AnchoredMenuAction[], onClose: () => void = () => undefined): Rendered {
  const { document, window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  installDomGlobals(window);
  const container = document.getElementById('root');
  if (!container) throw new Error('Missing root container');
  const root = createRoot(container);
  act(() => {
    root.render(<Fixture actions={actions} onClose={onClose} />);
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
    MouseEvent: window.MouseEvent,
    Node: window.Node,
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
}
