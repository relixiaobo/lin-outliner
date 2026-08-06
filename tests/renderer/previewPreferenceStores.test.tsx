import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import type { TranslationLanguage } from '../../src/core/translationLanguage';
import type { UrlPageTranslationPreferences } from '../../src/core/urlPageTranslation';
import {
  resetTranslationLanguagePreferenceForTests,
  setTranslationLanguagePreference,
  useTranslationLanguagePreference,
} from '../../src/renderer/ui/preview/translationLanguagePreference';
import {
  resetUrlPageTranslationPreferencesForTests,
  setAutoTranslateEpubs,
  setAutoTranslateUrls,
  setTranslationModel,
  useUrlPageTranslationPreferences,
} from '../../src/renderer/ui/preview/urlPageTranslationPreferences';

const DEFAULT_PREFERENCES: UrlPageTranslationPreferences = {
  translationModel: null,
  autoTranslateEpubs: false,
  autoTranslateUrls: false,
};

const GLOBAL_KEYS = ['document', 'window', 'navigator', 'Event', 'HTMLElement', 'Node'] as const;
let savedGlobals: Array<[string, PropertyDescriptor | undefined]> = [];
let savedActEnvironment: PropertyDescriptor | undefined;
let root: Root | null = null;
let urlState: ReturnType<typeof useUrlPageTranslationPreferences> | null = null;
let languageState: ReturnType<typeof useTranslationLanguagePreference> | null = null;

beforeEach(() => {
  resetTranslationLanguagePreferenceForTests();
  resetUrlPageTranslationPreferencesForTests();
  const parsed = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  savedGlobals = GLOBAL_KEYS.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  savedActEnvironment = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  for (const key of GLOBAL_KEYS) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value: parsed.window[key],
    });
  }
  Object.assign(parsed.window, {
    lin: {
      initialTranslationLanguage: 'en',
      initialUrlPageTranslationPreferences: DEFAULT_PREFERENCES,
      onTranslationLanguageChanged: () => () => undefined,
      onUrlPageTranslationPreferencesChanged: () => () => undefined,
    },
  });
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
    configurable: true,
    writable: true,
    value: true,
  });
  const container = parsed.document.getElementById('root');
  if (!container) throw new Error('Missing test root');
  root = createRoot(container);
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  urlState = null;
  languageState = null;
  resetTranslationLanguagePreferenceForTests();
  resetUrlPageTranslationPreferencesForTests();
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

function UrlProbe() {
  urlState = useUrlPageTranslationPreferences();
  return null;
}

function LanguageProbe() {
  languageState = useTranslationLanguagePreference();
  return null;
}

async function renderProbe(probe: 'url' | 'language'): Promise<void> {
  await act(async () => {
    root?.render(probe === 'url' ? <UrlProbe /> : <LanguageProbe />);
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

describe('preview preference stores', () => {
  test('rolls the language back when persistence fails', async () => {
    const saving = deferred<void>();
    Object.assign(window.lin!, {
      setTranslationLanguage: (_language: TranslationLanguage) => saving.promise,
    });
    await renderProbe('language');

    let write!: Promise<void>;
    await act(async () => {
      write = setTranslationLanguagePreference('zh-Hans');
    });
    expect(languageState?.language).toBe('zh-Hans');
    saving.reject(new Error('disk full'));
    await act(async () => { await write.catch(() => undefined); });
    expect(languageState?.language).toBe('en');
  });

  test('reconciles a successful URL preference write to the canonical response', async () => {
    const saving = deferred<UrlPageTranslationPreferences>();
    Object.assign(window.lin!, {
      setUrlPageTranslationPreferences: (_preferences: UrlPageTranslationPreferences) => saving.promise,
    });
    await renderProbe('url');

    let write!: Promise<void>;
    await act(async () => {
      write = setTranslationModel('openai/requested-model');
    });
    expect(urlState?.translationModel).toBe('openai/requested-model');
    saving.resolve({
      ...DEFAULT_PREFERENCES,
      translationModel: 'openai/canonical-model',
    });
    await act(async () => { await write; });
    expect(urlState?.translationModel).toBe('openai/canonical-model');
  });

  test('a failed field rolls back without contaminating a queued field write', async () => {
    const first = deferred<UrlPageTranslationPreferences>();
    const second = deferred<UrlPageTranslationPreferences>();
    const payloads: UrlPageTranslationPreferences[] = [];
    Object.assign(window.lin!, {
      setUrlPageTranslationPreferences: (preferences: UrlPageTranslationPreferences) => {
        payloads.push(preferences);
        return payloads.length === 1 ? first.promise : second.promise;
      },
    });
    await renderProbe('url');

    let urlWrite!: Promise<void>;
    let epubWrite!: Promise<void>;
    await act(async () => {
      urlWrite = setAutoTranslateUrls(true);
      epubWrite = setAutoTranslateEpubs(true);
    });
    expect(urlState?.autoTranslateUrls).toBe(true);
    expect(urlState?.autoTranslateEpubs).toBe(true);

    first.reject(new Error('first write failed'));
    await act(async () => { await urlWrite.catch(() => undefined); });
    expect(urlState?.autoTranslateUrls).toBe(false);
    expect(urlState?.autoTranslateEpubs).toBe(true);
    expect(payloads[1]).toEqual({
      ...DEFAULT_PREFERENCES,
      autoTranslateEpubs: true,
    });

    second.resolve(payloads[1]!);
    await act(async () => { await epubWrite; });
    expect(urlState?.autoTranslateUrls).toBe(false);
    expect(urlState?.autoTranslateEpubs).toBe(true);
  });

  test('two writes to one URL preference preserve the latest intent', async () => {
    const first = deferred<UrlPageTranslationPreferences>();
    const second = deferred<UrlPageTranslationPreferences>();
    const payloads: UrlPageTranslationPreferences[] = [];
    Object.assign(window.lin!, {
      setUrlPageTranslationPreferences: (preferences: UrlPageTranslationPreferences) => {
        payloads.push(preferences);
        return payloads.length === 1 ? first.promise : second.promise;
      },
    });
    await renderProbe('url');

    let enable!: Promise<void>;
    let disable!: Promise<void>;
    await act(async () => {
      enable = setAutoTranslateUrls(true);
      disable = setAutoTranslateUrls(false);
    });
    expect(urlState?.autoTranslateUrls).toBe(false);
    expect(payloads).toHaveLength(1);

    first.reject(new Error('stale write failed'));
    await act(async () => { await enable.catch(() => undefined); });
    expect(urlState?.autoTranslateUrls).toBe(false);
    expect(payloads[1]).toEqual(DEFAULT_PREFERENCES);

    second.resolve(DEFAULT_PREFERENCES);
    await act(async () => { await disable; });
    expect(urlState?.autoTranslateUrls).toBe(false);
  });

  test('two language writes preserve the latest intent when the first fails', async () => {
    const first = deferred<void>();
    const second = deferred<void>();
    const languages: TranslationLanguage[] = [];
    Object.assign(window.lin!, {
      setTranslationLanguage: (language: TranslationLanguage) => {
        languages.push(language);
        return languages.length === 1 ? first.promise : second.promise;
      },
    });
    await renderProbe('language');

    let firstWrite!: Promise<void>;
    let secondWrite!: Promise<void>;
    await act(async () => {
      firstWrite = setTranslationLanguagePreference('zh-Hans');
      secondWrite = setTranslationLanguagePreference('en');
    });
    expect(languageState?.language).toBe('en');

    first.reject(new Error('stale write failed'));
    await act(async () => { await firstWrite.catch(() => undefined); });
    expect(languageState?.language).toBe('en');
    expect(languages).toEqual(['zh-Hans', 'en']);

    second.resolve();
    await act(async () => { await secondWrite; });
    expect(languageState?.language).toBe('en');
  });
});
