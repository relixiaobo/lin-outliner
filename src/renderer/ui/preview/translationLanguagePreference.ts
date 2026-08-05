import { useSyncExternalStore } from 'react';
import { DEFAULT_LOCALE } from '../../../core/locale';
import type { TranslationLanguage } from '../../../core/translationLanguage';

let currentLanguage: TranslationLanguage | null = null;
let persistedLanguage: TranslationLanguage | null = null;
let bridgeUnsubscribe: (() => void) | null = null;
const listeners = new Set<() => void>();
let nextMutationVersion = 0;
let latestPending: { version: number; language: TranslationLanguage } | null = null;
let writeTail: Promise<void> = Promise.resolve();

function initialLanguage(): TranslationLanguage {
  if (currentLanguage) return currentLanguage;
  currentLanguage = typeof window === 'undefined'
    ? DEFAULT_LOCALE
    : window.lin?.initialTranslationLanguage ?? DEFAULT_LOCALE;
  persistedLanguage = currentLanguage;
  return currentLanguage;
}

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!bridgeUnsubscribe && typeof window !== 'undefined') {
    bridgeUnsubscribe = window.lin?.onTranslationLanguageChanged?.((language) => {
      persistedLanguage = language;
      setCurrentLanguage(latestPending?.language ?? language);
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
  setLanguage: (language: TranslationLanguage) => Promise<void>;
} {
  const language = useSyncExternalStore(subscribe, snapshot, () => DEFAULT_LOCALE);
  return { language, setLanguage: setTranslationLanguagePreference };
}

export function setTranslationLanguagePreference(language: TranslationLanguage): Promise<void> {
  initialLanguage();
  const version = ++nextMutationVersion;
  latestPending = { version, language };
  setCurrentLanguage(language);

  const write = writeTail.then(async () => {
    try {
      if (typeof window !== 'undefined') {
        await window.lin?.setTranslationLanguage?.(language);
      }
      persistedLanguage = language;
      if (latestPending?.version === version) {
        latestPending = null;
        setCurrentLanguage(language);
      }
    } catch (error) {
      if (latestPending?.version === version) {
        latestPending = null;
        setCurrentLanguage(persistedLanguage ?? initialLanguage());
      }
      throw error;
    }
  });
  writeTail = write.catch(() => undefined);
  return write;
}

function setCurrentLanguage(language: TranslationLanguage): void {
  if (currentLanguage === language) return;
  currentLanguage = language;
  emit();
}

/**
 * Drop the module-level cache. The seeded language is read once and kept, so a
 * test that renders under one bridge leaves it set for whatever renders next —
 * the sibling preference store already needed this for the same reason.
 */
export function resetTranslationLanguagePreferenceForTests(): void {
  currentLanguage = null;
  persistedLanguage = null;
  bridgeUnsubscribe?.();
  bridgeUnsubscribe = null;
  listeners.clear();
  nextMutationVersion = 0;
  latestPending = null;
  writeTail = Promise.resolve();
}
