import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile, rename, rm } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import type { TranslationLanguage } from '../core/translationLanguage';
import {
  URL_PAGE_TRANSLATION_MAX_TRANSLATION_CHARS,
  type UrlPageTranslationContentKind,
  type UrlPageTranslationItem,
} from '../core/urlPageTranslation';
import { PRIVATE_JSON_FILE_OPTIONS, writeJsonFile } from './jsonFileStore';

const CACHE_DIRECTORY_VERSION = 2;
const CACHE_INDEX_FILE = 'index.json';
const CACHE_SHARD_SUFFIX = '.json';
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;

export const PREVIEW_TRANSLATION_CACHE_MAX_BYTES = 64 * 1024 * 1024;
export const PREVIEW_TRANSLATION_CACHE_MAX_ENTRIES = 50_000;
export const PREVIEW_TRANSLATION_CACHE_MAX_SHARD_BYTES = 4 * 1024 * 1024;
export const PREVIEW_TRANSLATION_CACHE_MAX_SHARD_ENTRIES = 4_000;

export interface PreviewTranslationCacheScope {
  contentKind: UrlPageTranslationContentKind;
  modelIdentity: string;
  promptRevision: number;
  sourceId: string;
  targetLanguage: TranslationLanguage;
}

export interface PreviewTranslationCacheBlock {
  cacheKey: string;
  id: string;
  text: string;
}

export interface PreviewTranslationCacheLookup {
  epoch: number;
  hits: UrlPageTranslationItem[];
}

export type PreviewTranslationCacheOperation = 'clear' | 'load' | 'write';

export interface PreviewTranslationCacheStoreOptions {
  flushDelayMs?: number;
  maxBytes?: number;
  maxEntries?: number;
  maxHotShards?: number;
  maxShardBytes?: number;
  maxShardEntries?: number;
  now?: () => number;
  onError?: (operation: PreviewTranslationCacheOperation) => void;
}

interface PersistedTranslatedCacheEntry {
  accessedAt: number;
  kind: 'translated';
  translation: string;
}

interface PersistedUnchangedCacheEntry {
  accessedAt: number;
  kind: 'unchanged';
}

type PersistedCacheEntry = PersistedTranslatedCacheEntry | PersistedUnchangedCacheEntry;

interface PersistedCacheShard {
  version: 2;
  entries: Record<string, PersistedCacheEntry>;
}

interface CacheManifestEntry {
  bytes: number;
  entries: number;
  oldestAccessedAt: number;
}

interface PersistedCacheManifest {
  version: 2;
  scopes: Record<string, CacheManifestEntry>;
}

interface CacheShard {
  entries: Map<string, PersistedCacheEntry>;
  logicalBytes: number;
}

interface ParsedShard {
  dirty: boolean;
  shard: CacheShard;
}

export class PreviewTranslationCacheStore {
  private readonly flushDelayMs: number;
  private readonly maxBytes: number;
  private readonly maxEntries: number;
  private readonly maxHotShards: number;
  private readonly maxShardBytes: number;
  private readonly maxShardEntries: number;
  private readonly now: () => number;
  private readonly onError?: (operation: PreviewTranslationCacheOperation) => void;
  private readonly hotShards = new Map<string, CacheShard>();
  private readonly dirtyScopes = new Set<string>();
  private readonly manifest = new Map<string, CacheManifestEntry>();
  private operationQueue: Promise<void> = Promise.resolve();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private initialized = false;
  private manifestDirty = false;
  private epoch = 0;

  constructor(
    private readonly rootDir: string,
    options: PreviewTranslationCacheStoreOptions = {},
  ) {
    this.flushDelayMs = options.flushDelayMs ?? 1_500;
    this.maxBytes = Math.max(1, Math.floor(options.maxBytes ?? PREVIEW_TRANSLATION_CACHE_MAX_BYTES));
    this.maxEntries = Math.max(1, Math.floor(options.maxEntries ?? PREVIEW_TRANSLATION_CACHE_MAX_ENTRIES));
    this.maxHotShards = Math.max(1, Math.floor(options.maxHotShards ?? 12));
    this.maxShardBytes = Math.min(
      this.maxBytes,
      Math.max(1, Math.floor(options.maxShardBytes ?? PREVIEW_TRANSLATION_CACHE_MAX_SHARD_BYTES)),
    );
    this.maxShardEntries = Math.min(
      this.maxEntries,
      Math.max(1, Math.floor(options.maxShardEntries ?? PREVIEW_TRANSLATION_CACHE_MAX_SHARD_ENTRIES)),
    );
    this.now = options.now ?? Date.now;
    this.onError = options.onError;
  }

  lookup(
    scope: PreviewTranslationCacheScope,
    blocks: readonly PreviewTranslationCacheBlock[],
  ): Promise<PreviewTranslationCacheLookup> {
    return this.enqueue(async () => {
      await this.ensureInitialized();
      const scopeDigest = cacheScopeDigest(scope);
      const shard = await this.loadShard(scopeDigest);
      const accessedAt = this.now();
      const hits: UrlPageTranslationItem[] = [];
      for (const block of blocks) {
        const entry = shard.entries.get(cacheBlockDigest(block));
        if (!entry) continue;
        entry.accessedAt = accessedAt;
        hits.push({
          id: block.id,
          translation: entry.kind === 'unchanged' ? block.text : entry.translation,
        });
      }
      if (hits.length > 0) {
        this.touchHotShard(scopeDigest, shard);
        this.dirtyScopes.add(scopeDigest);
        this.scheduleFlush();
      }
      return { epoch: this.epoch, hits };
    });
  }

  record(
    scope: PreviewTranslationCacheScope,
    blocks: readonly PreviewTranslationCacheBlock[],
    translations: readonly UrlPageTranslationItem[],
    epoch: number,
  ): Promise<boolean> {
    return this.enqueue(async () => {
      await this.ensureInitialized();
      if (epoch !== this.epoch) return false;
      const translationsById = new Map(translations.map((item) => [item.id, item.translation]));
      const scopeDigest = cacheScopeDigest(scope);
      const shard = await this.loadShard(scopeDigest);
      const accessedAt = this.now();
      let changed = false;
      for (const block of blocks) {
        const translation = normalizedTranslation(translationsById.get(block.id));
        if (!translation) continue;
        const digest = cacheBlockDigest(block);
        const previous = shard.entries.get(digest);
        const next: PersistedCacheEntry = translation === block.text
          ? { accessedAt, kind: 'unchanged' }
          : { accessedAt, kind: 'translated', translation };
        if (!previous || !cacheEntryEquals(previous, next)) {
          shard.entries.set(digest, next);
          changed = true;
        }
      }
      if (!changed) return false;
      shard.logicalBytes = shardLogicalBytes(shard.entries);
      this.touchHotShard(scopeDigest, shard);
      this.dirtyScopes.add(scopeDigest);
      this.scheduleFlush();
      return true;
    });
  }

  flushNow(): Promise<void> {
    this.clearFlushTimer();
    return this.enqueue(async () => {
      await this.ensureInitialized();
      await this.flushInternal();
    });
  }

  clear(): Promise<void> {
    this.clearFlushTimer();
    return this.enqueue(async () => {
      await this.removeStaleClearTombstones();
      const tombstone = path.join(
        path.dirname(this.rootDir),
        `.${path.basename(this.rootDir)}.clearing-${randomUUID()}`,
      );
      let renamed = false;
      try {
        await rename(this.rootDir, tombstone);
        renamed = true;
      } catch (error) {
        if (!isNotFoundError(error)) {
          this.onError?.('clear');
          throw error;
        }
      }

      if (renamed) {
        try {
          await rm(tombstone, { force: true, recursive: true });
        } catch (error) {
          try {
            await rename(tombstone, this.rootDir);
          } catch {
            // The clear still reports failure; the cache remains disposable if rollback also fails.
          }
          this.onError?.('clear');
          throw error;
        }
      }

      this.epoch += 1;
      this.hotShards.clear();
      this.dirtyScopes.clear();
      this.manifest.clear();
      this.manifestDirty = false;
      this.initialized = true;
    });
  }

  private async removeStaleClearTombstones(): Promise<void> {
    const parent = path.dirname(this.rootDir);
    const prefix = `.${path.basename(this.rootDir)}.clearing-`;
    let entries: Dirent[];
    try {
      entries = await readdir(parent, { withFileTypes: true });
    } catch (error) {
      if (isNotFoundError(error)) return;
      this.onError?.('clear');
      throw error;
    }
    try {
      await Promise.all(entries
        .filter((entry) => entry.name.startsWith(prefix))
        .map((entry) => rm(path.join(parent, entry.name), { force: true, recursive: true })));
    } catch (error) {
      this.onError?.('clear');
      throw error;
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation, operation);
    this.operationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    try {
      const parsed = parseManifest(JSON.parse(await readFile(this.indexPath(), 'utf8')) as unknown);
      for (const [scope, metadata] of parsed) this.manifest.set(scope, metadata);
    } catch (error) {
      if (!isNotFoundError(error)) {
        this.onError?.('load');
        await rm(this.rootDir, { force: true, recursive: true }).catch(() => undefined);
      }
    }
    await this.reconcileShardDirectory();
    this.initialized = true;
    if (this.manifestDirty) this.scheduleFlush();
  }

  private async reconcileShardDirectory(): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(this.rootDir, { withFileTypes: true });
    } catch (error) {
      if (isNotFoundError(error)) return;
      this.onError?.('load');
      return;
    }
    const diskScopes = new Set<string>();
    for (const entry of entries) {
      if (entry.name === CACHE_INDEX_FILE) continue;
      const scope = entry.name.slice(0, -CACHE_SHARD_SUFFIX.length);
      const validIndexedShard = entry.isFile()
        && entry.name.endsWith(CACHE_SHARD_SUFFIX)
        && DIGEST_PATTERN.test(scope)
        && this.manifest.has(scope);
      if (validIndexedShard) {
        diskScopes.add(scope);
        continue;
      }
      try {
        await rm(path.join(this.rootDir, entry.name), { force: true, recursive: true });
      } catch {
        this.onError?.('load');
      }
    }
    for (const scope of this.manifest.keys()) {
      if (diskScopes.has(scope)) continue;
      this.manifest.delete(scope);
      this.manifestDirty = true;
    }
  }

  private async loadShard(scope: string): Promise<CacheShard> {
    const cached = this.hotShards.get(scope);
    if (cached) {
      this.touchHotShard(scope, cached);
      return cached;
    }

    let parsed: ParsedShard | null = null;
    try {
      parsed = parseShard(JSON.parse(await readFile(this.shardPath(scope), 'utf8')) as unknown);
    } catch (error) {
      if (isNotFoundError(error)) {
        if (this.manifest.delete(scope)) this.manifestDirty = true;
      } else {
        this.onError?.('load');
        await rm(this.shardPath(scope), { force: true }).catch(() => undefined);
        this.manifest.delete(scope);
        this.manifestDirty = true;
      }
    }
    const shard = parsed?.shard ?? emptyShard();
    if (parsed) {
      const previousSize = shard.entries.size;
      const previousBytes = shard.logicalBytes;
      compactShard(shard, this.maxShardEntries, this.maxShardBytes);
      if (shard.entries.size !== previousSize || shard.logicalBytes !== previousBytes) parsed.dirty = true;
      const metadata = this.manifest.get(scope);
      const nextMetadata = cacheShardMetadata(shard);
      if (!nextMetadata) {
        if (this.manifest.delete(scope)) this.manifestDirty = true;
      } else if (!metadata || !cacheManifestEntryEquals(metadata, nextMetadata)) {
        this.manifest.set(scope, nextMetadata);
        this.manifestDirty = true;
      }
    }
    this.touchHotShard(scope, shard);
    if (parsed?.dirty) this.dirtyScopes.add(scope);
    if (parsed?.dirty || this.manifestDirty) this.scheduleFlush();
    this.evictCleanHotShards(scope);
    return shard;
  }

  private touchHotShard(scope: string, shard: CacheShard): void {
    this.hotShards.delete(scope);
    this.hotShards.set(scope, shard);
  }

  private evictCleanHotShards(protectedScope?: string): void {
    if (this.hotShards.size <= this.maxHotShards) return;
    for (const scope of this.hotShards.keys()) {
      if (this.hotShards.size <= this.maxHotShards) break;
      if (scope === protectedScope || this.dirtyScopes.has(scope)) continue;
      this.hotShards.delete(scope);
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flushNow().catch(() => undefined);
    }, this.flushDelayMs);
    this.flushTimer.unref?.();
  }

  private clearFlushTimer(): void {
    if (!this.flushTimer) return;
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
  }

  private async flushInternal(): Promise<void> {
    if (this.dirtyScopes.size === 0 && !this.manifestDirty) return;

    for (const scope of this.dirtyScopes) {
      const shard = this.hotShards.get(scope);
      if (!shard) continue;
      compactShard(shard, this.maxShardEntries, this.maxShardBytes);
      const metadata = cacheShardMetadata(shard);
      if (metadata) this.manifest.set(scope, metadata);
      else this.manifest.delete(scope);
      await yieldToEventLoop();
    }

    const removedScopes = await this.compactForGlobalCapacity();
    const payloads = new Map<string, PersistedCacheShard>();
    for (const scope of this.dirtyScopes) {
      const shard = this.hotShards.get(scope);
      if (!shard || !this.manifest.has(scope) || shard.entries.size === 0) {
        removedScopes.add(scope);
        continue;
      }
      payloads.set(scope, serializeShard(shard));
      await yieldToEventLoop();
    }

    try {
      for (const [scope, payload] of payloads) {
        await writeJsonFile(this.shardPath(scope), payload, {
          ...PRIVATE_JSON_FILE_OPTIONS,
          pretty: false,
          trailingNewline: false,
        });
      }
      await writeJsonFile(this.indexPath(), serializeManifest(this.manifest), {
        ...PRIVATE_JSON_FILE_OPTIONS,
        pretty: false,
        trailingNewline: false,
      });
      for (const scope of removedScopes) {
        await rm(this.shardPath(scope), { force: true }).catch(() => undefined);
      }
    } catch (error) {
      this.onError?.('write');
      throw error;
    }

    for (const scope of payloads.keys()) this.dirtyScopes.delete(scope);
    for (const scope of removedScopes) {
      this.dirtyScopes.delete(scope);
      this.hotShards.delete(scope);
    }
    this.manifestDirty = false;
    this.evictCleanHotShards();
  }

  private async compactForGlobalCapacity(): Promise<Set<string>> {
    const removedScopes = new Set<string>();
    while (true) {
      let { totalBytes, totalEntries } = cacheManifestTotals(this.manifest);
      if (totalBytes <= this.maxBytes && totalEntries <= this.maxEntries) return removedScopes;

      const oldestScopes = sortedCacheScopes(this.manifest);
      const selected = oldestScopes[0];
      if (!selected) return removedScopes;
      const [scope] = selected;
      const shard = await this.loadShard(scope);

      const refreshedScopes = sortedCacheScopes(this.manifest);
      if (refreshedScopes[0]?.[0] !== scope) continue;
      ({ totalBytes, totalEntries } = cacheManifestTotals(this.manifest));
      const nextScope = refreshedScopes[1];
      const oldestEntries = sortedCacheEntries(shard.entries);
      let removed = 0;
      for (const [digest, entry] of oldestEntries) {
        if (
          removed > 0
          && nextScope
          && !cacheEntryPrecedesScope(entry, scope, nextScope[0], nextScope[1])
        ) break;
        shard.entries.delete(digest);
        const bytes = cacheEntryLogicalBytes(digest, entry);
        shard.logicalBytes -= bytes;
        totalBytes -= bytes;
        totalEntries -= 1;
        removed += 1;
        if (totalBytes <= this.maxBytes && totalEntries <= this.maxEntries) break;
      }
      if (removed === 0) {
        this.manifest.delete(scope);
        removedScopes.add(scope);
      } else {
        const metadata = cacheShardMetadata(shard);
        if (metadata) this.manifest.set(scope, metadata);
        else {
          this.manifest.delete(scope);
          removedScopes.add(scope);
        }
        this.dirtyScopes.add(scope);
      }
      this.manifestDirty = true;
      await yieldToEventLoop();
    }
  }

  private shardPath(scope: string): string {
    return path.join(this.rootDir, `${scope}${CACHE_SHARD_SUFFIX}`);
  }

  private indexPath(): string {
    return path.join(this.rootDir, CACHE_INDEX_FILE);
  }
}

function cacheScopeDigest(scope: PreviewTranslationCacheScope): string {
  return digestJson([
    CACHE_DIRECTORY_VERSION,
    scope.promptRevision,
    scope.sourceId,
    scope.targetLanguage,
    scope.contentKind,
    scope.modelIdentity,
  ]);
}

function cacheBlockDigest(block: PreviewTranslationCacheBlock): string {
  return digestJson([CACHE_DIRECTORY_VERSION, block.cacheKey, block.text]);
}

function digestJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function normalizedTranslation(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const translation = value.trim();
  return translation && translation.length <= URL_PAGE_TRANSLATION_MAX_TRANSLATION_CHARS
    ? translation
    : null;
}

function emptyShard(): CacheShard {
  return { entries: new Map(), logicalBytes: 0 };
}

function parseManifest(value: unknown): Map<string, CacheManifestEntry> {
  if (!isRecord(value) || value.version !== CACHE_DIRECTORY_VERSION || !isRecord(value.scopes)) {
    throw new Error('Invalid preview translation cache index.');
  }
  const result = new Map<string, CacheManifestEntry>();
  for (const [scope, raw] of Object.entries(value.scopes)) {
    if (!DIGEST_PATTERN.test(scope) || !isRecord(raw)) continue;
    const bytes = finiteNonNegative(raw.bytes);
    const entries = finiteNonNegativeInteger(raw.entries);
    const oldestAccessedAt = finiteNonNegative(raw.oldestAccessedAt);
    if (bytes === null || entries === null || oldestAccessedAt === null || entries === 0) continue;
    result.set(scope, { bytes, entries, oldestAccessedAt });
  }
  return result;
}

function parseShard(value: unknown): ParsedShard {
  if (!isRecord(value) || value.version !== CACHE_DIRECTORY_VERSION || !isRecord(value.entries)) {
    throw new Error('Invalid preview translation cache shard.');
  }
  const entries = new Map<string, PersistedCacheEntry>();
  let dirty = false;
  for (const [digest, raw] of Object.entries(value.entries)) {
    if (!DIGEST_PATTERN.test(digest) || !isRecord(raw)) {
      dirty = true;
      continue;
    }
    const entryAccessedAt = finiteNonNegative(raw.accessedAt);
    if (entryAccessedAt === null) {
      dirty = true;
      continue;
    }
    if (raw.kind === 'unchanged') {
      if ('translation' in raw) {
        dirty = true;
        continue;
      }
      entries.set(digest, { accessedAt: entryAccessedAt, kind: 'unchanged' });
      continue;
    }
    const translation = raw.kind === 'translated'
      ? normalizedTranslation(raw.translation)
      : null;
    if (!translation) {
      dirty = true;
      continue;
    }
    entries.set(digest, { accessedAt: entryAccessedAt, kind: 'translated', translation });
  }
  return {
    dirty,
    shard: { entries, logicalBytes: shardLogicalBytes(entries) },
  };
}

function serializeManifest(manifest: ReadonlyMap<string, CacheManifestEntry>): PersistedCacheManifest {
  const scopes: Record<string, CacheManifestEntry> = {};
  for (const [scope, metadata] of manifest) scopes[scope] = metadata;
  return { version: CACHE_DIRECTORY_VERSION, scopes };
}

function serializeShard(shard: CacheShard): PersistedCacheShard {
  const entries: Record<string, PersistedCacheEntry> = {};
  for (const [digest, entry] of shard.entries) entries[digest] = entry;
  return { version: CACHE_DIRECTORY_VERSION, entries };
}

function compactShard(shard: CacheShard, maxEntries: number, maxBytes: number): void {
  if (shard.entries.size <= maxEntries && shard.logicalBytes <= maxBytes) return;
  const oldest = sortedCacheEntries(shard.entries);
  for (const [digest] of oldest) {
    if (shard.entries.size <= maxEntries && shard.logicalBytes <= maxBytes) break;
    const entry = shard.entries.get(digest);
    if (!entry) continue;
    shard.entries.delete(digest);
    shard.logicalBytes -= cacheEntryLogicalBytes(digest, entry);
  }
}

function cacheShardMetadata(shard: CacheShard): CacheManifestEntry | null {
  if (shard.entries.size === 0) return null;
  let oldestAccessedAt = Number.POSITIVE_INFINITY;
  for (const entry of shard.entries.values()) {
    oldestAccessedAt = Math.min(oldestAccessedAt, entry.accessedAt);
  }
  return {
    bytes: shard.logicalBytes,
    entries: shard.entries.size,
    oldestAccessedAt,
  };
}

function cacheManifestEntryEquals(left: CacheManifestEntry, right: CacheManifestEntry): boolean {
  return left.bytes === right.bytes
    && left.entries === right.entries
    && left.oldestAccessedAt === right.oldestAccessedAt;
}

function cacheEntryEquals(left: PersistedCacheEntry, right: PersistedCacheEntry): boolean {
  return left.accessedAt === right.accessedAt
    && left.kind === right.kind
    && (left.kind === 'unchanged' || (
      right.kind === 'translated'
      && left.translation === right.translation
    ));
}

function cacheManifestTotals(manifest: ReadonlyMap<string, CacheManifestEntry>): {
  totalBytes: number;
  totalEntries: number;
} {
  let totalBytes = 0;
  let totalEntries = 0;
  for (const metadata of manifest.values()) {
    totalBytes += metadata.bytes;
    totalEntries += metadata.entries;
  }
  return { totalBytes, totalEntries };
}

function sortedCacheScopes(
  manifest: ReadonlyMap<string, CacheManifestEntry>,
): Array<[string, CacheManifestEntry]> {
  return [...manifest.entries()].sort((left, right) => (
    left[1].oldestAccessedAt - right[1].oldestAccessedAt || left[0].localeCompare(right[0])
  ));
}

function sortedCacheEntries(
  entries: ReadonlyMap<string, PersistedCacheEntry>,
): Array<[string, PersistedCacheEntry]> {
  return [...entries.entries()].sort((left, right) => (
    left[1].accessedAt - right[1].accessedAt || left[0].localeCompare(right[0])
  ));
}

function cacheEntryPrecedesScope(
  entry: PersistedCacheEntry,
  scope: string,
  nextScope: string,
  nextMetadata: CacheManifestEntry,
): boolean {
  return entry.accessedAt < nextMetadata.oldestAccessedAt
    || (entry.accessedAt === nextMetadata.oldestAccessedAt && scope.localeCompare(nextScope) <= 0);
}

function shardLogicalBytes(entries: ReadonlyMap<string, PersistedCacheEntry>): number {
  let bytes = 0;
  for (const [digest, entry] of entries) bytes += cacheEntryLogicalBytes(digest, entry);
  return bytes;
}

function cacheEntryLogicalBytes(digest: string, entry: PersistedCacheEntry): number {
  return Buffer.byteLength(digest)
    + (entry.kind === 'translated' ? Buffer.byteLength(entry.translation) : 0)
    + 32;
}

function finiteNonNegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function finiteNonNegativeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNotFoundError(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
