import { useSyncExternalStore } from 'react';
import type { UrlPageTranslationPreferences } from '../../../core/urlPageTranslation';

const DEFAULT_PREFERENCES: UrlPageTranslationPreferences = {
  translationModel: null,
  autoTranslateEpubs: false,
  autoTranslateUrls: false,
};

let currentPreferences: UrlPageTranslationPreferences | null = null;
let bridgeUnsubscribe: (() => void) | null = null;
const listeners = new Set<() => void>();

function initialPreferences(): UrlPageTranslationPreferences {
  if (currentPreferences) return currentPreferences;
  currentPreferences = typeof window === 'undefined'
    ? DEFAULT_PREFERENCES
    : window.lin?.initialUrlPageTranslationPreferences ?? DEFAULT_PREFERENCES;
  return currentPreferences;
}

function emit(): void {
  for (const listener of listeners) listener();
}

function setCurrent(preferences: UrlPageTranslationPreferences): void {
  const current = initialPreferences();
  if (
    current.translationModel === preferences.translationModel
    && current.autoTranslateEpubs === preferences.autoTranslateEpubs
    && current.autoTranslateUrls === preferences.autoTranslateUrls
  ) return;
  currentPreferences = preferences;
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!bridgeUnsubscribe && typeof window !== 'undefined') {
    bridgeUnsubscribe = window.lin?.onUrlPageTranslationPreferencesChanged?.(setCurrent) ?? null;
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && bridgeUnsubscribe) {
      bridgeUnsubscribe();
      bridgeUnsubscribe = null;
    }
  };
}

function snapshot(): UrlPageTranslationPreferences {
  return initialPreferences();
}

function updatePreferences(patch: Partial<UrlPageTranslationPreferences>): void {
  const next = { ...initialPreferences(), ...patch };
  setCurrent(next);
  if (typeof window !== 'undefined') {
    const saving = window.lin?.setUrlPageTranslationPreferences?.(next);
    void saving?.then(setCurrent).catch(() => undefined);
  }
}

export function useUrlPageTranslationPreferences(): UrlPageTranslationPreferences & {
  setAutoTranslateEpubs: (enabled: boolean) => void;
  setAutoTranslateUrls: (enabled: boolean) => void;
  setTranslationModel: (model: string | null) => void;
} {
  const preferences = useSyncExternalStore(subscribe, snapshot, () => DEFAULT_PREFERENCES);
  return {
    ...preferences,
    setAutoTranslateEpubs,
    setAutoTranslateUrls,
    setTranslationModel,
  };
}

export function setAutoTranslateEpubs(enabled: boolean): void {
  updatePreferences({ autoTranslateEpubs: enabled });
}

export function setAutoTranslateUrls(enabled: boolean): void {
  updatePreferences({ autoTranslateUrls: enabled });
}

export function setTranslationModel(model: string | null): void {
  updatePreferences({ translationModel: model });
}

export function resetUrlPageTranslationPreferencesForTests(): void {
  currentPreferences = null;
  bridgeUnsubscribe?.();
  bridgeUnsubscribe = null;
  listeners.clear();
}
