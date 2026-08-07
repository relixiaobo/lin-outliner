import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { I18nProvider } from '../../src/renderer/i18n/I18nProvider';
import { SettingsGeneralSection } from '../../src/renderer/ui/agent/SettingsGeneralSection';

// Settings → General states the global launcher's registered accelerator. The
// row is read-only (main owns registration); its whole job is to make the
// keystroke discoverable — and to say so when no candidate was free, because
// then the launcher is unreachable with nothing else to indicate it.

interface Rendered { cleanup: () => void; document: Document; }
const mounted: Rendered[] = [];
afterEach(() => { while (mounted.length) mounted.pop()?.cleanup(); });

async function renderGeneral(hotkey: string | null): Promise<Rendered> {
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
    getLauncherHotkey: async () => hotkey,
  };
  const container = document.getElementById('root')!;
  const root: Root = createRoot(container);
  await act(async () => {
    root.render(
      <I18nProvider>
        <SettingsGeneralSection onError={() => {}} onNotice={() => {}} onOpenPage={() => {}} />
      </I18nProvider>,
    );
  });
  // Flush the getTheme / getLauncherHotkey reads.
  await act(async () => {});
  const rendered: Rendered = { cleanup: () => act(() => root.unmount()), document };
  mounted.push(rendered);
  return rendered;
}

function shortcutsGroupText(r: Rendered): string {
  const group = Array.from(r.document.querySelectorAll<HTMLElement>('.inset-card'))
    .find((card) => card.textContent?.includes('Global launcher'));
  return group?.textContent ?? '';
}

describe('Settings → General: global launcher hotkey', () => {
  test('renders the registered accelerator as macOS key symbols', async () => {
    const r = await renderGeneral('CommandOrControl+Shift+Space');
    const text = shortcutsGroupText(r);
    expect(text).toContain('Global launcher');
    expect(text).toContain('⌘⇧Space');
    expect(text).not.toContain('Not available');
  });

  test('no accelerator registered → quiet warning copy naming the fix, no value', async () => {
    const r = await renderGeneral(null);
    const text = shortcutsGroupText(r);
    expect(text).toContain('Global launcher');
    expect(text).toContain('Not available');
    expect(text).toContain('Quit the conflicting app and relaunch Tenon.');
    expect(text).not.toContain('⌘');
    // Informational, not destructive: no danger styling anywhere in the row.
    const row = Array.from(r.document.querySelectorAll<HTMLElement>('.inset-row'))
      .find((candidate) => candidate.textContent?.includes('Global launcher'));
    expect(row?.querySelector('.inset-row-feedback')).toBeNull();
  });
});
