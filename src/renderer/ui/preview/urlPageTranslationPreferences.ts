import { useSyncExternalStore } from 'react';
import type { UrlPageTranslationPreferences } from '../../../core/urlPageTranslation';
import { createOptimisticPreferenceStore } from './optimisticPreferenceStore';

const DEFAULT_PREFERENCES: UrlPageTranslationPreferences = {
  translationModel: null,
  autoTranslateEpubs: false,
  autoTranslateUrls: false,
};

const store = createOptimisticPreferenceStore<UrlPageTranslationPreferences>({
  fallback: DEFAULT_PREFERENCES,
  initial: () => window.lin?.initialUrlPageTranslationPreferences ?? DEFAULT_PREFERENCES,
  observe: (onChange) => window.lin?.onUrlPageTranslationPreferencesChanged?.(onChange),
  // Main normalizes, so what it stored is authoritative over what we sent.
  write: async (preferences) => await window.lin?.setUrlPageTranslationPreferences?.(preferences) ?? preferences,
});

export function useUrlPageTranslationPreferences(): UrlPageTranslationPreferences & {
  setAutoTranslateEpubs: (enabled: boolean) => Promise<void>;
  setAutoTranslateUrls: (enabled: boolean) => Promise<void>;
  setTranslationModel: (model: string | null) => Promise<void>;
} {
  const preferences = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
  return {
    ...preferences,
    setAutoTranslateEpubs,
    setAutoTranslateUrls,
    setTranslationModel,
  };
}

export function setAutoTranslateEpubs(enabled: boolean): Promise<void> {
  return store.set('autoTranslateEpubs', enabled);
}

export function setAutoTranslateUrls(enabled: boolean): Promise<void> {
  return store.set('autoTranslateUrls', enabled);
}

export function setTranslationModel(model: string | null): Promise<void> {
  return store.set('translationModel', model);
}

export function resetUrlPageTranslationPreferencesForTests(): void {
  store.resetForTests();
}
