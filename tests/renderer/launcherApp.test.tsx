import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { LauncherApp } from '../../src/renderer/launcher/LauncherApp';
import type { ExternalContext } from '../../src/core/launcher/context';
import { APP_NAME } from '../../src/core/brand';

// Component tests for the launcher's effectful interaction fixes (re-entrancy lock,
// capture routing, the IME guard, synchronous Enter, and the footer's
// status/hint split). The pure selection/list logic is covered in
// launcherModel.test.ts; here we drive the real component through a mocked
// `window.lin.launcher`.


interface LauncherMockOptions {
  hotkey?: string | null;
  /** What the capture IPC resolves to (the failure path keeps the launcher open). */
  captureOk?: boolean;
}

interface LauncherMock {
  calls: {
    executeCommand: unknown[];
    createContextCapture: { note?: unknown }[];
    createCapture: unknown[];
    openNode: string[];
    hide: number;
  };
  pushContext: (ctx: ExternalContext) => void;
  triggerShown: () => void;
  launcher: Record<string, unknown>;
}

function makeLauncherMock(options: LauncherMockOptions = {}): LauncherMock {
  const { hotkey = 'CommandOrControl+Shift+Space', captureOk = true } = options;
  const calls = { executeCommand: [] as unknown[], createContextCapture: [] as { note?: unknown }[], createCapture: [] as unknown[], openNode: [] as string[], hide: 0 };
  let contextCb: ((ctx: ExternalContext) => void) | null = null;
  let shownCb: (() => void) | null = null;
  const launcher = {
    getInitialState: async () => ({
      commands: [
        { id: 'open-main', title: 'Open main window' },
        { id: 'open-settings', title: 'Open Settings' },
      ],
      hotkey,
    }),
    onShown: (cb: () => void) => { shownCb = cb; return () => { shownCb = null; }; },
    onContext: (cb: (ctx: ExternalContext) => void) => { contextCb = cb; return () => { contextCb = null; }; },
    hide: () => { calls.hide++; },
    executeCommand: async (id: unknown) => { calls.executeCommand.push(id); return { hide: true }; },
    createCapture: async (payload: unknown) => { calls.createCapture.push(payload); return { ok: captureOk, nodeId: 'n1' }; },
    createContextCapture: async (payload: { note?: unknown }) => { calls.createContextCapture.push(payload); return { ok: captureOk, nodeId: 'n1' }; },
    searchNodes: async () => [],
    openNode: (id: string) => { calls.openNode.push(id); },
  };
  return { calls, launcher, pushContext: (ctx) => contextCb?.(ctx), triggerShown: () => shownCb?.() };
}

function webpageContext(): ExternalContext {
  return {
    id: 'ctx-1',
    capturedAt: '2026-06-04T00:00:00',
    captureOrigin: 'global-hotkey',
    app: { name: 'Safari' },
    browser: { name: 'Safari', hostname: 'example.com', url: 'https://example.com/post' },
    providerId: 'generic-webpage',
    confidence: 'probable',
    source: {
      kind: 'article',
      title: 'An Example Article',
      original: { kind: 'remote-url', url: 'https://example.com/post', preview: 'web-preview' },
      url: 'https://example.com/post',
      providerId: 'generic-webpage',
    },
    warnings: [],
    permissions: [],
  };
}

interface Rendered { cleanup: () => void; document: Document; window: Window & typeof globalThis; mock: LauncherMock; }
const mounted: Rendered[] = [];
afterEach(() => { while (mounted.length) mounted.pop()?.cleanup(); });

function installDomGlobals(window: Window & typeof globalThis, mock: LauncherMock) {
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
  // linkedom has no layout or focus model — stub what the show path touches
  // (scrollIntoView for the active row, focus/select for the always-on input).
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  if (!proto.scrollIntoView) proto.scrollIntoView = () => {};
  if (!proto.focus) proto.focus = () => {};
  if (!proto.select) proto.select = () => {};
  (window as unknown as { lin: unknown }).lin = { launcher: mock.launcher };
}

async function renderLauncher(options: LauncherMockOptions = {}): Promise<Rendered> {
  const { document, window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>') as unknown as { document: Document; window: Window & typeof globalThis };
  const mock = makeLauncherMock(options);
  installDomGlobals(window, mock);
  const container = document.getElementById('root')!;
  const root: Root = createRoot(container);
  await act(async () => { root.render(<LauncherApp />); });
  // Flush getInitialState().then(setState) so the command rows exist.
  await act(async () => {});
  const rendered: Rendered = { cleanup: () => act(() => root.unmount()), document, window, mock };
  mounted.push(rendered);
  return rendered;
}

function rows(r: Rendered): HTMLElement[] {
  return Array.from(r.document.querySelectorAll<HTMLElement>('[role="option"]'));
}

function statusText(r: Rendered): string {
  return r.document.querySelector<HTMLElement>('.launcher-actionbar-status')?.textContent ?? '';
}

function primaryHintText(r: Rendered): string {
  return r.document.querySelector<HTMLElement>('.launcher-actionbar-primary')?.textContent ?? '';
}

function selectedTitles(r: Rendered): (string | null | undefined)[] {
  return rows(r)
    .filter((row) => row.getAttribute('aria-selected') === 'true')
    .map((row) => row.querySelector('.launcher-row-title')?.textContent);
}

async function pressKey(r: Rendered, key: string, options: { composing?: boolean } = {}) {
  const dialog = r.document.querySelector<HTMLElement>('.launcher')!;
  await act(async () => {
    const ev = new r.window.Event('keydown', { bubbles: true }) as Event & { key: string; keyCode?: number };
    ev.key = key;
    // React's synthetic event carries no `isComposing`, so the shipped guard keys
    // on the legacy 229 / 'Process' fallbacks — which is what an IME actually
    // sends for the composition-commit keystroke.
    if (options.composing) ev.keyCode = 229;
    dialog.dispatchEvent(ev);
  });
}

describe('LauncherApp interaction', () => {
  test('loads commands into uniform rows', async () => {
    const r = await renderLauncher();
    const titles = rows(r).map((row) => row.querySelector('.launcher-row-title')?.textContent);
    expect(titles).toContain('Open main window');
    expect(titles).toContain('Open Settings');
  });

  test('a double-click on a command row fires the action only once (re-entrancy lock)', async () => {
    const r = await renderLauncher();
    const first = rows(r)[0];
    await act(async () => {
      first.dispatchEvent(new r.window.Event('click', { bubbles: true }));
      first.dispatchEvent(new r.window.Event('click', { bubbles: true }));
    });
    expect(r.mock.calls.executeCommand).toEqual(['open-main']);
  });

  test('Enter on a page-capture row routes to createContextCapture, not a command', async () => {
    // Wiring coverage for the capture-page branch of runAction: with a captured
    // page context present, the top (capture-first) row's Enter must hit
    // createContextCapture — never executeCommand. The note that rides along comes
    // from the query and is derived/covered purely in launcherModel.test.ts
    // (buildLauncherItems); we don't re-assert it here because React's controlled
    // onChange does not fire under linkedom (no full DOM value-tracking), so the
    // typed note isn't drivable through the input in this environment.
    const r = await renderLauncher();
    await act(async () => { r.mock.pushContext(webpageContext()); });

    await pressKey(r, 'Enter');
    expect(r.mock.calls.createContextCapture).toHaveLength(1);
    expect(r.mock.calls.createContextCapture[0]).toEqual({ note: undefined });
    expect(r.mock.calls.executeCommand).toHaveLength(0);
  });
});

describe('LauncherApp IME composition guard', () => {
  test('Enter committing an IME candidate fires no action', async () => {
    const r = await renderLauncher();
    await act(async () => { r.mock.pushContext(webpageContext()); });

    await pressKey(r, 'Enter', { composing: true });
    expect(r.mock.calls.createContextCapture).toHaveLength(0);
    expect(r.mock.calls.executeCommand).toHaveLength(0);
    expect(r.mock.calls.hide).toBe(0);
  });

  test('arrows during composition belong to the IME — selection does not move', async () => {
    const r = await renderLauncher();
    const before = selectedTitles(r);
    expect(before).toHaveLength(1);

    await pressKey(r, 'ArrowDown', { composing: true });
    expect(selectedTitles(r)).toEqual(before);

    // The same key without a composition does move it — the guard is the only
    // difference, not a broken key path.
    await pressKey(r, 'ArrowDown');
    expect(selectedTitles(r)).not.toEqual(before);
  });

  test('Escape during composition does not hide the window; a later Escape does', async () => {
    const r = await renderLauncher();
    await pressKey(r, 'Escape', { composing: true });
    expect(r.mock.calls.hide).toBe(0);

    await pressKey(r, 'Escape');
    expect(r.mock.calls.hide).toBe(1);
  });
});

// The show→context race is deliberately NOT mitigated in this renderer — a
// renderer-side wait was removed after review (cancelled actions still fired,
// one intent ran two actions, half-typed text got captured). Enter therefore
// stays synchronous; `unified-command-surface` PR 2 fixes the race at its source.
describe('LauncherApp Enter is synchronous', () => {
  test('Enter acts on the row that is showing, with no deferred continuation', async () => {
    const r = await renderLauncher();
    await act(async () => { r.mock.triggerShown(); });

    expect(rows(r)[0]?.querySelector('.launcher-row-title')?.textContent).toBe('Open main window');
    await pressKey(r, 'Enter');
    expect(r.mock.calls.executeCommand).toEqual(['open-main']);

    // A context arriving afterwards must not retro-fire a second action.
    await act(async () => { r.mock.pushContext(webpageContext()); });
    expect(r.mock.calls.createContextCapture).toHaveLength(0);
    expect(r.mock.calls.executeCommand).toEqual(['open-main']);
  });

  test('with the context already in, Enter captures the page', async () => {
    const r = await renderLauncher();
    await act(async () => { r.mock.triggerShown(); });
    await act(async () => { r.mock.pushContext(webpageContext()); });

    await pressKey(r, 'Enter');
    expect(r.mock.calls.createContextCapture).toHaveLength(1);
    expect(r.mock.calls.executeCommand).toHaveLength(0);
  });
});

describe('LauncherApp footer', () => {
  test('at rest the status zone is the identity: the app mark plus the formatted hotkey', async () => {
    const r = await renderLauncher();
    expect(statusText(r)).toContain(APP_NAME);
    expect(statusText(r)).toContain('⌘⇧␣');
  });

  test('no hotkey registered → the identity renders without one (nothing to teach)', async () => {
    const r = await renderLauncher({ hotkey: null });
    expect(statusText(r)).toContain(APP_NAME);
    expect(statusText(r)).not.toContain('⌘');
  });

  test('the primary hint states the verb for a command row, not the row title', async () => {
    const r = await renderLauncher();
    expect(rows(r)[0]?.querySelector('.launcher-row-title')?.textContent).toBe('Open main window');
    expect(primaryHintText(r)).toContain('Open');
    expect(primaryHintText(r)).not.toContain('Open main window');
  });

  test('a capture failure shows in the status zone while the hint still names the action', async () => {
    const r = await renderLauncher({ captureOk: false });
    await act(async () => { r.mock.pushContext(webpageContext()); });

    await pressKey(r, 'Enter');
    expect(statusText(r)).toContain('Save failed.');
    // The error never replaces the action label inside the clickable hint.
    expect(primaryHintText(r)).toContain('Capture page to Today');
    expect(primaryHintText(r)).not.toContain('Save failed.');
    // A failed capture keeps the launcher open so the user can retry.
    expect(r.mock.calls.hide).toBe(0);
  });
});
