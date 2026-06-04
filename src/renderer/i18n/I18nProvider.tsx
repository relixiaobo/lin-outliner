import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { DEFAULT_LOCALE, type Locale } from '../../core/locale';
import { DEFAULT_MESSAGES, getMessages, type Messages } from '../../core/i18n';

// Renderer-side i18n. Each renderer entry (main app, launcher, settings) wraps its
// tree in <I18nProvider>; components read strings with useT() and the picker uses
// useI18n().setLocale. Unlike the theme (CSS-driven, no provider), language needs a
// React provider so changing it re-renders every consumer. See core/locale.ts and
// docs/plans/i18n-multi-language.md.

interface I18nContextValue {
  locale: Locale;
  t: Messages;
  setLocale: (locale: Locale) => void;
}

// A working English default so useT() / useI18n() never throw when read outside a
// provider — isolated component tests and any stray render degrade to English
// rather than crashing (the norm for an i18n string hook). All real entry points
// (main app, launcher, settings) DO wrap in <I18nProvider>, which supplies the live
// locale + cross-window updates; the default's setLocale still persists via the
// bridge. So a forgotten provider shows English, never a blank screen.
const DEFAULT_CONTEXT: I18nContextValue = {
  locale: DEFAULT_LOCALE,
  t: DEFAULT_MESSAGES,
  setLocale: (next) => { void window.lin?.setLanguage?.(next); },
};

const I18nContext = createContext<I18nContextValue>(DEFAULT_CONTEXT);

export function I18nProvider({ children }: { children: React.ReactNode }) {
  // Seed synchronously from the value the preload injected (resolved by the main
  // process before first paint), so launch never flashes English before the chosen
  // language — the same before-first-paint discipline the theme uses.
  const [locale, setLocaleState] = useState<Locale>(() => window.lin?.initialLanguage ?? DEFAULT_LOCALE);

  const t = useMemo(() => getMessages(locale), [locale]);

  // Follow language changes pushed from any window — the picker lives in the
  // settings window, but the main window and launcher must update without a reload.
  useEffect(() => window.lin?.onLanguageChanged?.((next) => setLocaleState(next)), []);

  // Keep the document language attribute current for a11y and correct font shaping.
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next); // optimistic; the main-process broadcast confirms it
    void window.lin?.setLanguage?.(next);
  }, []);

  const value = useMemo<I18nContextValue>(() => ({ locale, t, setLocale }), [locale, t, setLocale]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  return useContext(I18nContext);
}

// Convenience for the common case — a component that only needs the strings.
export function useT(): Messages {
  return useI18n().t;
}
