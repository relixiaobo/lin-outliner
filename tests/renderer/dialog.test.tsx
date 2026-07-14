import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { Dialog } from '../../src/renderer/ui/primitives/Dialog';

interface Rendered {
  cleanup: () => void;
  container: HTMLElement;
  document: Document;
  renderFocusKey: (focusKey: string) => void;
}

const mounted: Rendered[] = [];
const GLOBAL_KEYS = ['document', 'window', 'HTMLElement', 'Node'] as const;
let savedGlobals: Array<[string, PropertyDescriptor | undefined]> = [];

afterEach(() => {
  while (mounted.length) mounted.pop()?.cleanup();
  for (const [key, descriptor] of savedGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as Record<string, unknown>)[key];
  }
  savedGlobals = [];
});

describe('Dialog', () => {
  test('dismisses from backdrop clicks but not surface clicks', () => {
    let dismissCount = 0;
    const rendered = renderDialog(() => {
      dismissCount += 1;
    });

    act(() => {
      dispatchMouseDown(rendered.document, rendered.document.querySelector<HTMLElement>('.dialog-surface'));
    });
    expect(dismissCount).toBe(0);

    act(() => {
      dispatchMouseDown(rendered.document, rendered.document.querySelector<HTMLElement>('.dialog-backdrop'));
    });
    expect(dismissCount).toBe(1);
  });

  test('pulls focus back into the dialog after an in-place content swap', () => {
    const rendered = renderDialog(() => undefined);
    const surface = rendered.document.querySelector<HTMLElement>('.dialog-surface');
    const previousButton = rendered.document.querySelector<HTMLElement>('[data-focus-key="initial"]');
    let focusCount = 0;
    if (surface) surface.focus = () => { focusCount += 1; };

    act(() => rendered.renderFocusKey('nested'));

    expect(previousButton?.isConnected).toBe(false);
    expect(focusCount).toBe(1);
  });
});

function renderDialog(onBackdropMouseDown: () => void): Rendered {
  const { document, window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  const { restore } = installDomGlobals(window);
  const container = document.getElementById('root');
  if (!container) throw new Error('Missing root container');

  const root = createRoot(container);
  const renderFocusKey = (focusKey: string) => {
    root.render(
      <Dialog
        backdropClassName="dialog-backdrop"
        focusKey={focusKey}
        label="Test dialog"
        onBackdropMouseDown={onBackdropMouseDown}
        surfaceClassName="dialog-surface"
      >
        <button data-focus-key={focusKey} key={focusKey} type="button">Inside</button>
      </Dialog>,
    );
  };
  act(() => {
    renderFocusKey('initial');
  });

  const rendered: Rendered = {
    cleanup: () => {
      act(() => root.unmount());
      restore();
    },
    container,
    document,
    renderFocusKey,
  };
  mounted.push(rendered);
  return rendered;
}

function dispatchMouseDown(document: Document, target: HTMLElement | null) {
  if (!target) throw new Error('Missing event target');
  const event = document.createEvent('Event');
  event.initEvent('mousedown', true, true);
  target.dispatchEvent(event);
}

function installDomGlobals(window: Window) {
  savedGlobals = GLOBAL_KEYS.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  savedGlobals.push([
    'IS_REACT_ACT_ENVIRONMENT',
    Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT'),
  ]);
  for (const key of GLOBAL_KEYS) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: window[key],
      writable: true,
    });
  }
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
    configurable: true,
    value: true,
    writable: true,
  });
  return {
    restore: () => {
      for (const [key, descriptor] of savedGlobals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete (globalThis as Record<string, unknown>)[key];
      }
    },
  };
}
