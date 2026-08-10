import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { SettingsAboutSection } from '../../src/renderer/ui/agent/SettingsAboutSection';
import type { AppUpdateView } from '../../src/core/appUpdate';

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

async function renderAbout(
  changelog = CHANGELOG_FIXTURE,
  appUpdate: AppUpdateView | null = null,
  onAppUpdateChange: (view: AppUpdateView) => void = () => undefined,
): Promise<void> {
  await act(async () => {
    root?.render(
      <SettingsAboutSection
        appUpdate={appUpdate}
        loadChangelog={async () => changelog}
        onAppUpdateChange={onAppUpdateChange}
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
  test('shows a cached update note and uses URL-free update commands', async () => {
    if (!window.lin) throw new Error('Missing test bridge');
    const calls: string[] = [];
    const state: AppUpdateView = {
      currentVersion: '0.1.0',
      automaticChecksEnabled: true,
      phase: 'idle',
      lastSuccessfulCheckAt: 1_800_000_000_000,
      availableRelease: {
        version: '0.2.0',
        publishedAt: '2026-08-10T00:00:00Z',
        note: '**Quieter updates.** No prompts outside Settings.\n\n![Release art](https://example.com/release.png)',
        downloadAvailable: true,
      },
      manualError: null,
    };
    window.lin.appUpdate = {
      get: async () => state,
      check: async () => { calls.push('check'); return state; },
      setAutomaticChecksEnabled: async (enabled) => {
        calls.push(`automatic:${enabled}`);
        return { ...state, automaticChecksEnabled: enabled };
      },
      open: async () => { calls.push('open'); return { ok: true, destination: 'download' }; },
      onChanged: () => () => undefined,
    };
    const projected: AppUpdateView[] = [];
    await renderAbout(CHANGELOG_FIXTURE, state, (view) => projected.push(view));

    const updateGroup = document.querySelector('[data-settings-anchor="software-update"]');
    expect(updateGroup?.textContent).toContain('Tenon 0.2.0 is available');
    expect(updateGroup?.textContent).toContain('Quieter updates. No prompts outside Settings.');
    expect(updateGroup?.innerHTML).not.toContain('github.com');
    expect(updateGroup?.querySelector('img')).toBeNull();
    expect(updateGroup?.textContent).toContain('Release art');

    const download = [...updateGroup!.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('Download update'));
    const check = [...updateGroup!.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('Check now'));
    const automatic = updateGroup!.querySelector<HTMLButtonElement>('[role="switch"]');
    await act(async () => {
      download?.click();
      check?.click();
      automatic?.click();
      await Promise.resolve();
    });

    expect(calls).toEqual(['open', 'check', 'automatic:false']);
    expect(projected.at(-1)?.automaticChecksEnabled).toBeFalse();
  });

  test('keeps an explicit timeout inside the Software Update group', async () => {
    const state: AppUpdateView = {
      currentVersion: '0.1.0',
      automaticChecksEnabled: true,
      phase: 'idle',
      lastSuccessfulCheckAt: null,
      availableRelease: null,
      manualError: 'timeout',
    };
    await renderAbout(CHANGELOG_FIXTURE, state);

    const updateGroup = document.querySelector('[data-settings-anchor="software-update"]');
    expect(updateGroup?.querySelector('[role="alert"]')?.textContent)
      .toBe('The update check timed out. Try again.');
    expect(document.querySelector('.agent-settings-feedback')).toBeNull();
  });

  test('heads What\'s New with the running version and shows its note inline', async () => {
    await renderAbout();

    // The heading names the version the person is running — no picker, and none
    // of the changelog's own bookkeeping for it.
    expect(document.querySelector('[data-settings-anchor="whats-new"] .inset-group-header')?.textContent)
      .toBe('What’s new in 0.1.0');
    expect(document.querySelector('select')).toBeNull();
    expect(document.body.textContent).not.toContain('Unreleased');
    expect(document.body.textContent).not.toContain('development');

    // The note is the pane's content, not something behind a disclosure.
    expect(document.querySelector('.settings-about-release-note')?.textContent)
      .toContain('Welcome to Tenon 0.1.');
    expect([...document.querySelectorAll('button')].map((button) => button.getAttribute('aria-expanded')))
      .not.toContain('false');

    // Nothing below the note's first `###` may reach a user surface.
    expect(document.querySelectorAll('h3')).toHaveLength(0);
    expect(document.body.textContent).not.toContain('Added');
    expect(document.body.textContent).not.toContain('Current public engineering entry.');
    expect(document.body.textContent).not.toContain('Private packaging detail.');
    expect(document.body.textContent).not.toContain('Next public fix.');
  });

  test('pins the full-changelog link to the tag the build shipped as', async () => {
    await renderAbout();
    const opened = openedUrls();

    const fullChangelog = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('Full changelog'));
    await act(async () => { fullChangelog?.click(); });
    expect(opened.at(-1)).toBe(
      'https://github.com/relixiaobo/lin-outliner/blob/v0.1.0/CHANGELOG.md#010---2026-08-05',
    );
  });

  // A build ahead of the last release must never fall through to Unreleased:
  // its opening block is the maintainer line naming the train `main` is on, and
  // rendering it as a note is what shipped "`main` is the `0.2.0` train; entries
  // here move under the next tag" as somebody's What's New.
  test('a development build shows the newest released note, never Unreleased', async () => {
    if (!window.lin) throw new Error('Missing test bridge');
    const appInfo = window.lin.appInfo;
    window.lin.appInfo = async () => ({ ...(await appInfo!()), version: '0.2.0' });
    await renderAbout();
    const opened = openedUrls();

    expect(document.querySelector('[data-settings-anchor="whats-new"] .inset-group-header')?.textContent)
      .toBe('What’s new in 0.1.0');
    expect(document.body.textContent).toContain('Welcome to Tenon 0.1.');
    expect(document.body.textContent).not.toContain('Next release is taking shape.');
    expect(document.body.textContent).not.toContain('Unreleased');

    const fullChangelog = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('Full changelog'));
    await act(async () => { fullChangelog?.click(); });
    expect(opened.at(-1)).toBe(
      'https://github.com/relixiaobo/lin-outliner/blob/v0.1.0/CHANGELOG.md#010---2026-08-05',
    );
  });

  test('shows nothing at all when no release carries a note', async () => {
    await renderAbout(`# Changelog

## [Unreleased]

\`main\` is the 0.2.0 train; entries here move under the next tag.
`);

    expect(document.querySelector('[data-settings-anchor="whats-new"]')).toBeNull();
    expect(document.body.textContent).not.toContain('0.2.0 train');
    // The rest of About still stands.
    expect(document.body.textContent).toContain('Support');
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
    expect(document.querySelector('.settings-about-release-note')).toBeNull();
  });

  test('still names a release when app info does not load', async () => {
    if (!window.lin) throw new Error('Missing test bridge');
    window.lin.appInfo = async () => { throw new Error('unavailable'); };

    await renderAbout();

    expect(document.querySelector('[data-settings-anchor="whats-new"] .inset-group-header')?.textContent)
      .toBe('What’s new in 0.1.0');
    expect(document.body.textContent).toContain('Welcome to Tenon 0.1.');
    expect(document.body.textContent).not.toContain('Unreleased');
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
