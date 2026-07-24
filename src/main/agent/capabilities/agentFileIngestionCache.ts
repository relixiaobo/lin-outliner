import { setBoundedMapEntry } from '../../boundedMap';

type CacheOptionValue = string | number | boolean | null | undefined;

export class AgentDerivedFileCache {
  private readonly entries = new Map<string, unknown>();

  constructor(private readonly maxEntries = 64) {}

  get<T>(key: string): T | undefined {
    if (!this.entries.has(key)) return undefined;
    const value = this.entries.get(key);
    this.entries.delete(key);
    this.entries.set(key, value);
    return cloneCacheValue(value) as T;
  }

  set<T>(key: string, value: T): void {
    setBoundedMapEntry(this.entries, key, cloneCacheValue(value), this.maxEntries);
  }

  clear(): void {
    this.entries.clear();
  }
}

export const agentDerivedFileCache = new AgentDerivedFileCache();

export function derivedFileCacheKey(
  extractor: string,
  sourceHash: string,
  options: Record<string, CacheOptionValue>,
): string {
  const normalizedOptions = Object.fromEntries(
    Object.entries(options)
      .filter(([, value]) => value !== undefined)
      .sort(([left], [right]) => left.localeCompare(right)),
  );
  return JSON.stringify({ extractor, sourceHash, options: normalizedOptions });
}

function cloneCacheValue<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  return structuredClone(value);
}
