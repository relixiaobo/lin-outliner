import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import type { ClearPreviewTranslationCacheResult } from '../../src/core/urlPageTranslation';
import { TranslationDataSettingsGroup } from '../../src/renderer/ui/agent/TranslationDataSettingsGroup';

interface Rendered {
  cleanup: () => void;
  document: Document;
}

const mounted: Rendered[] = [];
const GLOBAL_KEYS = ['document', 'window', 'navigator', 'Event', 'HTMLElement', 'MouseEvent', 'Node'] as const;
let savedGlobals: Array<[string, PropertyDescriptor | undefined]> = [];

afterEach(() => {
  while (mounted.length) mounted.pop()?.cleanup();
  for (const [key, descriptor] of savedGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as Record<string, unknown>)[key];
  }
  savedGlobals = [];
});

describe('TranslationDataSettingsGroup', () => {
  test('keeps a stable busy row and reports a completed clear', async () => {
    let resolveClear: ((result: ClearPreviewTranslationCacheResult) => void) | null = null;
    const clearResult = new Promise<ClearPreviewTranslationCacheResult>((resolve) => {
      resolveClear = resolve;
    });
    const errors: Array<string | null> = [];
    const notices: Array<string | null> = [];
    const rendered = renderComponent(() => clearResult, errors, notices);
    const button = rendered.document.querySelector<HTMLButtonElement>('button');
    if (!button) throw new Error('Missing clear button');

    act(() => button.click());
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe('Clearing…');
    expect(rendered.document.querySelectorAll('.inset-row')).toHaveLength(1);

    await act(async () => {
      resolveClear?.({ status: 'cleared' });
      await clearResult;
    });

    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe('Clear…');
    expect(errors).toEqual([null]);
    expect(notices).toEqual([null, 'Saved translations cleared.']);
  });

  test('leaves alerts empty when the native confirmation is canceled', async () => {
    const errors: Array<string | null> = [];
    const notices: Array<string | null> = [];
    const rendered = renderComponent(async () => ({ status: 'canceled' }), errors, notices);
    const button = rendered.document.querySelector<HTMLButtonElement>('button');
    if (!button) throw new Error('Missing clear button');

    await act(async () => {
      button.click();
      await Promise.resolve();
    });

    expect(errors).toEqual([null]);
    expect(notices).toEqual([null]);
  });

  test.each([
    [{ status: 'failed', error: 'unavailable' }, 'Saved translations are unavailable in this window.'],
    [{ status: 'failed', error: 'clear-failed' }, 'Could not clear saved translations.'],
  ] as const)('uses a bounded localized error for %j', async (result, expectedError) => {
    const errors: Array<string | null> = [];
    const notices: Array<string | null> = [];
    const rendered = renderComponent(async () => result, errors, notices);
    const button = rendered.document.querySelector<HTMLButtonElement>('button');
    if (!button) throw new Error('Missing clear button');

    await act(async () => {
      button.click();
      await Promise.resolve();
    });

    expect(errors.at(-1)).toBe(expectedError);
    expect(notices).toEqual([null]);
  });
});

function renderComponent(
  clearPreviewTranslationCache: () => Promise<ClearPreviewTranslationCacheResult>,
  errors: Array<string | null>,
  notices: Array<string | null>,
): Rendered {
  const { document, window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  installDomGlobals(window);
  Object.assign(window, {
    lin: { clearPreviewTranslationCache },
  });

  const container = document.getElementById('root');
  if (!container) throw new Error('Missing root container');
  const root = createRoot(container);
  act(() => {
    root.render(
      <TranslationDataSettingsGroup
        onError={(message) => errors.push(message)}
        onNotice={(message) => notices.push(message)}
      />,
    );
  });

  const rendered = {
    cleanup: () => act(() => root.unmount()),
    document,
  };
  mounted.push(rendered);
  return rendered;
}

function installDomGlobals(window: Window): void {
  for (const key of GLOBAL_KEYS) {
    savedGlobals.push([key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  }
  Object.assign(globalThis, {
    document: window.document,
    window,
    Event: window.Event,
    HTMLElement: window.HTMLElement,
    MouseEvent: window.MouseEvent,
    Node: window.Node,
  });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: window.navigator });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
}
