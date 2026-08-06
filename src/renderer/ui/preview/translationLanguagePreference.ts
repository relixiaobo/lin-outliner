import { useSyncExternalStore } from 'react';
import { DEFAULT_LOCALE } from '../../../core/locale';
import type { TranslationLanguage } from '../../../core/translationLanguage';
import { createOptimisticPreferenceStore } from './optimisticPreferenceStore';

/**
 * One field, so that this preference gets the same optimistic-write contract as
 * its multi-field sibling instead of a second hand-written copy of it.
 */
interface TranslationLanguageState {
  language: TranslationLanguage;
}

const store = createOptimisticPreferenceStore<TranslationLanguageState>({
  fallback: { language: DEFAULT_LOCALE },
  initial: () => ({ language: window.lin?.initialTranslationLanguage ?? DEFAULT_LOCALE }),
  observe: (onChange) => window.lin?.onTranslationLanguageChanged?.((language) => onChange({ language })),
  // The bridge acknowledges without echoing a canonical value, so what was sent is
  // what was stored.
  write: async (state) => {
    await window.lin?.setTranslationLanguage?.(state.language);
    return state;
  },
});

export function useTranslationLanguagePreference(): {
  language: TranslationLanguage;
  setLanguage: (language: TranslationLanguage) => Promise<void>;
} {
  const { language } = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
  return { language, setLanguage: setTranslationLanguagePreference };
}

export function setTranslationLanguagePreference(language: TranslationLanguage): Promise<void> {
  return store.set('language', language);
}

export function resetTranslationLanguagePreferenceForTests(): void {
  store.resetForTests();
}
