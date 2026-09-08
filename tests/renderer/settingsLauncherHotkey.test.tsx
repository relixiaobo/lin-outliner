import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { I18nProvider } from '../../src/renderer/i18n/I18nProvider';
import { SettingsGeneralSection } from '../../src/renderer/ui/agent/SettingsGeneralSection';

// General owns only the discoverable route. The dedicated Shortcut Manager is
// the editor over the public keybindings source.

interface Rendered { cleanup: () => void; document: Document; }
const mounted: Rendered[] = [];
afterEach(() => { while (mounted.length) mounted.pop()?.cleanup(); });

async function renderGeneral(onOpenPage: (page: string) => void): Promise<Rendered> {
  const { document, window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>') as unknown as { document: Document; window: Window & typeof globalThis };
  Object.assign(globalThis, {
    document: window.document,
    window,
    HTMLElement: window.HTMLElement,
    KeyboardEvent: window.KeyboardEvent,
    MouseEvent: window.MouseEvent,
    Event: window.Event,
    Node: window.Node,
  });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  (window as unknown as { lin: unknown }).lin = {
    initialLanguage: 'en',
    getTheme: async () => 'system',
  };
  const container = document.getElementById('root')!;
  const root: Root = createRoot(container);
  await act(async () => {
    root.render(
      <I18nProvider>
        <SettingsGeneralSection onError={() => {}} onNotice={() => {}} onOpenPage={onOpenPage as never} />
      </I18nProvider>,
    );
  });
  // Flush the getTheme read.
  await act(async () => {});
  const rendered: Rendered = { cleanup: () => act(() => root.unmount()), document };
  mounted.push(rendered);
  return rendered;
}

describe('Settings → General: Keyboard Shortcuts', () => {
  test('opens the dedicated Shortcut Manager instead of rendering a read-only hotkey', async () => {
    const opened: string[] = [];
    const r = await renderGeneral((page) => opened.push(page));
    const row = Array.from(r.document.querySelectorAll<HTMLButtonElement>('.inset-row-main'))
      .find((candidate) => candidate.textContent?.includes('Keyboard Shortcuts'));
    expect(row).toBeDefined();
    expect(row?.textContent).toContain('system-wide launcher');
    expect(r.document.body.textContent).not.toContain('Not available');
    await act(async () => row?.click());
    expect(opened).toEqual(['shortcuts']);
  });
});
