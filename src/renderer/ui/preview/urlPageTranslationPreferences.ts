import { useSyncExternalStore } from 'react';
import type { UrlPageTranslationPreferences } from '../../../core/urlPageTranslation';

const DEFAULT_PREFERENCES: UrlPageTranslationPreferences = {
  translationModel: null,
  autoTranslateEpubs: false,
  autoTranslateUrls: false,
};

let currentPreferences: UrlPageTranslationPreferences | null = null;
let persistedPreferences: UrlPageTranslationPreferences | null = null;
let bridgeUnsubscribe: (() => void) | null = null;
const listeners = new Set<() => void>();
type PreferenceKey = keyof UrlPageTranslationPreferences;
type PendingPreference = { version: number; value: UrlPageTranslationPreferences[PreferenceKey] };
const pendingPreferences = new Map<PreferenceKey, PendingPreference>();
let nextMutationVersion = 0;
let writeTail: Promise<void> = Promise.resolve();

function initialPreferences(): UrlPageTranslationPreferences {
  if (currentPreferences) return currentPreferences;
  currentPreferences = typeof window === 'undefined'
    ? DEFAULT_PREFERENCES
    : window.lin?.initialUrlPageTranslationPreferences ?? DEFAULT_PREFERENCES;
  persistedPreferences = currentPreferences;
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
    bridgeUnsubscribe = window.lin?.onUrlPageTranslationPreferencesChanged?.((preferences) => {
      persistedPreferences = preferences;
      setCurrent(withPendingPreferences(preferences));
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

function snapshot(): UrlPageTranslationPreferences {
  return initialPreferences();
}

function withPendingPreferences(base: UrlPageTranslationPreferences): UrlPageTranslationPreferences {
  const next = { ...base };
  for (const [key, pending] of pendingPreferences) {
    (next as Record<PreferenceKey, UrlPageTranslationPreferences[PreferenceKey]>)[key] = pending.value;
  }
  return next;
}

function updatePreference<Key extends PreferenceKey>(
  key: Key,
  value: UrlPageTranslationPreferences[Key],
): Promise<void> {
  initialPreferences();
  const version = ++nextMutationVersion;
  pendingPreferences.set(key, { version, value });
  setCurrent({ ...initialPreferences(), [key]: value });

  const write = writeTail.then(async () => {
    const payload = { ...(persistedPreferences ?? initialPreferences()), [key]: value };
    try {
      const canonical = typeof window === 'undefined'
        ? payload
        : await window.lin?.setUrlPageTranslationPreferences?.(payload) ?? payload;
      persistedPreferences = canonical;
      if (pendingPreferences.get(key)?.version === version) pendingPreferences.delete(key);
      setCurrent(withPendingPreferences(canonical));
    } catch (error) {
      if (pendingPreferences.get(key)?.version === version) pendingPreferences.delete(key);
      setCurrent(withPendingPreferences(persistedPreferences ?? DEFAULT_PREFERENCES));
      throw error;
    }
  });
  writeTail = write.catch(() => undefined);
  return write;
}

export function useUrlPageTranslationPreferences(): UrlPageTranslationPreferences & {
  setAutoTranslateEpubs: (enabled: boolean) => Promise<void>;
  setAutoTranslateUrls: (enabled: boolean) => Promise<void>;
  setTranslationModel: (model: string | null) => Promise<void>;
} {
  const preferences = useSyncExternalStore(subscribe, snapshot, () => DEFAULT_PREFERENCES);
  return {
    ...preferences,
    setAutoTranslateEpubs,
    setAutoTranslateUrls,
    setTranslationModel,
  };
}

export function setAutoTranslateEpubs(enabled: boolean): Promise<void> {
  return updatePreference('autoTranslateEpubs', enabled);
}

export function setAutoTranslateUrls(enabled: boolean): Promise<void> {
  return updatePreference('autoTranslateUrls', enabled);
}

export function setTranslationModel(model: string | null): Promise<void> {
  return updatePreference('translationModel', model);
}

export function resetUrlPageTranslationPreferencesForTests(): void {
  currentPreferences = null;
  persistedPreferences = null;
  bridgeUnsubscribe?.();
  bridgeUnsubscribe = null;
  listeners.clear();
  pendingPreferences.clear();
  nextMutationVersion = 0;
  writeTail = Promise.resolve();
}
