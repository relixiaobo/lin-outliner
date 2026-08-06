import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { SettingsAboutSection } from '../../src/renderer/ui/agent/SettingsAboutSection';

const CHANGELOG_FIXTURE = `# Changelog

## [Unreleased]

Next release is taking shape.

### Internal

- Private implementation detail.

### Fixed

- Next public fix.

## [0.1.0] - 2026-08-05

**Welcome to Tenon 0.1.** See the [details](https://example.com/release).

### Added

- Current public engineering entry.

### Internal

- Private packaging detail.
`;

const GLOBAL_KEYS = ['document', 'window', 'navigator', 'Event', 'HTMLElement', 'MouseEvent', 'Node'] as const;
let savedGlobals: Array<[string, PropertyDescriptor | undefined]> = [];
let savedActEnvironment: PropertyDescriptor | undefined;
let root: Root | null = null;
let document: Document;

beforeEach(() => {
  const parsed = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  document = parsed.document;
  savedGlobals = GLOBAL_KEYS.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  savedActEnvironment = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  for (const key of GLOBAL_KEYS) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value: parsed.window[key],
    });
  }
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
    configurable: true,
    writable: true,
    value: true,
  });
  Object.assign(parsed.window, {
    lin: {
      appInfo: async () => ({
        name: 'Tenon',
        version: '0.1.0',
        platform: 'darwin',
        arch: 'arm64',
        electron: '39.0.0',
        chrome: '142.0.0',
        node: '22.0.0',
      }),
      invoke: async () => ({ opened: true }),
    },
  });
  const container = document.getElementById('root');
  if (!container) throw new Error('Missing test root');
  root = createRoot(container);
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  for (const [key, descriptor] of savedGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as Record<string, unknown>)[key];
  }
  if (savedActEnvironment) {
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', savedActEnvironment);
  } else {
    delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  }
});

async function renderAbout(changelog = CHANGELOG_FIXTURE): Promise<void> {
  await act(async () => {
    root?.render(
      <SettingsAboutSection
        loadChangelog={async () => changelog}
        onError={() => undefined}
        onNotice={() => undefined}
      />,
    );
  });
  await act(async () => { await Promise.resolve(); });
}

function openedUrls(): string[] {
  const opened: string[] = [];
  if (!window.lin) throw new Error('Missing test bridge');
  window.lin.invoke = (async (channel: string, payload: unknown) => {
    opened.push(String((payload as { url?: string } | undefined)?.url ?? channel));
    return { opened: true };
  }) as typeof window.lin.invoke;
  return opened;
}

describe('SettingsAboutSection', () => {
  test('shows the running version\'s note inline and no category detail', async () => {
    await renderAbout();

    const releasePicker = document.querySelector<HTMLSelectElement>('select[aria-label="Release notes version"]');
    expect(releasePicker?.value).toBe('0.1.0');
    // The note is the pane's content, not something behind a disclosure.
    const note = document.querySelector('[role="region"][aria-label="What’s new in 0.1.0 - 2026-08-05"]');
    expect(note?.textContent).toContain('Welcome to Tenon 0.1.');
    expect([...document.querySelectorAll('button')].map((button) => button.getAttribute('aria-expanded')))
      .not.toContain('false');

    // Nothing below the note's first `###` may reach a user surface.
    expect(document.querySelectorAll('h3')).toHaveLength(0);
    expect(document.body.textContent).not.toContain('Added');
    expect(document.body.textContent).not.toContain('Current public engineering entry.');
    expect(document.body.textContent).not.toContain('Private packaging detail.');
    expect(document.body.textContent).not.toContain('Next public fix.');
  });

  test('switches releases and pins the full-changelog link to the selected tag', async () => {
    await renderAbout();
    const opened = openedUrls();

    const fullChangelog = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('Full changelog'));
    await act(async () => { fullChangelog?.click(); });
    expect(opened.at(-1)).toBe(
      'https://github.com/relixiaobo/lin-outliner/blob/v0.1.0/CHANGELOG.md#010---2026-08-05',
    );

    const releasePicker = document.querySelector<HTMLSelectElement>('select[aria-label="Release notes version"]');
    await act(async () => {
      if (!releasePicker) throw new Error('Missing release picker');
      Object.defineProperty(releasePicker, 'value', {
        configurable: true,
        value: 'Unreleased',
      });
      releasePicker.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(document.body.textContent).toContain('Next release is taking shape.');
    expect(document.body.textContent).not.toContain('Welcome to Tenon 0.1.');
    expect(document.body.textContent).not.toContain('Private implementation detail.');
    await act(async () => { fullChangelog?.click(); });
    // A development build has no tag to pin to, so it reads the live file.
    expect(opened.at(-1)).toBe('https://github.com/relixiaobo/lin-outliner/blob/main/CHANGELOG.md#unreleased');
  });

  test('falls back to the link alone for a section written before the convention', async () => {
    await renderAbout(`# Changelog

## [0.1.0] - 2026-08-05

### Added

- Only engineering detail here.
`);

    expect(document.body.textContent).toContain('Full changelog');
    expect(document.body.textContent).not.toContain('Only engineering detail here.');
    expect(document.body.textContent).not.toContain('Added');
    expect(document.querySelector('[role="region"]')).toBeNull();
  });

  test('omits the identity group when app info cannot be loaded', async () => {
    if (!window.lin) throw new Error('Missing test bridge');
    window.lin.appInfo = async () => { throw new Error('unavailable'); };

    await act(async () => {
      root?.render(
        <SettingsAboutSection
          loadChangelog={async () => CHANGELOG_FIXTURE}
          onError={() => undefined}
          onNotice={() => undefined}
        />,
      );
    });
    await act(async () => { await Promise.resolve(); });

    expect(document.getElementById('version')).toBeNull();
    expect(document.body.textContent).toContain('Support');
  });

  test('reports a localized copy failure and keeps raw diagnostics out of the UI', async () => {
    const errors: Array<string | null> = [];
    const reports: unknown[] = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async () => { throw new Error('native clipboard detail'); },
      },
    });
    if (!window.lin) throw new Error('Missing test bridge');
    window.lin.reportRendererError = (report) => { reports.push(report); };

    await act(async () => {
      root?.render(
        <SettingsAboutSection
          loadChangelog={async () => CHANGELOG_FIXTURE}
          onError={(message) => errors.push(message)}
          onNotice={() => undefined}
        />,
      );
    });
    await act(async () => { await Promise.resolve(); });
    const copy = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('Copy version info'));
    await act(async () => {
      copy?.click();
      await Promise.resolve();
    });

    expect(errors.at(-1)).toBe('Could not copy version info.');
    expect(document.body.textContent).not.toContain('native clipboard detail');
    expect(reports).toHaveLength(1);
  });
});
