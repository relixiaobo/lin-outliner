import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { SettingsAboutSection } from '../../src/renderer/ui/agent/SettingsAboutSection';

const CHANGELOG_FIXTURE = `# Changelog

## [Unreleased]

### Internal

- Private implementation detail.

### Fixed

- Next public fix.

## [0.1.0] - 2026-08-05

### Added

- Current public feature with [details](https://example.com/release).

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

describe('SettingsAboutSection', () => {
  test('selects the running version, omits Internal, and switches releases', async () => {
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

    const releasePicker = document.querySelector<HTMLSelectElement>('select[aria-label="Release notes version"]');
    expect(releasePicker?.value).toBe('0.1.0');
    const disclosure = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('Release notes'));
    expect(disclosure?.getAttribute('aria-expanded')).toBe('false');
    expect(document.body.textContent).not.toContain('Current public feature with details.');

    await act(async () => { disclosure?.click(); });
    expect(disclosure?.getAttribute('aria-expanded')).toBe('true');
    expect(document.body.textContent).toContain('Current public feature with details.');
    expect(document.body.textContent).not.toContain('Private packaging detail.');
    expect(document.body.textContent).not.toContain('Next public fix.');

    await act(async () => {
      if (!releasePicker) throw new Error('Missing release picker');
      Object.defineProperty(releasePicker, 'value', {
        configurable: true,
        value: 'Unreleased',
      });
      releasePicker.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(disclosure?.getAttribute('aria-expanded')).toBe('false');
    expect(document.body.textContent).not.toContain('Next public fix.');
    await act(async () => { disclosure?.click(); });
    expect(document.body.textContent).toContain('Next public fix.');
    expect(document.body.textContent).not.toContain('Private implementation detail.');
    expect(document.body.textContent).not.toContain('Current public feature');
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
