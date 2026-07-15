import { useSyncExternalStore } from 'react';
import { DEFAULT_LOCALE } from '../../../core/locale';
import type { TranslationLanguage } from '../../../core/translationLanguage';

let currentLanguage: TranslationLanguage | null = null;
let bridgeUnsubscribe: (() => void) | null = null;
const listeners = new Set<() => void>();

function initialLanguage(): TranslationLanguage {
  if (currentLanguage) return currentLanguage;
  currentLanguage = typeof window === 'undefined'
    ? DEFAULT_LOCALE
    : window.lin?.initialTranslationLanguage ?? DEFAULT_LOCALE;
  return currentLanguage;
}

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!bridgeUnsubscribe && typeof window !== 'undefined') {
    bridgeUnsubscribe = window.lin?.onTranslationLanguageChanged?.((language) => {
      if (currentLanguage === language) return;
      currentLanguage = language;
      emit();
    }) ?? null;
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && bridgeUnsubscribe) {
      bridgeUnsubscribe();
      bridgeUnsubscribe = null;
    }
  };
}

function snapshot(): TranslationLanguage {
  return initialLanguage();
}

export function useTranslationLanguagePreference(): {
  language: TranslationLanguage;
  setLanguage: (language: TranslationLanguage) => void;
} {
  const language = useSyncExternalStore(subscribe, snapshot, () => DEFAULT_LOCALE);
  return { language, setLanguage: setTranslationLanguagePreference };
}

export function setTranslationLanguagePreference(language: TranslationLanguage): void {
  if (currentLanguage !== language) {
    currentLanguage = language;
    emit();
  }
  if (typeof window !== 'undefined') {
    void window.lin?.setTranslationLanguage?.(language);
  }
}
