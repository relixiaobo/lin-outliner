import { isRecord } from './persistence';

export function localStorageOrNull(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readLocalStorageKeyedStore<T>(options: {
  decodeEntry: (value: unknown) => T | null;
  entriesKey: string;
  storage: Storage;
  storageKey: string;
  version: number;
}): Record<string, T> {
  try {
    const raw = options.storage.getItem(options.storageKey);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || parsed.version !== options.version) return {};
    const entries = parsed[options.entriesKey];
    if (!isRecord(entries)) return {};
    const result: Record<string, T> = {};
    for (const [key, value] of Object.entries(entries)) {
      const entry = options.decodeEntry(value);
      if (entry) result[key] = entry;
    }
    return result;
  } catch {
    return {};
  }
}

export function writeLocalStorageKeyedStore<T>(options: {
  entries: Record<string, T>;
  entriesKey: string;
  storage: Storage;
  storageKey: string;
  version: number;
}): void {
  try {
    options.storage.setItem(options.storageKey, JSON.stringify({
      version: options.version,
      [options.entriesKey]: options.entries,
    }));
  } catch {
    // Best-effort renderer-local state.
  }
}

export function pruneLocalStorageEntries<T>(
  entries: Record<string, T>,
  maxEntries: number,
  updatedAt: (entry: T) => number,
): void {
  const allEntries = Object.entries(entries);
  if (allEntries.length <= maxEntries) return;
  const staleEntries = allEntries
    .sort(([, left], [, right]) => updatedAt(right) - updatedAt(left))
    .slice(maxEntries);
  for (const [key] of staleEntries) {
    delete entries[key];
  }
}
