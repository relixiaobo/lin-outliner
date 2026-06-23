import { createHash } from 'node:crypto';

type CacheOptionValue = string | number | boolean | null | undefined;

export class AgentDerivedFileCache {
  private readonly entries = new Map<string, unknown>();

  constructor(private readonly maxEntries = 64) {}

  get<T>(key: string): T | undefined {
    if (!this.entries.has(key)) return undefined;
    const value = this.entries.get(key) as T;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set<T>(key: string, value: T): void {
    if (this.entries.has(key)) this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}

export const agentDerivedFileCache = new AgentDerivedFileCache();

export function sha256Buffer(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

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
